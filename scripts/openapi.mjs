import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';

// Generation-only entry: runtime validators never import this dev dependency or its Zod extension.
extendZodWithOpenApi(z);
// ESM static imports would construct schemas before the generation-only extension is installed.
const { healthQuerySchema, healthResponseSchema, errorResponseSchema } = await import('../dist/src/contracts/http.js');
const { taskPathSchema, taskQuerySchema, taskResponseSchema, cancelTaskRequestSchema, cancelTaskResponseSchema } = await import('../dist/src/contracts/task-api.js');
const registry = new OpenAPIRegistry();
const health = registry.register('HealthResponse', healthResponseSchema);
const error = registry.register('ErrorResponse', errorResponseSchema);
const task = registry.register('TaskResponse', taskResponseSchema);
const cancel = registry.register('CancelTaskRequest', cancelTaskRequestSchema);
const accepted = registry.register('CancelTaskResponse', cancelTaskResponseSchema);
const headers = z.object({ 'x-request-id': z.uuid() });
const response = (schema, description) => ({ description, headers, content: { 'application/json': { schema } } });
const errors = { 400: response(error,'请求格式或Schema校验失败'), 404: response(error,'资源不可见或不存在'), 500: response(error,'安全的服务端错误') };
registry.registerPath({ method: 'get', path: '/health', operationId: 'getHealth',
  summary: '进程存活检查', description: '无查询参数；未知查询字段返回400。成功不表示外部依赖就绪。',
  request: { query: healthQuerySchema }, responses: { 200: response(health,'进程可响应'), 400: errors[400], 500: errors[500] } });
registry.registerPath({ method: 'get', path: '/api/v1/tasks/{taskId}', operationId: 'getTask',
  summary: '查询当前开发主体的任务', description: '需显式启用本地任务API。未知查询字段返回400；不存在或其他owner的资源统一404。progress来自已保存计数，总量未知为null；不暴露执行令牌或输入。',
  request: { params: taskPathSchema, query: taskQuerySchema }, responses: { 200: response(task,'当前任务快照'), ...errors } });
registry.registerPath({ method: 'post', path: '/api/v1/tasks/{taskId}/cancel', operationId: 'cancelTask',
  summary: '持久化取消请求', description: '请求必须为application/json空对象。202只表示请求已保存，最终状态通过GET查询。非终态重复请求返回202；终态返回409。由消费者或对账器在安全边界提交CANCELLED。',
  request: { params: taskPathSchema, query: taskQuerySchema, body: { required: true, content: { 'application/json': { schema: cancel } } } },
  responses: { 202: response(accepted,'取消请求已保存'), ...errors, 409: response(error,'任务已结束，INVALID_STATE') } });
const document = new OpenApiGeneratorV31(registry.definitions, { sortComponents: 'alphabetically' }).generateDocument({
  openapi: '3.1.0', info: { title: 'Resume Studio Backend', version: '0.1.0',
    description: 'S1.4已实现HTTP契约。任务路由仅在TASK_API_ENABLED=true时启用；固定开发身份不提供生产认证。' },
  servers: [{ url: '/', description: '与前端同源；本地通过代理连接API' }],
});
const generated = JSON.stringify(document, null, 2) + '\n';
const check = process.argv[2] === '--check';
if (process.argv[2] && !check) throw new Error('Expected --check or no arguments');
if ((!check && process.argv.length > 2) || process.argv.length > 4) throw new Error('Unexpected arguments');
const path = resolve(process.argv[3] ?? 'docs/openapi.json');
if (check) {
  let actual;
  try { actual = (await readFile(path,'utf8')).replaceAll('\r\n','\n'); } catch { actual = null; }
  if (actual !== generated) { console.error('OPENAPI_STALE: run pnpm run openapi:generate and commit docs/openapi.json'); process.exitCode = 1; }
  else console.log('OpenAPI artifact matches runtime schemas.');
} else { await writeFile(path, generated, 'utf8'); console.log('Generated docs/openapi.json from runtime schemas.'); }
