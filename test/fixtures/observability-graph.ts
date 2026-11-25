import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import type { ObservabilityService } from '../../src/infrastructure/observability/observability.module.js';

export const syntheticSecrets = {
  email: 'synthetic-private@example.invalid', phone: '13800138000',
  secret: 'sk-synthetic-private-do-not-export',
};

export async function runObservedGraph(observability: ObservabilityService, correlationId: string): Promise<number> {
  // Fixtures never activate a separately configured LangSmith cloud tracer.
  process.env.LANGSMITH_TRACING = 'false';
  process.env.LANGCHAIN_TRACING_V2 = 'false';
  const State = Annotation.Root({ value: Annotation<number>(), email: Annotation<string>(),
    phone: Annotation<string>(), secret: Annotation<string>() });
  const graph = new StateGraph(State).addNode('synthetic-node', async input =>
    observability.run(correlationId, 'score', async () => ({ value: z.number().parse(input.value) + 2 })))
    .addEdge(START, 'synthetic-node').addEdge('synthetic-node', END).compile();
  return observability.run(correlationId, 'synthetic-analysis', async () => {
    const result = await graph.invoke({ value: 7, ...syntheticSecrets }, {
      callbacks: observability.callbacks(), runName: 'synthetic-analysis',
      metadata: { privateEmail: syntheticSecrets.email, privateSecret: syntheticSecrets.secret },
    });
    return z.number().parse(result.value);
  });
}
