# HTTP API

## 分析任务创建（S2.4-T1）

`POST /api/v1/analyses` 随 `TASK_API_ENABLED=true` 启用，仅本地development/test；要求application/json、UUID `Idempotency-Key`，无查询字段。正文只接受：

```json
{"resumeVersionId":"00000000-0000-4000-8000-000000000002","asOfDate":"2026-11-27","jobCorpusVersionId":"corpus-v1"}
```

`jobCorpusVersionId` 使用既有语料的版本名（owner＋version复合身份），不是合成任务中的UUID，也不隐式选择latest。可信owner来自IdentityPort。简历必须已有成功保存的ExtractedDocument；语料和Rubric必须属于该owner。配置由服务端绝对路径 `ANALYSIS_CONFIG_FILE` 加载，字段见[分析配置说明](analysis-input.md)，客户端不能提交owner、预算、模型或规则配置。

S2.5起，新任务还要求owner下已导入配置指定的scoringVersion，冻结政策内容hash；缺失仍返回资源不存在404。评分在分析图中执行，reportId仍为null，评分结果/重算HTTP在S3.1接入；请求正文和202响应保持不变。部署顺序见[部署说明](deployment.md)，不从请求读取任意政策或owner。

202返回 `{"taskId":"<UUID>","statusUrl":"/api/v1/tasks/<UUID>"}`。任务、冻结输入与Outbox同事务提交；查询复用任务GET。相同owner/key/正文返回原taskId，即使服务端配置已更换或停用；不同正文409 IDEMPOTENCY_CONFLICT。非法字段400、资源不存在或越权404、同配置版本内容改变409 INVALID_STATE、未配置分析503 ANALYSIS_UNAVAILABLE。响应不携带内部配置或凭证。S2.4业务图通过显式真实分析消费命令执行；合成消费者不会领取或成功完成真实分析。S3.1报告接入前SUCCEEDED/PARTIAL只表示相应语义产物已提交，reportId=null；阶段/计数及失败语义见[分析流程](analysis-workflow.md)。

## 岗位草稿、发布与建议（S2.2）

需JOB_API_ENABLED=true，可信owner来自本地IdentityPort；仅development/test及loopback允许启用。响应不返回owner、执行令牌、凭证或内部索引快照。

| 路径（均在/api/v1下） | 行为 |
|---|---|
| POST /jobs | JSON title/city/level/skills/body创建草稿，201返回版本 |
| GET /jobs | limit默认20/最大100、cursor；createdAt/id降序，返回各岗位latestVersion及nextCursor |
| GET /jobs/:jobId | 返回当前owner岗位的最新版本 |
| GET /jobs/:jobId/versions/:versionId | 版本详情含正文证据、要求、确认标记、status及indexStatus |
| PATCH /jobs/:jobId/versions/:versionId | kind=body/metadata/requirement-upsert/requirement-delete/weights，正文见同源Schema；编辑发布版生成新草稿 |
| POST /jobs/:jobId/versions/:versionId/confirm | JSON hardRequirementsConfirmed/weightsConfirmed，200；完整校验要求与权重 |
| POST /jobs/:jobId/versions/:versionId/publish | JSON空对象和UUID Idempotency-Key；202返回jobVersionId/taskId；发布、索引任务、Outbox同事务 |
| POST /jobs/:jobId/versions/:versionId/suggestions | JSON空对象；200返回受校验建议、输入哈希及prompt/model/schema版本，不自动写回要求 |

上述除列表外不接受查询字段，POST/PATCH要求application/json；所有资源路径同时校验jobId和versionId，越权404。Schema错误400 VALIDATION_ERROR带details.fields[{path,code}]，不返回输入值/原始异常；未确认发布、引用因正文编辑失效等409 INVALID_STATE；同key不同版本409 IDEMPOTENCY_CONFLICT。缺模型503 MODEL_UNAVAILABLE，缺索引目标503 INDEX_TARGET_UNAVAILABLE；无假模型兜底。模型校验失败422 MODEL_OUTPUT_INVALID、预算耗尽422 MODEL_BUDGET_EXHAUSTED。已发布岗位索引保持PENDING，S2.3处理器接入前不标READY。

本地HTTP桩不代表真实中转可用；真实模型验证按统一验收延后。公开服务认证由S3.2交付，本阶段仍只允许本地可信开发身份。

S2.1文件/证据Schema及解析边界见[文件与证据契约](resume-evidence.md)，上传/查询路由通过RESUME_API_ENABLED显式启用。

