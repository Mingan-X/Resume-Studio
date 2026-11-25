import { Injectable, Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy } from '@nestjs/common';
import { context, trace, SpanStatusCode } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { CallbackHandler } from '@langfuse/langchain';
import { configureGlobalLogger, LogLevel } from '@langfuse/core';
import { z } from 'zod';
import type { ObservabilityConfig } from './config.js';
import { PrivateSpanProcessor, correlationContext } from './processor.js';
import { observationNames } from './privacy.js';
import type { ObservationName } from './privacy.js';

@Injectable()
export class ObservabilityService implements OnModuleDestroy {
  private readonly provider: NodeTracerProvider | undefined;
  private readonly processor: PrivateSpanProcessor | undefined;

  constructor(config: ObservabilityConfig) {
    if (!config.enabled) return;
    // SDK debug/error logging can contain raw callback arguments; report only our counters.
    configureGlobalLogger({ level: LogLevel.NONE });
    this.processor = new PrivateSpanProcessor(config);
    this.provider = new NodeTracerProvider({
      resource: resourceFromAttributes({ 'service.name': 'resume-studio' }),
      spanLimits: { attributeCountLimit: 32, attributeValueLengthLimit: 512, eventCountLimit: 0, linkCountLimit: 0 },
      spanProcessors: [this.processor],
    });
    this.provider.register();
  }

  callbacks(): CallbackHandler[] { return this.provider ? [new CallbackHandler()] : []; }

  async run<T>(correlationId: string, name: ObservationName, action: () => Promise<T>): Promise<T> {
    if (!this.provider) return action();
    const id = z.uuid().parse(correlationId);
    const safeName = z.enum(observationNames).parse(name);
    return context.with(context.active().setValue(correlationContext, id), () =>
      trace.getTracer('resume-studio').startActiveSpan(safeName, async span => {
        try { return await action(); }
        catch (error) { span.setStatus({ code: SpanStatusCode.ERROR }); throw error; }
        finally { span.end(); }
      }));
  }

  stats() { return this.processor?.metrics.snapshot(); }

  async flush(): Promise<void> {
    await this.processor?.forceFlush();
    this.reportLoss();
  }

  private reportLoss(): void {
    const stats = this.stats();
    if (stats && Object.values(stats.lost).some(count => count > 0)) {
      process.stdout.write(JSON.stringify({ event: 'observability_loss', ...stats }) + '\n');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.provider?.shutdown();
    this.reportLoss();
    if (this.provider) { trace.disable(); context.disable(); }
  }
}

@Module({})
export class ObservabilityModule {
  static register(config: ObservabilityConfig): DynamicModule {
    return { module: ObservabilityModule,
      providers: [{ provide: ObservabilityService, useFactory: () => new ObservabilityService(config) }],
      exports: [ObservabilityService] };
  }
}
