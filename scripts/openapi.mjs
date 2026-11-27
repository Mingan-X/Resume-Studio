import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';

// Generation-only entry: runtime validators never import this dev dependency or its Zod extension.
extendZodWithOpenApi(z);
// ESM static imports would construct schemas before the generation-only extension is installed.
const { healthQuerySchema, healthResponseSchema, errorResponseSchema } = await import('../dist/src/contracts/http.js');
const { taskPathSchema, taskQuerySchema, taskResponseSchema, cancelTaskRequestSchema, cancelTaskResponseSchema } = await import('../dist/src/contracts/task-api.js');
const { resumeListQuerySchema, resumeListResponseSchema, resumeVersionPathSchema, resumeVersionResponseSchema } = await import('../dist/src/contracts/resumes.js');
const { jobPathSchema, jobVersionPathSchema, jobListQuerySchema, jobListResponseSchema, jobVersionResponseSchema } = await import('../dist/src/contracts/job-api.js');
const { createJobDraftSchema, editJobDraftSchema } = await import('../dist/src/contracts/job-drafts.js');
const { jobConfirmationSchema, jobPublicationResultSchema } = await import('../dist/src/contracts/job-publication.js');
const { jdExtractionResultSchema } = await import('../dist/src/contracts/job-extraction.js');
const { createAnalysisRequestSchema, createAnalysisResponseSchema } = await import('../dist/src/contracts/analyses.js');
const { reportPathSchema, pageQuerySchema, reportResponseSchema, reportListSchema, recomputeRequestSchema } = await import('../dist/src/contracts/reports.js');
const { analysisPathSchema, analysisListSchema, analysisDetailSchema, analysisOptionsQuerySchema, analysisOptionsSchema, taskEventResponseSchema } = await import('../dist/src/contracts/analysis-api.js');
const { loginRequestSchema, authSessionResponseSchema, authMeResponseSchema, logoutResponseSchema } = await import('../dist/src/contracts/auth.js');
const registry = new OpenAPIRegistry();
registry.registerComponent('securitySchemes','sessionCookie',{type:'apiKey',in:'cookie',name:'__Host-resume_session',description:'AUTH_ENABLED=true时必需；写请求同时要求X-CSRF-Token及精确HTTPS Origin。'});
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
  summary: '查询当前主体的任务', description: '需显式启用任务API。未知查询字段返回400；不存在或其他owner的资源统一404。progress来自已保存计数，总量未知为null；不暴露执行令牌或输入。',
  request: { params: taskPathSchema, query: taskQuerySchema }, responses: { 200: response(task,'当前任务快照'), ...errors } });
registry.registerPath({ method: 'post', path: '/api/v1/tasks/{taskId}/cancel', operationId: 'cancelTask',
  summary: '持久化取消请求', description: '请求必须为application/json空对象。202只表示请求已保存，最终状态通过GET查询。非终态重复请求返回202；终态返回409。由消费者或对账器在安全边界提交CANCELLED。',
  request: { params: taskPathSchema, query: taskQuerySchema, body: { required: true, content: { 'application/json': { schema: cancel } } } },
  responses: { 202: response(accepted,'取消请求已保存'), ...errors, 409: response(error,'任务已结束，INVALID_STATE') } });
registry.registerPath({ method: 'post', path: '/api/v1/resumes', operationId: 'uploadResume', summary: '同步上传并解析简历',
  request: { headers: z.object({ 'idempotency-key': z.uuid() }), query: taskQuerySchema,
    body: { required: true, content: { 'multipart/form-data': { schema: z.object({ file: z.string().openapi({ type: 'string', format: 'binary' }) }).strict() } } } },
  responses: { 201: response(resumeVersionResponseSchema, '原文件与解析产物已提交；幂等重放返回原版本'), ...errors,
    409: response(error, '同幂等键不同文件'), 413: response(error, '文件超过10 MiB'), 422: response(error, '文件不支持或解析失败；reason给出原因') } });
registry.registerPath({ method: 'get', path: '/api/v1/resumes', operationId: 'listResumes', summary: '当前owner的简历列表',
  request: { query: resumeListQuerySchema }, responses: { 200: response(resumeListResponseSchema, 'createdAt/id降序游标分页'), ...errors } });
registry.registerPath({ method: 'get', path: '/api/v1/resumes/{resumeId}/versions/{versionId}', operationId: 'getResumeVersion', summary: '读取简历版本与已存文本证据',
  request: { params: resumeVersionPathSchema, query: taskQuerySchema }, responses: { 200: response(resumeVersionResponseSchema, '不可变文本与警告，不返回结构化占位'), ...errors } });