岗位、JD引用与Rubric的领域规则见[契约说明](jd-rubric.md)，上述岗位HTTP路由已由T9接入同源OpenAPI。

## 简历上传与查询（S2.1）

本地开发启用RESUME_API_ENABLED=true，并提供项目DATABASE_URL与专用绝对STORAGE_ROOT；production或非loopback拒绝启用。owner只来自IdentityPort，客户端不得指定。

| 方法与路径 | 请求/响应 |
|---|---|
| POST /api/v1/resumes | multipart唯一file字段、UUID Idempotency-Key、无查询参数；流式暂存、同步隔离解析后201返回ResumeVersionResponse |
| GET /api/v1/resumes | limit默认20、上限100，cursor不透明；createdAt DESC/id DESC；items及nextCursor |
| GET /api/v1/resumes/:resumeId/versions/:versionId | 无查询参数；版本、文件sha256/mime/size、ExtractedDocument块与警告、createdAt；越权或不存在404 |

同owner/key绑定原始字节sha256，同文件重放201返回原版本，不同文件409 IDEMPOTENCY_CONFLICT。新key新建Resume/version 1。10 MiB文件上限、PDF30页、全文200000 UTF-16单位、解析15秒；DOCX不用页数。大小超限413 PAYLOAD_TOO_LARGE；类型/签名/扫描/加密/损坏/空文本及解析资源限制422 UNSUPPORTED_FILE，reason为Schema枚举，不透传原始异常或路径。请求传输期限30秒，解析器繁忙/基础设施失败返回安全服务端错误。

详情不返回owner/storageKey/路径或语义结构化占位字段；EXTRACT属于S2.4。解析/提交前断连会中止并补偿；数据库已提交但响应丢失属于幂等重试窗口，同key可取回原版本，不能误删已引用文件。提交结果不明且无法查询数据库时保留精确manifest供对账，不宣称文件系统与数据库原子提交。

