import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { z } from 'zod';
import type { ExecutionClaim } from '../../infrastructure/consumer/contracts.js';
import { TaskFailure } from '../../infrastructure/consumer/failure.js';
import { realAnalysisInputSchema, usageReservationSchema } from '../../contracts/tasks.js';
import type { UsageReservation } from '../../contracts/tasks.js';
import type { ModelExecutor } from '../models/model-executor.js';
import { ModelFailure } from '../models/model.port.js';
import { redactContactText } from '../models/privacy.js';
import type { ObservabilityService } from '../../infrastructure/observability/observability.module.js';

/** Analysis adapter only: retry/repair belongs to ModelExecutor, accounting belongs to the fenced task store. */
export class AnalysisModelCaller {
  constructor(private readonly model: ModelExecutor,
    private readonly observability?: Pick<ObservabilityService, 'run'>,
    private readonly registerTrace?:(ownerId:string,taskId:string,traceId:string)=>Promise<void>) {}

  get modelConfigVersion() { return this.model.modelConfigVersion; }

  async run<T>(claim: ExecutionClaim, budget: { reserve: (usage: UsageReservation) => Promise<void> },
    input: { stage: 'extract' | 'profile' | 'match'; instructions: string; data: string;
      schema: z.ZodType<T>; validate: (output: unknown) => T }, signal: AbortSignal) {
    const snapshot = realAnalysisInputSchema.parse(claim.snapshot);
    if (claim.message.taskType !== 'analysis' || snapshot.ownerId !== claim.ownerId
      || snapshot.modelConfigVersion !== this.model.modelConfigVersion || snapshot.budget.currency !== this.model.policy.currency) {
      throw new TaskFailure('UNSUPPORTED_INPUT');
    }
    const deadline = claim.deadline.getTime();
    const guard = () => {
      signal.throwIfAborted();
      if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new TaskFailure('DEADLINE_EXCEEDED');
    };
    guard();
    // Nodes redact individual evidence blocks before serialization to preserve UTF-16 evidence offsets.
    // This final pass masks plain contact patterns without changing structured JSON delimiters.
    const messages = [new SystemMessage(redactContactText(input.instructions, false)), new HumanMessage(redactContactText(input.data, false))];
    const reservations = new Set<Promise<void>>();
    const invoke = async () => {
      try {
        const result = await this.model.run({ messages, schema: input.schema, validate: input.validate, signal, deadline,
          repairMessages: () => [...messages, new HumanMessage('上次输出未通过Schema或证据校验。仅依据原数据修复一次，不添加字段、分数或不存在的证据。')],
          reserve: async delta => {
            guard();
            // No local reset or refund: every transport attempt, including repair, reserves durable task usage first.
            const pending = budget.reserve(usageReservationSchema.parse(delta));
            reservations.add(pending);
            try { await pending; } finally { reservations.delete(pending); }
            guard();
          },
        });
        guard(); return result;
      } catch (error) {
        // Preserve database/fence errors so TaskDeliveryHandler refuses ACK on uncertain accounting.
        if (!(error instanceof ModelFailure)) throw error;
        switch (error.code) {
          case 'TIMEOUT': throw new TaskFailure('UPSTREAM_TIMEOUT');
          case 'UNAVAILABLE': case 'BUSY': case 'UNSETTLED': throw new TaskFailure('DEPENDENCY_UNAVAILABLE');
          case 'UNSUPPORTED_MODEL': throw new TaskFailure('UNSUPPORTED_INPUT');
          case 'CANCELLED': guard(); throw new TaskFailure('DEADLINE_EXCEEDED');
          default: throw new TaskFailure(error.code);
        }
      } finally {
        // A deadline race does not prove the bounded SQL reservation stopped. Drain before the worker's stopped marker.
        await Promise.allSettled([...reservations]);
      }
    };
    // Project observation applies the existing whitelist before enqueue; no raw LangChain callbacks are attached.
    return this.observability ? this.observability.run(claim.message.taskId, input.stage, invoke,
      this.registerTrace?(id)=>this.registerTrace!(claim.ownerId,claim.message.taskId,id):undefined) : invoke();
  }
}
