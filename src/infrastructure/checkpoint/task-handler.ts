import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import { createCheckpointStore } from './store.js';
import type { CheckpointConfig } from './config.js';
import type { TaskExecutionStore } from '../consumer/task-execution.store.js';
import type { SyntheticTaskHandler } from '../consumer/task-delivery.handler.js';
import type { ExecutionClaim } from '../consumer/contracts.js';
import { requestHash } from '../../modules/tasks/request-hash.js';

const stateSchema = z.object({ taskId: z.uuid(), inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  value: z.int(), step: z.enum(['input','first','second']) }).strict();
type CheckpointSession = ReturnType<typeof createCheckpointStore>;

// Opt-in synthetic graph; never accepts resume text or selects a model/provider.
export class CheckpointTaskHandler implements SyntheticTaskHandler {
  constructor(private readonly config: CheckpointConfig, private readonly tasks: TaskExecutionStore,
    private readonly open: (config: CheckpointConfig) => CheckpointSession = createCheckpointStore) {}

  async execute(claim: ExecutionClaim, signal: AbortSignal) {
    if (claim.message.taskType !== 'analysis' || !claim.graph) throw new Error('Analysis graph claim required.');
    signal.throwIfAborted();
    const session = this.open(this.config), inputHash = requestHash(claim.snapshot);
    const writes = new Set<Promise<unknown>>();
    let closing = false;
    const track = <T>(work: () => Promise<T>): Promise<T> => {
      if (closing) return Promise.reject(new Error('CHECKPOINT_SESSION_CLOSING'));
      const pending = Promise.resolve().then(work);
      writes.add(pending);
      void pending.then(() => writes.delete(pending), () => writes.delete(pending));
      return pending;
    };
    const put = session.saver.put.bind(session.saver), putWrites = session.saver.putWrites.bind(session.saver);
    session.saver.put = (...args) => track(() => put(...args));
    session.saver.putWrites = (...args) => track(() => putWrites(...args));
    try {
      const state = Annotation.Root({ taskId: Annotation<string>(), inputHash: Annotation<string>(),
        value: Annotation<number>(), step: Annotation<'input' | 'first' | 'second'>() });
      const node = (name: 'first' | 'second') => async (value: typeof state.State) => {
        signal.throwIfAborted();
        const input = stateSchema.parse(value);
        if (input.taskId !== claim.message.taskId || input.inputHash !== inputHash) throw new Error('Checkpoint input identity mismatch.');
        const saved = await track(() => this.tasks.nodeArtifact(claim, name));
        if (saved) return { value: saved.value, step: name };
        signal.throwIfAborted();
        const output = await track(() => this.tasks.nodeArtifact(claim, name, { schemaVersion: 1, kind: 'synthetic', node: name,
          inputHash, value: name === 'first' ? 3 : input.value * 3 }));
        if (!output) throw new Error('Synthetic output missing.');
        return { value: output.value, step: name };
      };
      const graph = new StateGraph(state).addNode('first', node('first')).addNode('second', node('second'))
        .addEdge(START,'first').addEdge('first','second').addEdge('second',END).compile({ checkpointer: session.saver });
      const invocation = { configurable: { thread_id: claim.graph.threadId }, durability: 'sync' as const, recursionLimit: 8, signal };
      const checkpoint = await session.saver.getTuple(invocation);
      if (checkpoint) {
        const values = checkpoint.checkpoint.channel_values;
        // Internal channels belong to LangGraph; validate the user-state projection independently.
        const prior = stateSchema.strip().parse(values.__start__ ?? values);
        // The initial input checkpoint can precede user channels. In that case LangGraph will apply its pending input.
        if (prior.taskId !== claim.message.taskId || prior.inputHash !== inputHash) throw new Error('Checkpoint belongs to another input.');
      }
      const output = stateSchema.parse(await graph.invoke(checkpoint ? null : {
        taskId: claim.message.taskId, inputHash, value: 1, step: 'input',
      }, invocation));
      signal.throwIfAborted();
      if (output.taskId !== claim.message.taskId || output.inputHash !== inputHash || output.step !== 'second' || output.value !== 9) throw new Error('Invalid synthetic graph result.');
      const first = await track(() => this.tasks.nodeArtifact(claim, 'first'));
      const second = await track(() => this.tasks.nodeArtifact(claim, 'second'));
      if (first?.value !== 3 || second?.value !== 9) throw new Error('Checkpoint result has no committed business artifacts.');
      // Completion is committed by TaskDeliveryHandler under the same fence; no saver SQL is trusted as a business commit.
      return { schemaVersion: 1 as const, kind: 'synthetic' as const, inputHash, completedUnits: 1 as const };
    } finally {
      closing = true; // reject any new background write once invocation has returned
      await Promise.allSettled([...writes]);
      await session.close(); // execution cannot be declared stopped before its in-flight writes and saver pool drain
    }
  }
}
