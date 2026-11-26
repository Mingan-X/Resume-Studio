# 接口契约规范

本文定义前后端之间所有HTTP接口共同遵守的约定。已实现的具体接口见[HTTP API](api.md)；接口分期见[开发计划](development-roadmap.md)。前端如何使用这些约定见[前端API对接文档](https://github.com/Mingan-X/Resume-Studio-Frontend/blob/main/docs/api-integration.md)。

每条约定标注状态：**已实现** 表示当前代码与测试已覆盖；**规划** 表示后续阶段必须按此实现，目前不存在。

## 1. 契约真源

- 后端 `src/contracts/` 中的Zod Schema是请求与响应结构的唯一来源。运行时校验和类型都从它派生。**已实现**（仅health与错误响应）
- 由同一组Schema生成OpenAPI文档，作为前端生成类型和客户端的输入。工具选择见决策D8，交付任务为S1.4-T9。**规划**
- OpenAPI产物生成之前，前端只对接 [api.md](api.md) 中已实现的接口，不按草案自行定义字段。

## 2. 地址与版本

| 路径 | 用途 | 状态 |
|---|---|---|
| `/health` | 进程存活检查，不表示依赖就绪 | 已实现 |
| `/api/v1/...` | 全部业务接口 | 规划 |

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
| `Idempotency-Key` | 请求 | 创建任务类POST必填。客户端为每一次用户操作生成UUID，网络重试时复用同一值；同key同请求返回原结果，同key不同请求返回409 | S1.4-T2已实现应用服务及409错误映射；创建HTTP入口仍规划 |
| `Content-Type` | 请求 | JSON接口为 `application/json`；上传为 `multipart/form-data` | 规划 |
| `Cookie` / `X-CSRF-Token` | 请求 | 会话Cookie与CSRF令牌，具体方案见决策D9 | 规划（S3.2） |

## 6. 错误响应

当前结构（**已实现**）：

```json
{
  "code": "VALIDATION_ERROR",
  "message": "请求参数无效",
  "retryable": false,
  "requestId": "00000000-0000-4000-8000-000000000000"
}
```

规划扩展字段：`taskId`（与任务相关的错误）和 `details`（字段级错误，形如 `{"fields":[{"path":"weights.techDepth","code":"NEGATIVE"}]}`）。`details` 不包含原始输入值。

- `message` 是可直接展示给用户的安全文案，不包含SQL、凭证、内部路径或堆栈。
- 客户端按 `code` 分支处理，不解析 `message`。
- `retryable` 只在429/502/503/504时为true；客户端只对 `retryable: true` 自动重试。

| 状态 | code | 含义 | 状态 |
|---|---|---|---|
| 400 | VALIDATION_ERROR | 请求不符合Schema | 已实现 |
| 400 | BAD_REQUEST | 请求格式错误，如JSON解析失败 | 已实现 |
| 404 | NOT_FOUND | 路由或资源不存在；越权访问他人资源也返回404，不暴露资源是否存在 | 已实现（路由）；资源部分规划 |
| 500及以上 | INTERNAL_ERROR | 安全的服务端错误 | 已实现 |
| 其他 | HTTP_ERROR | 其他HTTP异常 | 已实现 |
| 401 | UNAUTHENTICATED | 未登录或会话过期 | 规划（S3.2） |
| 403 | FORBIDDEN | 已登录但无权执行该操作 | 规划（S3.2） |
| 409 | IDEMPOTENCY_CONFLICT | 同一所有者及任务类型下，同幂等键对应不同请求 | 已实现应用服务与HTTP错误映射；任务HTTP入口规划 |
| 409 | INVALID_STATE | 资源当前状态不允许该操作，如取消已结束任务 | 规划（S1.4） |
| 413 | PAYLOAD_TOO_LARGE | 上传超出大小限制 | 规划（S2.1） |
| 422 | UNSUPPORTED_FILE | 文件类型、签名或内容不受支持（含扫描PDF、加密文件） | 规划（S2.1） |
| 429 | RATE_LIMITED | 请求过于频繁 | 规划 |

规划中的错误码在实现时可以调整名称，但必须先更新本表和 `src/contracts/`，前端再据此对接。

## 7. 异步任务

分析与索引都是长任务，HTTP请求只负责创建和查询。**规划**（S1.4、S3.1）

1. 创建：`POST` 返回 `202`，响应体含 `taskId` 与 `statusUrl`。
2. 查询：`GET /api/v1/tasks/:taskId` 返回 `status`、`stage`、`progress: {completed, total}`（总量未知时 `total` 为null）、`attempt`、`nextRetryAt`、`error`（安全错误对象）、`reportId`。
3. 状态枚举：AnalysisTask为 `QUEUED`、`RUNNING`、`RETRY_WAIT`、`SUCCEEDED`、`PARTIAL`、`FAILED`、`CANCELLED`；JobIndexTask没有 `PARTIAL`。定义见[架构 §6.2](architecture.md#62-分工与状态机)。
4. 轮询：建议间隔2秒；到达终态后停止；请求失败时按指数退避，只在 `retryable` 为true时继续。
5. SSE（S3.1）：`GET /api/v1/tasks/:taskId/events`，事件 `id` 为TaskEvent的单调 `seq`，断线后用 `Last-Event-ID` 补读。SSE只是持久化事件的传输方式，断线不影响任务。
6. 取消：`POST /api/v1/tasks/:taskId/cancel` 只写入取消请求，任务在安全边界停止，最终状态以查询结果为准。
7. 进度只反映真实阶段和计数，不提供估算的等速百分比。

## 8. 列表与分页

**规划**：列表接口使用游标分页，请求 `?limit=20&cursor=<不透明字符串>`，响应 `{"items":[...],"nextCursor":"..."}`，`nextCursor` 为null表示没有更多。`limit` 上限100。排序字段与方向通过显式参数指定，默认排序在接口文档中写明。

## 9. 文件上传

**规划**（S2.1）：`multipart/form-data`，文件字段名 `file`。大小与页数上限由服务端配置（建议10 MiB、30页），并通过接口或文档告知前端。客户端检查扩展名和大小只用于提前提示；服务端始终校验内容签名并生成存储名，不使用客户端文件名作为路径。

## 10. 报告与评分

**规划**（S2.5、S3.1）

- 后端返回展示所需的全部计算结果：分数、每项贡献、coverage、upperBound、eligibility、逐项verdict与证据引用。前端不计算、不重排、不补全分数。
- `UNKNOWN`（证据不足）与 `UNMET`（明确不满足）是不同状态，接口分别返回，前端分别展示。
- `PARTIAL` 报告附带计划数、已完成数、未完成数和原因。
- 调权重算生成新的报告revision并返回新ID，原报告不变。
- 证据引用中的 `quote` 是用户简历原文，属于不可信数据，前端只能按纯文本渲染。

## 11. 契约变更流程

1. 修改 `src/contracts/` 中的Schema和对应实现与测试。
2. 更新 [api.md](api.md)；涉及本文约定时同步更新本文。
3. OpenAPI产物可用后重新生成并提交。
4. 破坏性变更在后端与前端路线图中各建任务，标明发布顺序。
5. 在[开发进度](progress.md)记录变更。
