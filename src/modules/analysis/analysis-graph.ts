import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { analysisGraphStateSchema, analysisNodeResultSchema, analysisNodeSchema } from '../../contracts/analysis-graph.js';
import type { AnalysisGraphState, AnalysisNode, AnalysisNodeResult } from '../../contracts/analysis-graph.js';
import { realAnalysisInputSchema } from '../../contracts/tasks.js';
import type { UsageReservation } from '../../contracts/tasks.js';
import type { ExecutionClaim } from '../../infrastructure/consumer/contracts.js';
import type { AnalysisArtifactRepository } from '../../infrastructure/tasks/analysis-artifact.repository.js';
import { createCheckpointStore } from '../../infrastructure/checkpoint/store.js';
import type { CheckpointConfig } from '../../infrastructure/checkpoint/config.js';
import { TaskFailure } from '../../infrastructure/consumer/failure.js';
import { requestHash } from '../tasks/request-hash.js';

export type AnalysisGraphNodes = Record<AnalysisNode, (state: AnalysisGraphState, context: {
  claim: ExecutionClaim; signal: AbortSignal; budget: { reserve: (usage: UsageReservation) => Promise<void> };
}) => Promise<AnalysisNodeResult>>;
const dependencies: Record<AnalysisNode, AnalysisNode[]> = {
  LOAD: [], PARSE: ['LOAD'], EXTRACT: ['PARSE'], VALIDATE: ['EXTRACT'], PROFILE: ['VALIDATE'],
  RECALL: ['VALIDATE'], SNAP: ['RECALL'], MATCH: ['SNAP'], SCORE: ['MATCH'], RANK: ['SCORE'], JOIN: ['PROFILE', 'RANK'], FINALIZE: ['JOIN'],
};

export function mergeAnalysisOutputs(left: AnalysisGraphState['outputs'], right: AnalysisGraphState['outputs']) {
  const merged = { ...left };
  for (const node of Object.keys(dependencies) as AnalysisNode[]) {
    const value = right[node]; if (!value) continue;
    const parsed = analysisNodeResultSchema.parse(value);
    if (merged[node] && requestHash(merged[node]) !== requestHash(parsed)) throw new Error('GRAPH_BRANCH_CONFLICT');
    merged[node] = parsed;
  }
  return merged;
}

/** Fixed analysis graph. Domain services supply nodes; no dynamic tools or generic agent runtime. */
export class AnalysisGraph {
  constructor(private readonly config: CheckpointConfig, private readonly artifacts: Pick<AnalysisArtifactRepository, 'node'>,
    private readonly nodes: AnalysisGraphNodes,
    private readonly open: typeof createCheckpointStore = createCheckpointStore) {}

