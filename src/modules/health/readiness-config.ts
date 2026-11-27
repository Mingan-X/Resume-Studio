import { z } from 'zod';
import { taskApiConfigSchema } from '../config/task-api-config.js';

export const readinessConfigSchema = z.object({ databaseUrl: taskApiConfigSchema.unwrap().shape.databaseUrl,
  rabbitmqUrl: z.url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'amqp:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === '55672' &&
      url.username === 'resume_studio_test' && url.pathname === '/resume-studio-s12-test' && !url.hash &&
      (!url.search || url.search === '?heartbeat=10');
  }),
}).strict();
export type ReadinessConfig = z.infer<typeof readinessConfigSchema>;