本文列出已实现的健康检查、分析任务创建、任务查询/取消、简历上传/查询及岗位HTTP接口；业务路由须显式本地启用，使用固定开发身份。报告HTTP仍为[架构设计](architecture.md#9-api调用链进度与错误)。所有接口共同遵守[接口契约规范](api-contract.md)。

新接口实现后在本文补充：路径、参数、请求与响应示例、错误码、调用链和所属阶段。

机器可读契约为[OpenAPI 3.1](openapi.json)，由 `pnpm run openapi:generate` 从相同运行时Zod Schema生成；`openapi:check`检测过期，禁止手改产物。未知查询字段、跨字段计数关系和取消事务规则见下文，不能只靠OpenAPI结构推断状态机。

## GET /health

默认地址：`http://127.0.0.1:3000/health`。

无查询参数。成功状态码200：

```json
{
  "status": "ok",
  "service": "api",
  "environment": "development"
}
```

environment来自启动配置，可为development/test/production。返回200仅表示API进程可响应，不表示PostgreSQL、RabbitMQ、Qdrant或模型服务就绪。

服务器为每个请求生成独立UUID并通过 `x-request-id` 响应头返回；不信任客户端提供的同名值。请求日志可通过该ID关联，默认不记录原始URL、查询参数、请求正文或Authorization头。

调用链：请求上下文中间件 → HealthController → ZodValidationPipe → HealthService → ConfigService → 响应。未知查询参数返回400，未知路由返回404。

## GET /api/v1/tasks/:taskId

启用方法见[本地部署](deployment.md)。设置 `TASK_API_ENABLED=true`，提供原项目业务 `DATABASE_URL`，APP_ENV仅允许development/test，HTTP_HOST仅允许127.0.0.1或::1；默认关闭时保留最小健康检查启动路径。固定开发owner为 `00000000-0000-4000-8000-000000000001`，来自IdentityPort，不接受请求中的owner或身份头，不代表已完成生产认证。

taskId为UUID，不接受查询参数。成功200，示例为尚未执行、尚无进度事件的合成分析任务：

```json
{
  "taskId": "00000000-0000-4000-8000-000000000002",
  "taskType": "ANALYSIS",
  "status": "QUEUED",
  "stage": "QUEUED",
  "progress": { "completed": 0, "total": null },
  "attempt": 0,
  "nextRetryAt": null,
  "error": null,
  "reportId": null,
  "cancelRequested": false
}
```

| 字段 | 当前语义 |
|---|---|
| taskType/status | ANALYSIS支持QUEUED/RUNNING/RETRY_WAIT/SUCCEEDED/PARTIAL/FAILED/CANCELLED；JOB_INDEX不支持PARTIAL |
| stage | 任务表真实阶段，例如SYNTHETIC_RUNNING、RECOVERY_QUEUED、SYNTHETIC_COMPLETED、CANCELLED |
| progress | 最新持久TaskEvent的completed/planned；无事件时completed=0、total=null，不按时间估算百分比；当前合成完成单位为整个任务 |
| attempt | budgetUsage中累计的实际领取次数，未开始为0，重试不归零 |
| nextRetryAt | 持久retryAt，UTC时间或null |
| error | null或安全的 `{code,message,retryable}`；错误码来自任务失败白名单，不返回原始异常。retryable表示任务已处于可恢复RETRY_WAIT，不是客户端应重发任务的指令 |
| reportId | 当前合成任务为null；JOB_INDEX始终为null，尚无报告接口 |
| cancelRequested | 取消请求是否已保存；true不等于已经到达取消终态 |

调用链：请求上下文 → TaskController/Zod校验 → TaskQueryService取得可信owner → TaskQueryRepository在同一Repeatable Read快照读取任务与事件 → 严格响应Schema。两个任务表均限定owner；资源不存在和越权同为404。输入、租约、fence、图线程、预算及原始异常均不进入响应。未知查询字段/无效UUID返回400；数据库故障返回安全500。

## POST /api/v1/tasks/:taskId/cancel

同样要求本地任务API开启。无查询参数，Content-Type为application/json，请求体为空对象 `{}`；不使用创建任务的Idempotency-Key，当前取消请求本身可重复。

成功202：

```json
{
  "taskId": "00000000-0000-4000-8000-000000000002",
  "cancelRequested": true
}
```

API仅锁定当前owner的任务行并持久化cancelRequested，不在请求内停止进程或写取消终态。非终态的重复请求返回相同202；SUCCEEDED/PARTIAL/FAILED/CANCELLED均返回409 INVALID_STATE。不存在或越权返回404，非法UUID/查询/正文或非JSON请求返回400，数据库写入失败返回安全500且不返回202。

运行消费者在心跳、节点产物、预算或完成提交边界发现取消，结束实际处理器后由当前执行权提交CANCELLED；清理尚未完成时继续持锁，不提前把“收到abort”当成停止。未执行、等待重试或已无锁的任务由消费领取/对账器处理，取消无需等未来retryAt或租约到期；对账遇到仍持锁执行继续延后。终结在一个事务中增加fence、清除租约/重试时间、结束attempt/收据并写取消事件，不把取消记成失败或发dead消息。旧执行不能再提交产物/终态，现有消息重投按终态ACK。

应继续GET轮询最终状态；如果消费会话和对账器都未运行，请求会保持待处理。取消终态不证明任意未知旧进程已经物理退出，也不授权立即删除其文件或Checkpoint。当前只验证合成任务，不保证能撤回已发生的外部模型/向量副作用。

## 错误响应

```json
{
  "code": "VALIDATION_ERROR",
  "message": "请求参数无效",
  "retryable": false,
  "requestId": "00000000-0000-4000-8000-000000000000"
}
```

上例UUID仅是格式示例；实际值与响应头一致。

| 状态 | code | 说明 |
|---|---|---|
| 400 | VALIDATION_ERROR | 请求不符合Schema，例如未知查询参数 |
| 400 | BAD_REQUEST | 请求格式错误，例如HTTP body解析失败 |
| 404 | NOT_FOUND | 不存在的路由或不可见的任务；他人任务同为404 |
| 409 | IDEMPOTENCY_CONFLICT | 已接入统一错误适配器；同幂等键对应不同任务输入。当前无任务创建HTTP入口，仅在应用服务及测试专用HTTP路由验证 |
| 409 | INVALID_STATE | 已结束任务不能请求取消 |
| 500及以上 | INTERNAL_ERROR | 安全的服务端错误，不暴露原始异常 |
| 其他HTTP异常 | HTTP_ERROR | 统一的HTTP错误表示 |

retryable仅在429/502/503/504时为true，不把所有失败都视为可重试。安全错误不包含SQL、凭证、内部路径或堆栈。测试专用失败路由不注册在实际API中。

## 启动错误

启动失败尚未提供HTTP响应；配置非法时进程输出CONFIG_INVALID与字段名并退出1。监听失败等其他启动错误输出STARTUP_FAILED，不打印原始配置值。详见[部署配置](deployment.md)。