  async execute(claim: ExecutionClaim, signal: AbortSignal, budget: { reserve: (usage: UsageReservation) => Promise<void> }) {
    if (claim.message.taskType !== 'analysis' || !claim.graph) throw new TaskFailure('UNSUPPORTED_INPUT');
    const snapshot = realAnalysisInputSchema.parse(claim.snapshot), inputHash = requestHash(snapshot);
    const scored = !!snapshot.scoringPolicyHash;
    const activeNodes = analysisNodeSchema.options.filter(node => scored || !['SCORE','RANK'].includes(node));
    const priorNodes = (name: AnalysisNode) => !scored && name === 'JOIN' ? ['PROFILE','MATCH'] as const : dependencies[name];
    const componentVersion = scored ? 'analysis-scoring-v1' : 'analysis-graph-v1';
    if (snapshot.ownerId !== claim.ownerId) throw new TaskFailure('UNSUPPORTED_INPUT');
    const guard = () => { signal.throwIfAborted(); if (Date.now() >= claim.deadline.getTime()) throw new TaskFailure('DEADLINE_EXCEEDED'); };
    guard();
    const session = this.open(this.config), pending = new Set<Promise<unknown>>(); let closing = false;
    const track = <T>(work: () => Promise<T>): Promise<T> => {
      if (closing) return Promise.reject(new Error('ANALYSIS_GRAPH_CLOSING'));
      const promise = Promise.resolve().then(work); pending.add(promise);
      void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise;
    };
    const put = session.saver.put.bind(session.saver), putWrites = session.saver.putWrites.bind(session.saver);
    session.saver.put = (...args) => track(() => put(...args));
    session.saver.putWrites = (...args) => track(() => putWrites(...args));
    try {
      const state = Annotation.Root({ schemaVersion: Annotation<1>(), taskId: Annotation<string>(), inputHash: Annotation<string>(),
        outputs: Annotation<AnalysisGraphState['outputs']>({ reducer: mergeAnalysisOutputs, default: () => ({}) }),
      });
      const node = (name: AnalysisNode) => async (raw: typeof state.State) => track(async () => {
        guard(); const current = analysisGraphStateSchema.parse(raw);
        if (current.taskId !== claim.message.taskId || current.inputHash !== inputHash) throw new TaskFailure('INPUT_INVALID');
        const inputs = priorNodes(name).map(dependency => {
          const result = current.outputs[dependency]; if (!result) throw new TaskFailure('INPUT_INVALID');
          return { node: dependency, result };
        });
        const identity = { node: name, branchKey: 'root', inputHash: requestHash({ inputHash, inputs }),
          componentVersion, schemaVersion: 1, promptVersion: snapshot.promptVersion, modelConfigVersion: snapshot.modelConfigVersion };
        const existing = await this.artifacts.node(claim, identity); guard();
        if (existing) return { outputs: { [name]: existing.result } };
        const result = analysisNodeResultSchema.parse(await this.nodes[name](current, { claim, signal, budget })); guard();
        const saved = await this.artifacts.node(claim, identity, result); guard();
        if (!saved) throw new Error('ANALYSIS_NODE_MISSING');
        return { outputs: { [name]: saved.result } };
      });
      const builder = new StateGraph(state)
        .addNode('LOAD', node('LOAD')).addNode('PARSE', node('PARSE')).addNode('EXTRACT', node('EXTRACT'))
        .addNode('VALIDATE', node('VALIDATE')).addNode('PROFILE', node('PROFILE')).addNode('RECALL', node('RECALL'))
        .addNode('SNAP', node('SNAP')).addNode('MATCH', node('MATCH')).addNode('JOIN', node('JOIN')).addNode('FINALIZE', node('FINALIZE'))
        .addEdge(START, 'LOAD').addEdge('LOAD', 'PARSE').addEdge('PARSE', 'EXTRACT').addEdge('EXTRACT', 'VALIDATE')
        .addEdge('VALIDATE', 'PROFILE').addEdge('VALIDATE', 'RECALL').addEdge('RECALL', 'SNAP').addEdge('SNAP', 'MATCH');
      const graph = (scored ? builder.addNode('SCORE', node('SCORE')).addNode('RANK', node('RANK'))
        .addEdge('MATCH','SCORE').addEdge('SCORE','RANK').addEdge(['PROFILE','RANK'],'JOIN') : builder.addEdge(['PROFILE','MATCH'],'JOIN'))
        .addEdge('JOIN', 'FINALIZE').addEdge('FINALIZE', END).compile({ checkpointer: session.saver });
      const invocation = { configurable: { thread_id: claim.graph.threadId }, durability: 'sync' as const, recursionLimit: 32,
        maxConcurrency: 3, signal };
      const prior = await track(() => session.saver.getTuple(invocation)); guard();
      if (prior) {
        const values = prior.checkpoint.channel_values, saved = analysisGraphStateSchema.strip().parse(values.__start__ ?? values);
        if (saved.taskId !== claim.message.taskId || saved.inputHash !== inputHash) throw new TaskFailure('INPUT_INVALID');
      }
      const result = analysisGraphStateSchema.parse(await graph.invoke(prior ? null : { schemaVersion: 1,
        taskId: claim.message.taskId, inputHash, outputs: {} }, invocation)); guard();
      // A checkpoint is recovery state; every returned node must still have a matching committed business artifact.
      for (const name of activeNodes) {
        const identity = { node: name, branchKey: 'root', inputHash: requestHash({ inputHash,
          inputs: priorNodes(name).map(dependency => ({ node: dependency, result: result.outputs[dependency] })) }),
          componentVersion, schemaVersion: 1, promptVersion: snapshot.promptVersion, modelConfigVersion: snapshot.modelConfigVersion };
        const saved = await this.artifacts.node(claim, identity); guard();
        if (!saved || requestHash(saved.result) !== requestHash(result.outputs[name])) throw new TaskFailure('OUTPUT_INVALID');
      }
      return result;
    } finally {
      closing = true;
      await Promise.allSettled([...pending]);
      await session.close();
    }
  }
}
