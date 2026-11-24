import { z } from 'zod';

const environment = z.enum(['development', 'test', 'production']);
const common = { APP_ENV: environment };

export const apiConfigSchema = z.object({
  ...common,
  role: z.literal('api'), // 角色字段，固定为 'api'
  HTTP_HOST: z.enum(['127.0.0.1', '0.0.0.0', '::1']).default('127.0.0.1'), // 默认主机地址
  HTTP_PORT: z.string().regex(/^\d+$/).transform(Number).pipe(z.int().min(1).max(65535)), // 默认端口号
}).readonly();

export const workerConfigSchema = z.object({
  ...common,
  role: z.literal('worker'),
}).readonly();

export type ApiConfig = z.infer<typeof apiConfigSchema>; // API应用配置
export type WorkerConfig = z.infer<typeof workerConfigSchema>; // 工作进程配置
export type AppConfig = ApiConfig | WorkerConfig; // 应用配置

// 配置验证错误异常
export class ConfigValidationError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(`Invalid configuration fields: ${fields.join(', ')}`);
    this.name = 'ConfigValidationError';
  }
}

export function loadConfig(role: 'api', env: NodeJS.ProcessEnv): ApiConfig;
export function loadConfig(role: 'worker', env: NodeJS.ProcessEnv): WorkerConfig;
export function loadConfig(role: AppConfig['role'], env: NodeJS.ProcessEnv): AppConfig {
  // Pick known fields; never carry unrelated secrets into the application config.
  const schema = role === 'api' ? apiConfigSchema : workerConfigSchema;
  const parsed = schema.safeParse({
    role,
    APP_ENV: env.APP_ENV,
    HTTP_HOST: env.HTTP_HOST,
    HTTP_PORT: env.HTTP_PORT,
  });
  if (!parsed.success) {
    throw new ConfigValidationError(
      [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))].sort(),
    );
  }
  return parsed.data;
}
