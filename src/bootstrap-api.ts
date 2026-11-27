import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ApiModule } from './app-api.module.js';
import type { ApiConfig } from './modules/config/app-config.js';
import { AppLogger } from './infrastructure/logging/app-logger.js';
import { requestContext } from './infrastructure/logging/request-context.js';
import { registerShutdown } from './lifecycle.js';
import {ConfigService} from './modules/config/config.module.js';
import {configureSecurity} from './infrastructure/http/api-security.js';

export async function createApi(config: ApiConfig): Promise<INestApplication> {
  const extra = config.tasks ? [(await import('./modules/tasks/task-api.module.js')).TaskApiModule.register(config.tasks,
    await (await import('./infrastructure/tasks/analysis-config.js')).loadAnalysisConfiguration(config.analysisConfigFile),Boolean(config.auth))] : [];
  if (config.resumes) extra.push((await import('./modules/resumes/resume-api.module.js')).ResumeApiModule.register(config.resumes,Boolean(config.auth)));
  if (config.jobs) extra.push(await (await import('./modules/jobs/job-api.module.js')).JobApiModule.register(config.jobs,Boolean(config.auth)));
  if (config.auth) extra.push((await import('./modules/auth/auth.module.js')).AuthModule.register(config.auth,true));
  if (config.readiness) extra.push((await import('./modules/health/readiness.module.js')).ReadinessModule.register(config.readiness));
  const app = await NestFactory.create(ApiModule.register(config, extra), {
    logger: false, abortOnError: false,
  });
  configureHttp(app);
  return app;
}

export function configureHttp(app: INestApplication): void {
  app.use((_request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const requestId = randomUUID();
    const started = performance.now();
    response.setHeader('x-request-id', requestId);
    requestContext.run({ requestId }, () => {
      response.once('finish', () => app.get(AppLogger).write('info', {
        event: 'http_request_completed', requestId,
        statusCode: response.statusCode,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
      }));
      next();
    });
  });
  const config=app.get(ConfigService).values;
  if(config.role!=='api')throw new Error('API_CONFIGURATION_REQUIRED');
  configureSecurity(app,config);
}

export async function startApi(config: ApiConfig): Promise<void> {
  const app = await createApi(config);
  try {
    await app.listen(config.HTTP_PORT, config.HTTP_HOST);
    registerShutdown(app);
    app.get(AppLogger).write('info', { event: 'application_started' });
    process.send?.({ type: 'ready', role: 'api' });
  } catch (error) {
    await app.close();
    throw error;
  }
}