const jobErrors = { ...errors, 409: response(error, '幂等冲突或未确认/引用失效'), 422: response(error, '模型输出或预算不满足'), 503: response(error, '模型或索引目标未配置/暂不可用') };
const jsonBody = schema => ({ required: true, content: { 'application/json': { schema } } });
const authErrors = { ...errors, 401: response(error,'会话无效或未登录'), 403: response(error,'CSRF或Origin不匹配'), 503: response(error,'认证暂不可用') };
const csrfHeaders = z.object({ 'x-csrf-token': z.string().regex(/^[a-f0-9]{64}$/), origin: z.url() });
registry.registerPath({ method:'get', path:'/api/v1/auth/session', operationId:'getAuthSession', summary:'获取会话与登录前CSRF令牌', description:'仅AuthModule启用时提供。匿名会话无业务权限，所有响应no-store。', request:{query:taskQuerySchema}, responses:{200:response(authSessionResponseSchema,'匿名或当前登录状态'),...errors} });
registry.registerPath({ method:'get', path:'/api/v1/auth/me', operationId:'getCurrentUser', summary:'读取当前登录账号', request:{query:taskQuerySchema}, responses:{200:response(authMeResponseSchema,'账号概要与CSRF令牌，不返回owner'),...authErrors} });
registry.registerPath({ method:'post', path:'/api/v1/auth/login', operationId:'login', summary:'验证本地账号并轮换会话', request:{query:taskQuerySchema,headers:csrfHeaders,body:jsonBody(loginRequestSchema)}, responses:{200:response(authMeResponseSchema,'登录成功，Set-Cookie替换旧会话'),...authErrors} });
registry.registerPath({ method:'post', path:'/api/v1/auth/logout', operationId:'logout', summary:'撤销当前会话', request:{query:taskQuerySchema,headers:csrfHeaders,body:jsonBody(taskQuerySchema)}, responses:{200:response(logoutResponseSchema,'会话已撤销，Cookie失效'),...authErrors} });
registry.register('TaskEvent',taskEventResponseSchema);
registry.registerPath({method:'get',path:'/api/v1/reports',operationId:'listReports',summary:'报告历史游标分页',request:{query:pageQuerySchema},responses:{200:response(reportListSchema,'不可变报告概要'),...errors}});
registry.registerPath({method:'get',path:'/api/v1/reports/{reportId}',operationId:'getReport',summary:'读取完整不可变报告',request:{params:reportPathSchema,query:taskQuerySchema},responses:{200:response(reportResponseSchema,'含评分、覆盖率、判断、证据和版本'),...errors}});
registry.registerPath({method:'get',path:'/api/v1/reports/{reportId}/revisions',operationId:'listReportRevisions',summary:'同一分析的报告revision',request:{params:reportPathSchema,query:pageQuerySchema},responses:{200:response(reportListSchema,'同一分析的所有revision'),...errors}});
registry.registerPath({method:'post',path:'/api/v1/reports/{reportId}/recompute',operationId:'recomputeReport',summary:'复用冻结判断调权并生成新revision',request:{params:reportPathSchema,query:taskQuerySchema,headers:z.object({'idempotency-key':z.uuid()}),body:jsonBody(recomputeRequestSchema)},responses:{201:response(reportResponseSchema,'新报告或幂等重放，无模型调用'),...errors,409:response(error,'幂等冲突或报告没有可重算评分')}});
registry.registerPath({method:'get',path:'/api/v1/analyses',operationId:'listAnalyses',summary:'分析任务列表',request:{query:pageQuerySchema},responses:{200:response(analysisListSchema,'当前owner真实分析列表'),...errors}});
registry.registerPath({method:'get',path:'/api/v1/analyses/options',operationId:'getAnalysisOptions',summary:'选择解析成功的简历版本与冻结岗位范围',request:{query:analysisOptionsQuerySchema},responses:{200:response(analysisOptionsSchema,'分别分页的简历版本和语料'),...errors}});
registry.registerPath({method:'get',path:'/api/v1/analyses/{taskId}',operationId:'getAnalysis',summary:'分析输入版本概要与任务状态',request:{params:analysisPathSchema,query:taskQuerySchema},responses:{200:response(analysisDetailSchema,'当前owner分析详情'),...errors}});
registry.registerPath({method:'get',path:'/api/v1/tasks/{taskId}/events',operationId:'getTaskEvents',summary:'持久化任务事件SSE',description:'事件id为TaskEvent.seq，Last-Event-ID补读；event=task，data遵循TaskEvent。15秒心跳，每owner每进程最多5连接，全进程100；300秒连接到期后可重连。断线不取消任务。',request:{params:taskPathSchema,query:taskQuerySchema,headers:z.object({'last-event-id':z.string().regex(/^(0|[1-9]\d{0,9})$/).optional()})},responses:{200:{description:'按seq递增的SSE流',headers,content:{'text/event-stream':{schema:z.string()}}},204:{description:'终态且无待补读事件'},...errors,429:response(error,'连接数达到上限')}});
registry.registerPath({ method: 'post', path: '/api/v1/analyses', operationId: 'createAnalysis', summary: '冻结授权输入并事务创建分析任务',
  request: { query: taskQuerySchema, headers: z.object({ 'idempotency-key': z.uuid() }), body: jsonBody(createAnalysisRequestSchema) },
  responses: { 202: response(createAnalysisResponseSchema, '任务和Outbox已提交；同key同请求返回原任务'), ...errors,
    409: response(error, '幂等冲突或配置版本内容变化'), 503: response(error, '分析配置不可用') } });
