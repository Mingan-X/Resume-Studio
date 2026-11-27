# 接口契约规范

本文定义前后端之间所有HTTP接口共同遵守的约定。已实现的具体接口见[HTTP API](api.md)；接口分期见[开发计划](development-roadmap.md)。前端如何使用这些约定见[前端API对接文档](https://github.com/Mingan-X/Resume-Studio-Frontend/blob/main/docs/api-integration.md)。

每条约定标注状态：**已实现** 表示当前代码与测试已覆盖；**规划** 表示后续阶段必须按此实现，目前不存在。

## 1. 契约真源

- 后端 `src/contracts/` 中的Zod Schema是请求与响应结构的唯一来源。运行时校验和类型都从它派生。**已实现**（health、统一错误、任务查询/取消、简历与岗位接口）
- 由同一组Schema生成[OpenAPI 3.1产物](openapi.json)，作为前端生成类型和客户端的输入；D8采用 `@asteasolutions/zod-to-openapi`，S1.4-T9已实现生成及过期检查。生成器是开发依赖，不参与API请求处理。
- 前端只对接 [api.md](api.md) 与产物中已实现的接口，不按草案自行定义字段；字段级Zod校验与跨字段/事务业务约束仍以运行时为准。

## 2. 地址与版本

| 路径 | 用途 | 状态 |
|---|---|---|
| `/health` | 进程存活检查，不表示依赖就绪 | 已实现 |
| `/ready` | 可选数据库/业务队列就绪探针；部署代理不对公网转发 | S3.3-T7，目标环境验证待验收 |
| `/api/v1/tasks/:taskId`、`/api/v1/tasks/:taskId/cancel` | 任务查询/取消 | S1.4-T8已实现，需显式启用本地开发模式 |
| `/api/v1/resumes`及版本详情 | 上传、列表、文本证据 | S2.1已实现，本地显式启用 |
| `/api/v1/jobs`及版本/确认/发布/建议 | 岗位管理与索引任务创建 | S2.2已实现，待统一验收 |
| `/api/v1/...`其他路径 | 后续业务接口 | 规划 |

- v1内只做向后兼容的变更：新增可选请求字段、新增响应字段、新增枚举值前先确认前端已能容忍未知值。
- 删除字段、改名、改语义或改类型属于破坏性变更，必须新开版本路径，或在双方路线图中排期同步发布。
- 后端响应Schema使用 `.strict()` 约束自身输出；前端解析响应时应忽略未知字段，以便后端新增字段不会使旧前端报错。

## 3. 部署拓扑与跨域

- 生产采用同源部署：反向代理同时提供前端静态资源并把 `/api/` 与 `/health` 转发到API进程。**规划**（部署形态见决策D10）
- 本地开发由前端开发服务器把 `/api` 与 `/health` 代理到 `http://127.0.0.1:3000`。**规划**（前端F1.1）
- 后端不启用CORS。若将来确实需要跨域，使用显式来源白名单并作为单独决策记录，不使用 `*`。**已实现**（当前未启用CORS）

## 4. 数据格式

| 项目 | 约定 |
|---|---|
| 编码 | JSON，UTF-8 |
| 字段命名 | camelCase |
| ID | UUID字符串；客户端视为不透明值，不解析、不排序 |
| 时间 | ISO 8601 UTC，带 `Z`，例如 `2026-11-24T08:00:00.000Z`；前端负责本地化显示 |
| 枚举 | 大写下划线字符串，例如 `RETRY_WAIT` |
| 分数 | 后端计算并返回已确定精度的数值；前端原样显示，不重新取整或计算 |
| 费用 | 十进制字符串或最小货币单位整数，不用浮点数 |
| 空值 | `null` 表示已知为空；语义状态（如证据不足）用显式字段表达，例如 `verdict: "UNKNOWN"`，不靠字段缺失表达 |

## 5. 请求与响应头

| 头 | 方向 | 约定 | 状态 |
|---|---|---|---|
| `x-request-id` | 响应 | 服务端为每个请求生成UUID；忽略客户端提供的同名值；错误体中的requestId与之相同 | 已实现 |
| `Idempotency-Key` | 请求 | 创建任务类POST必填。客户端为每一次用户操作生成UUID，网络重试时复用同一值；同key同请求返回原结果，同key不同请求返回409 | 应用服务、简历上传与岗位发布HTTP已实现；分析创建HTTP仍规划 |
| `Content-Type` | 请求 | 取消/发布/建议接口要求 `application/json` 空对象；上传使用 `multipart/form-data` | 已实现 |
| `Cookie` / `X-CSRF-Token` | 请求 | __Host-resume_session及会话CSRF令牌，写请求同时校验精确Origin | S3.2会话模式已接入；启用/部署顺序见[认证](auth.md) |

## 6. 错误响应

S2.2新增可选details.fields（path/code，无原始值）与MODEL_UNAVAILABLE、MODEL_OUTPUT_INVALID、MODEL_BUDGET_EXHAUSTED、INDEX_TARGET_UNAVAILABLE；岗位接口实际状态码见api.md。字段校验通过运行时Zod执行，OpenAPI不能代替跨字段、owner与发布事务约束。

S2.4-T1新增ANALYSIS_UNAVAILABLE（503）：服务端未配置分析输入配置。创建接口的资源不可见404、同幂等键不同正文409、配置版本内容冲突409，均不返回内部配置或原始异常。

当前结构（**已实现**）：

```json
{
  "code": "VALIDATION_ERROR",
  "message": "请求参数无效",
  "retryable": false,
  "requestId": "00000000-0000-4000-8000-000000000000"
}
```

`details.fields`已实现，仅包含字段path/code，不包含原始输入值；具体code来自运行时校验。`taskId`（与任务相关的错误）仍为规划字段。

- `message` 是可直接展示给用户的安全文案，不包含SQL、凭证、内部路径或堆栈。
- 客户端按 `code` 分支处理，不解析 `message`。
- `retryable` 只在429/502/503/504时为true；客户端只对 `retryable: true` 自动重试。

| 状态 | code | 含义 | 状态 |
|---|---|---|---|
| 400 | VALIDATION_ERROR | 请求不符合Schema | 已实现 |
| 400 | BAD_REQUEST | 请求格式错误，如JSON解析失败 | 已实现 |
| 404 | NOT_FOUND | 路由或资源不存在；越权访问他人资源也返回404，不暴露资源是否存在 | 已实现（路由及任务） |
| 500及以上 | INTERNAL_ERROR | 安全的服务端错误 | 已实现 |
| 其他 | HTTP_ERROR | 其他HTTP异常 | 已实现 |
| 401 | UNAUTHENTICATED | 未登录或会话过期 | S3.2已实现 |
| 403 | FORBIDDEN | CSRF/Origin校验拒绝 | S3.2已实现 |
| 409 | DATA_DELETION_PENDING | 删除屏障生效，暂不能创建或修改业务数据 | S3.2已实现 |
| 409 | IDEMPOTENCY_CONFLICT | 同一所有者及任务类型下，同幂等键对应不同请求 | 已实现应用服务、简历上传及岗位发布HTTP错误映射 |
| 409 | INVALID_STATE | 已结束任务不允许再请求取消 | 已实现（S1.4-T8） |
| 413 | PAYLOAD_TOO_LARGE | 上传超出大小限制；reason=FILE_TOO_LARGE | S2.1已接线 |
| 422 | UNSUPPORTED_FILE | 文件类型、签名或内容不受支持（含扫描PDF、加密文件）；reason说明原因 | S2.1已接线 |
| 429 | RATE_LIMITED | 请求过于频繁 | S3.2已实现 |

规划中的错误码在实现时可以调整名称，但必须先更新本表和 `src/contracts/`，前端再据此对接。

## 7. 异步任务

S3.1补充：新任务通过SAVE/完成事务提交不可变报告后才SUCCEEDED/PARTIAL，reportId有效；历史无reportVersion任务保留旧语义。SSE及报告/重算/选择列表已接入，具体已实现字段和限制见[报告接口](reports.md)。下文S3.1前临时说明属于旧任务兼容边界。

分析与索引都是长任务，HTTP请求不在进程内执行它们。查询/取消、分析创建、显式业务消费图、报告与SSE均已实现，仍使用本地开发身份。创建字段与错误见[API](api.md)及[分析输入](analysis-input.md)。历史无reportVersion分析的成功/部分成功只指产物提交，reportId仍可null，前端不得把它当已生成报告。MATCH及最终事件计数单位按阶段区分，不能换算伪百分比。

1. 创建：`POST` 返回 `202`，响应体含 `taskId` 与 `statusUrl`。
2. 查询：`GET /api/v1/tasks/:taskId` 返回 `taskId`、`taskType`（ANALYSIS/JOB_INDEX）、`status`、`stage`、`progress: {completed, total}`（总量未知时 `total` 为null）、累计领取次数 `attempt`、`nextRetryAt`、`error`（任务错误白名单及安全文案）、`reportId`、`cancelRequested`。不返回owner/输入/租约/fence/图线程。当前合成任务无报告。
3. 状态枚举：AnalysisTask为 `QUEUED`、`RUNNING`、`RETRY_WAIT`、`SUCCEEDED`、`PARTIAL`、`FAILED`、`CANCELLED`；JobIndexTask没有 `PARTIAL`。定义见[架构 §6.2](architecture.md#62-分工与状态机)。
4. 轮询：建议间隔2秒；到达终态后停止；请求失败时按指数退避，只在 `retryable` 为true时继续。
5. SSE（S3.1）：`GET /api/v1/tasks/:taskId/events`，事件 `id` 为TaskEvent的单调 `seq`，断线后用 `Last-Event-ID` 补读。SSE只是持久化事件的传输方式，断线不影响任务。
6. 取消：`POST /api/v1/tasks/:taskId/cancel` 接收application/json空对象，无查询参数；202返回 `{taskId,cancelRequested:true}`，仅证明请求持久化。非终态重复请求仍202；终态（含已取消）返回409 INVALID_STATE。消费者/对账器在安全边界提交CANCELLED，最终状态以GET为准；没有运行执行/对账进程时会保持待处理。
7. 进度只反映真实阶段和计数，不提供估算的等速百分比。

开发身份只来自服务端IdentityPort，不能由请求字段/头选择owner。任务API默认关闭，启用时限制development/test及loopback监听，生产认证仍由S3.2交付。任务状态内的error.retryable表示该任务已安排可恢复重试；HTTP错误体的retryable仍按§6状态码规则，不据此重新创建任务。

## 8. 列表与分页

**简历列表已实现，其他列表按阶段接入**：列表接口使用游标分页，请求 `?limit=20&cursor=<不透明字符串>`，响应 `{"items":[...],"nextCursor":"..."}`，`nextCursor` 为null表示没有更多。`limit` 上限100。排序字段与方向通过显式参数指定，默认排序在接口文档中写明。

## 9. 文件上传

**S2.1-T8已接线，阶段回归中**：`multipart/form-data`，唯一文件字段名 `file`，UUID Idempotency-Key必填。同owner/key绑定原始文件sha256，同字节返回原版本201，不同字节409；新key创建新Resume/version 1。同步解析成功才201，文件大小超限413，格式/签名/扫描/加密/损坏/空文本及解析限制422并带安全reason；不创建异步解析任务。大小上限10 MiB，30页仅适用于PDF；DOCX按文本量限制。客户端检查只用于提前提示；服务端校验签名并生成存储名，不使用客户端文件名作为路径。[Schema与解析边界](resume-evidence.md)已同步OpenAPI；PDF提供页码、DOCX提供段落/表格来源，详情不返回语义结构化占位字段。错误响应新增可选reason（仅文件失败），不含原始内容。

## 10. 报告与评分

[岗位与Rubric领域契约](jd-rubric.md)定义六维ID、JD引用及权重校验；岗位HTTP接口已由S2.2-T9接入同源OpenAPI。

**规划**（S2.5、S3.1）

- 后端返回展示所需的全部计算结果：分数、每项贡献、coverage、upperBound、eligibility、逐项verdict与证据引用。前端不计算、不重排、不补全分数。
- `UNKNOWN`（证据不足）与 `UNMET`（明确不满足）是不同状态，接口分别返回，前端分别展示。
- `PARTIAL` 报告附带计划数、已完成数、未完成数和原因。
- 调权重算生成新的报告revision并返回新ID，原报告不变。
- 证据引用中的 `quote` 是用户简历原文，属于不可信数据，前端只能按纯文本渲染。

## 11. 契约变更流程

1. 修改 `src/contracts/` 中的Schema和对应实现与测试。
2. 更新 [api.md](api.md)；涉及本文约定时同步更新本文。
3. 执行 `pnpm run openapi:generate` 并提交 `docs/openapi.json`；`pnpm run openapi:check`及CI检测缺失/过期产物，不自动覆盖。
4. 破坏性变更在后端与前端路线图中各建任务，标明发布顺序。
5. 在[开发进度](progress.md)记录变更。
