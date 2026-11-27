import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { taskApiConfigSchema } from './task-api-config.js';
import { authConfigSchema } from '../auth/auth-config.js';

const environment = z.enum(['development', 'test', 'production']);
const common = { APP_ENV: environment };

export const apiConfigSchema = z.object({
  ...common,
  role: z.literal('api'), // 角色字段，固定为 'api'
  HTTP_HOST: z.enum(['127.0.0.1', '0.0.0.0', '::1']).default('127.0.0.1'), // 默认主机地址
  HTTP_PORT: z.string().regex(/^\d+$/).transform(Number).pipe(z.int().min(1).max(65535)), // 默认端口号
  tasks: taskApiConfigSchema.optional(),
  auth: authConfigSchema.optional(),
  analysisConfigFile: z.string().min(1).refine(isAbsolute).optional(),
  resumes: z.object({ databaseUrl: taskApiConfigSchema.unwrap().shape.databaseUrl,
    storageRoot: z.string().min(1).refine(isAbsolute) }).strict().optional(),
  jobs: z.object({ databaseUrl: taskApiConfigSchema.unwrap().shape.databaseUrl,
    modelConfigFile: z.string().min(1).refine(isAbsolute).optional(), indexTargetFile: z.string().min(1).refine(isAbsolute).optional(),
  }).strict().optional(),
}).superRefine((config, ctx) => {
  if (config.analysisConfigFile && !config.tasks) ctx.addIssue({ code: 'custom', path: ['analysisConfigFile'], message: 'Task API required' });
  if (!config.tasks && !config.resumes && !config.jobs) return;
  if (!config.auth) {
    if (config.APP_ENV === 'production') ctx.addIssue({ code: 'custom', path: ['APP_ENV'], message: 'Session authentication required' });
    if (!['127.0.0.1','::1'].includes(config.HTTP_HOST)) ctx.addIssue({ code: 'custom', path: ['HTTP_HOST'], message: 'Local development identity only' });
  } else if ([config.tasks,config.resumes,config.jobs].some(value=>value&&value.databaseUrl!==config.auth?.databaseUrl)) {
    ctx.addIssue({code:'custom',path:['auth','databaseUrl'],message:'One application database required'});
  }
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
  if (role === 'api' && env.AUTH_ENABLED !== undefined && !['true','false'].includes(env.AUTH_ENABLED)) throw new ConfigValidationError(['AUTH_ENABLED']);
  if (role === 'api' && env.TASK_API_ENABLED !== undefined && !['true','false'].includes(env.TASK_API_ENABLED)) {
    throw new ConfigValidationError(['TASK_API_ENABLED']);
  }
  if (role === 'api' && env.RESUME_API_ENABLED !== undefined && !['true','false'].includes(env.RESUME_API_ENABLED)) {
    throw new ConfigValidationError(['RESUME_API_ENABLED']);
  }
  if (role === 'api' && env.JOB_API_ENABLED !== undefined && !['true','false'].includes(env.JOB_API_ENABLED)) throw new ConfigValidationError(['JOB_API_ENABLED']);
  // Pick known fields; never carry unrelated secrets into the application config.
  const schema = role === 'api' ? apiConfigSchema : workerConfigSchema;
  const parsed = schema.safeParse({
    role,
    APP_ENV: env.APP_ENV,
    HTTP_HOST: env.HTTP_HOST,
    HTTP_PORT: env.HTTP_PORT,
    ...(role === 'api' && env.AUTH_ENABLED === 'true' ? {auth:{databaseUrl:env.DATABASE_URL,origin:env.AUTH_ORIGIN,
      ...(env.AUTH_SESSION_SECONDS!==undefined?{sessionSeconds:Number(env.AUTH_SESSION_SECONDS)}:{}),
      ...(env.AUTH_ANONYMOUS_SECONDS!==undefined?{anonymousSeconds:Number(env.AUTH_ANONYMOUS_SECONDS)}:{})}} : {}),
    ...(role === 'api' && env.TASK_API_ENABLED === 'true' ? { tasks: { databaseUrl: env.DATABASE_URL } } : {}),
    ...(role === 'api' && env.ANALYSIS_CONFIG_FILE ? { analysisConfigFile: env.ANALYSIS_CONFIG_FILE } : {}),
    ...(role === 'api' && env.RESUME_API_ENABLED === 'true' ? { resumes: { databaseUrl: env.DATABASE_URL, storageRoot: env.STORAGE_ROOT } } : {}),
    ...(role === 'api' && env.JOB_API_ENABLED === 'true' ? { jobs: { databaseUrl: env.DATABASE_URL,
      ...(env.JOB_MODEL_CONFIG_FILE ? { modelConfigFile: env.JOB_MODEL_CONFIG_FILE } : {}),
      ...(env.JOB_INDEX_TARGET_FILE ? { indexTargetFile: env.JOB_INDEX_TARGET_FILE } : {}) } } : {}),
  });
  if (!parsed.success) {
    throw new ConfigValidationError(
      [...new Set(parsed.error.issues.map((issue) => issue.path[0] === 'tasks' ? 'DATABASE_URL'
        : issue.path[0] === 'auth' ? issue.path[1] === 'origin' ? 'AUTH_ORIGIN' : issue.path[1] === 'sessionSeconds' ? 'AUTH_SESSION_SECONDS' : issue.path[1] === 'anonymousSeconds' ? 'AUTH_ANONYMOUS_SECONDS' : 'DATABASE_URL'
        : issue.path[0] === 'resumes' ? issue.path[1] === 'storageRoot' ? 'STORAGE_ROOT' : 'DATABASE_URL'
        : issue.path[0] === 'jobs' ? issue.path[1] === 'modelConfigFile' ? 'JOB_MODEL_CONFIG_FILE' : issue.path[1] === 'indexTargetFile' ? 'JOB_INDEX_TARGET_FILE' : 'DATABASE_URL'
        : issue.path[0] === 'analysisConfigFile' ? 'ANALYSIS_CONFIG_FILE' : String(issue.path[0])))].sort(),
    );
  }
  return parsed.data;
}