registry.registerPath({ method: 'post', path: '/api/v1/jobs', operationId: 'createJob', summary: '创建JD草稿', request: { query: taskQuerySchema, body: jsonBody(createJobDraftSchema) }, responses: { 201: response(jobVersionResponseSchema, '新草稿版本'), ...jobErrors } });
registry.registerPath({ method: 'get', path: '/api/v1/jobs', operationId: 'listJobs', summary: 'owner范围岗位列表', request: { query: jobListQuerySchema }, responses: { 200: response(jobListResponseSchema, '稳定游标分页'), ...jobErrors } });
registry.registerPath({ method: 'get', path: '/api/v1/jobs/{jobId}', operationId: 'getJob', summary: '岗位最新版本', request: { params: jobPathSchema, query: taskQuerySchema }, responses: { 200: response(jobVersionResponseSchema, '最新版本'), ...jobErrors } });
registry.registerPath({ method: 'get', path: '/api/v1/jobs/{jobId}/versions/{versionId}', operationId: 'getJobVersion', summary: '岗位版本详情', request: { params: jobVersionPathSchema, query: taskQuerySchema }, responses: { 200: response(jobVersionResponseSchema, '含发布/索引状态与来源'), ...jobErrors } });
registry.registerPath({ method: 'patch', path: '/api/v1/jobs/{jobId}/versions/{versionId}', operationId: 'editJobDraft', summary: '编辑草稿或从发布版本派生新草稿', request: { params: jobVersionPathSchema, query: taskQuerySchema, body: jsonBody(editJobDraftSchema) }, responses: { 200: response(jobVersionResponseSchema, '编辑后的草稿'), ...jobErrors } });
registry.registerPath({ method: 'post', path: '/api/v1/jobs/{jobId}/versions/{versionId}/confirm', operationId: 'confirmJob', summary: '确认硬要求与权重', request: { params: jobVersionPathSchema, query: taskQuerySchema, body: jsonBody(jobConfirmationSchema) }, responses: { 200: response(jobVersionResponseSchema, '确认结果'), ...jobErrors } });
registry.registerPath({ method: 'post', path: '/api/v1/jobs/{jobId}/versions/{versionId}/publish', operationId: 'publishJob', summary: '事务发布JD和索引任务', request: { params: jobVersionPathSchema, query: taskQuerySchema, headers: z.object({ 'idempotency-key': z.uuid() }), body: jsonBody(taskQuerySchema) }, responses: { 202: response(jobPublicationResultSchema, '发布版本及待执行索引任务'), ...jobErrors } });
registry.registerPath({ method: 'post', path: '/api/v1/jobs/{jobId}/versions/{versionId}/suggestions', operationId: 'suggestJobRequirements', summary: '受限模型生成待人工确认建议，不写回草稿', request: { params: jobVersionPathSchema, query: taskQuerySchema, body: jsonBody(taskQuerySchema) }, responses: { 200: response(jdExtractionResultSchema, '校验过的建议及输入版本'), ...jobErrors } });
const document = new OpenApiGeneratorV31(registry.definitions, { sortComponents: 'alphabetically' }).generateDocument({
  openapi: '3.1.0', info: { title: 'Resume Studio Backend', version: '0.1.0',
    description: '业务路由分别显式启用；AUTH_ENABLED=true启用会话及写请求CSRF/Origin校验，生产业务路由必须开启；本地development/test可显式保留开发身份。' },
  servers: [{ url: '/', description: '与前端同源；本地通过代理连接API' }],
});
const generatedError=(description)=>({description,headers:{'x-request-id':{schema:{type:'string',format:'uuid'}}},
  content:{'application/json':{schema:{$ref:'#/components/schemas/ErrorResponse'}}}});
for(const [path,item] of Object.entries(document.paths)) {
  if(!path.startsWith('/api/v1/'))continue;
  for(const [method,operation] of Object.entries(item)) {
    if(!['get','post','patch','delete','put'].includes(method))continue;
    if(path.startsWith('/api/v1/auth/'))continue;
    operation.security=[{sessionCookie:[]}];
    operation.responses['401']=generatedError('会话模式下未登录或会话失效');
    if(method!=='get'){
      operation.responses['403']=generatedError('CSRF或Origin校验失败');
      operation.parameters=[...(operation.parameters??[]),{in:'header',name:'X-CSRF-Token',required:true,schema:{type:'string',pattern:'^[a-f0-9]{64}$'}},{in:'header',name:'Origin',required:true,schema:{type:'string',format:'uri'}}];
    }
  }
}
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
