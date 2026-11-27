# 开发计划

本文是后端阶段划分、任务拆分和验收标准的唯一来源。每个阶段的完成情况记录在[开发进度](progress.md)；前端计划见[前端路线图](https://github.com/Mingan-X/Resume-Studio-Frontend/blob/main/docs/development-roadmap.md)。未标记为“已完成”的内容都不是已交付能力。

## 1. 阶段总览

阶段编号同时用于分支命名（`feature/s1.3-<功能名>`，见[CONTRIBUTING](../CONTRIBUTING.md)）。

| 阶段 | 名称 | 主要交付 | 依赖 | 阻塞决策 | 状态 |
|---|---|---|---|---|---|
| S1.1 | 工程基线 | 依赖锁定、ESM/装饰器编译、类型检查/Lint/测试、API与空Worker入口、Zod配置、统一HTTP错误、requestId日志 | — | — | 已完成 |
| S1.2 | 基础设施诊断 | Compose项目隔离、PostgreSQL/Prisma诊断表与迁移、RabbitMQ confirm/return/ACK、Qdrant CRUD、重启持久化工具 | S1.1 | — | 已完成 |
| S1.3 | 工作流持久化与观测 | 官方PostgreSQL Checkpointer接入与恢复验证、OTel/Langfuse接入与脱敏 | S1.2 | D4 已确定本地自托管 | 已完成（2026-11-25，附已知环境限制L1） |
| S1.4 | 任务与消息可靠性 | 两类任务、Outbox、消费收据、租约/fence、重试/DLQ、对账、任务查询/取消API | S1.3 | D8已落实 | 已完成（2026-11-26，附已知环境限制L2） |
| S2.1 | 简历文件与证据 | Storage、上传、PDF/DOCX解析、文本块与引用、ParsedResume契约与校验 | S1.4 | D6、D11（2026-11-27已确定） | 待验收 |
| S2.2 | JD与Rubric | JD草稿/结构化/确认/不可变发布、JobIndexTask、六维Rubric版本 | S1.4 | D1、D2（2026-11-27已确定） | 待验收 |
| S2.3 | 岗位召回 | 技能关键词、Qdrant索引、Dense Vector、RRF融合、CandidateSet | S2.2 | D3（2026-11-27已确定） | 待验收 |
| S2.4 | 六维画像与逐项匹配 | 简历语义结构化（EXTRACT）、Profile/Matching节点、结构化判断、预算与部分失败 | S2.1、S2.3 | D1、D2（2026-11-27已确定） | 待验收 |
| S2.5 | 确定性评分与排名 | 评分纯函数、冻结判断、Top10、调权重算 | S2.4 | D7（2026-11-27已确定） | 待验收 |
| S3.1 | 报告与进度API | 报告快照与历史、TaskEvent进度、SSE、前端所需全部查询接口 | S2.5 | — | 待验收 |
| S3.2 | 身份、权限与数据生命周期 | 登录、所有权检查、保留与删除链路 | S3.1 | D9、D7（2026-11-27已确定） | 待验收 |
| S3.3 | 质量评测与发布准备 | 标注评测集、故障注入、备份恢复、依赖审计、部署方案 | S3.2 | D10（2026-11-27已确定） | 进行中 |

S1.1与S1.2是同一次初始化提交交付的基线，没有独立历史分支；它们的验证证据见[开发进度](progress.md)。资源名中的 `s12` 即 S1.2 诊断阶段的标识，为兼容已应用迁移而保留。

状态只使用：未开始、进行中、待验收、已完成、已搁置。状态变化必须同时更新本表和[开发进度](progress.md)。

## 2. 任务规范

2026-11-26起，按维护者要求，S2.1至S3.3全部拆分到任务级（见§5）。为避免远期计划与实际实现脱节，每个阶段开始时仍须对照当时的代码、已合并契约和已确认决策复核该阶段任务；需要调整编号、依赖、产出或验收时，先在progress记录原因并请维护者确认，不在实现中自行改写。

每个任务写明：

- **编号**：`<阶段>-T<序号>`，例如 `S1.3-T2`。
- **目标**：一句话说明交付什么。
- **依赖**：前置任务或决策编号。
- **产出**：新增或修改的模块、迁移、脚本、接口和文档。
- **验收**：可通过测试或命令核对的行为，包括故障边界。
- **检查**：需要运行的命令；涉及真实服务时包含 `pnpm run test:integration`。

任务完成的定义（Definition of Done）：

1. 验收条件全部有对应测试或可复核的运行记录。
2. `pnpm run typecheck`、`pnpm run lint`、`pnpm test` 通过；涉及真实服务时集成测试通过。
3. 依赖变化同步提交锁文件，并在[依赖说明](dependency-compatibility.md)更新已验证版本。
4. 接口变化同步更新[HTTP API](api.md)；契约规则变化同步更新[接口契约规范](api-contract.md)。
5. 在[开发进度](progress.md)追加记录：完成内容、验证命令与结果、未执行项及原因。

## 3. S1.3 工作流持久化与观测

目标：用合成图验证官方Checkpointer与观测链路，不依赖真实简历、模型服务或业务任务表。

范围调整说明：原计划把“旧执行fence隔离、新恢复thread”放在本阶段，但这些验收需要AnalysisTask的租约、fenceToken和activeGraphThreadId，而这些字段在S1.4才建立。因此该部分移到 [S1.4-T7](#4-s14-任务与消息可靠性)。本阶段的恢复部分只验证Checkpointer自身的初始化、续跑和权限隔离；观测部分按T4/T5验证关联、脱敏及故障隔离。

| 任务 | 目标 | 依赖 | 产出 | 验收 |
|---|---|---|---|---|
| S1.3-T1 | 接入LangGraph与Checkpointer依赖 | — | 精确版本的 `@langchain/langgraph`、`@langchain/core`、`@langchain/langgraph-checkpoint-postgres` 及锁文件；依赖说明更新 | 接入前重新核对registry的engines/peers（[候选版本](dependency-compatibility.md#3-兼容约束与待接入候选)为2026-11-23数据）；冻结安装、编译、Lint通过；不忽略peer冲突 |
| S1.3-T2 | Checkpointer独立schema、账号与受控setup | T1 | 独立schema与最小权限账号的provision脚本；显式setup命令（不在请求路径建表）；独立连接池配置 | 首次setup成功；重复setup不报错不重复建表；业务账号无法读写Checkpoint表，Checkpoint账号无法读写业务表；两个池的上限计入连接预算 |
| S1.3-T3 | 合成图续跑验证 | T2 | 测试专用合成StateGraph（不注册到生产Worker）及集成测试 | 中途终止后用原thread_id与 `invoke(null, config)` 续跑，已完成节点不重复执行；首个Checkpoint不存在时，依据单独保存的合成输入重新启动且不丢请求；GraphState只含可序列化ID与结构化数据 |
| S1.3-T4 | OTel与Langfuse接入 | T1、D4 | ObservabilityModule、Langfuse回调与OTel span、配置Schema | Langfuse SDK与服务端版本兼容；合成图运行时收到含correlationId的关联span；OTel依赖满足Langfuse要求的2.x线 |
| S1.3-T5 | 观测故障隔离与脱敏 | T4 | 有界缓冲与脱敏处理、故障测试 | Langfuse不可用时合成图仍成功并记录观测丢失指标；含合成手机号/邮箱/密钥的输入不出现在上报数据中 |
| S1.3-T6 | 文档与进度 | T1–T5 | 依赖说明、架构、测试、部署文档与进度记录 | 文档只描述已验证行为；未执行项如实记录 |
| S1.3-T7 | 验收遗留修复 | T1–T6 | 见下方“S1.3-T7 任务说明” | 见下方“S1.3-T7 任务说明” |

2026-11-25重新验收：T1–T7.4通过；T7.5中构建后首次 `pnpm test` 的有效配置API启动用例超过8秒失败，判定为本机机械硬盘冷启动造成的环境限制。维护者决定接受S1.3并记录为已知环境限制L1，在部署服务器或硬件满足条件后重新验证（已加入S3.3验收要求）。验收记录、L1的判断依据与处理规则见[开发进度](progress.md)。D4采用同一resume-studio项目的observability profile，专属网络、账号和数据卷，显式服务列表独立启停。feature/s1.3-checkpoint-setup已推送；2026-11-25开始S1.4前fetch确认远端master通过PR #1合并，合并提交17d4002。

### S1.3 验收证据索引

表中“已实现”描述分支工作，不表示已通过阶段验收或已合并。T6不修改T1–T5的行为，也不以历史通过覆盖最近失败。

| 任务 | 实现/配置入口 | 对应验证 | 当前边界 |
|---|---|---|---|
| T1 | [依赖清单](../package.json)、[锁文件](../pnpm-lock.yaml)、[补丁配置](../pnpm-workspace.yaml) | [依赖说明](dependency-compatibility.md)及既有冻结安装记录 | 已接入；T6核对本地版本，不重新选型或安装 |
| T2 | [受控provision/setup](../src/infrastructure/checkpoint/admin.ts)、[独立池](../src/infrastructure/checkpoint/store.ts) | [Checkpoint集成测试](../test/integration/checkpoint.test.ts)：重复setup、权限、池上限/关闭 | 已验证合成环境，未接入业务Worker |
| T3 | [恢复子进程](../test/integration/checkpoint-worker.fixture.ts) | 同一Checkpoint集成测试：强杀、确认退出、续跑/从独立输入重启 | 不含旧执行fence隔离，后者仍属S1.4-T7 |
| T4 | [观测模块](../src/infrastructure/observability/observability.module.ts)、[Compose配置](../infra/compose.observability.yaml) | [真实Langfuse测试](../test/integration/observability.test.ts)：服务端读回、关联、父子span | 已验证合成图，未接入真实模型或跨进程trace |
| T5 | [白名单脱敏](../src/infrastructure/observability/privacy.ts)、[有界导出](../src/infrastructure/observability/exporter.ts) | [观测故障测试](../test/observability.test.ts)、[真实停机记录](progress.md) | 已有专项证据，未承诺可靠投递或长期负载 |
| T6 | 依赖、架构、测试、部署文档与[本次进度](progress.md) | 链接/锚点/命令/版本/修改边界检查及本次工程检查 | 历史结果保留；最新验收以progress为准 |
| T7 | 入口拆分、独立启动错误、模块加载测试、Qdrant归属/对账清理及文档 | 见下方T7.1–T7.5与[进度记录](progress.md) | 保留原超时/断言；提交后进行连续回归 |

### S1.3-T7 任务说明

目标：修复2026-11-25阶段验收的阻塞项，使S1.3满足“任务完成的定义”并可合并。依据见[验收记录](progress.md)与[专项排查](research/failure-diagnosis-2026-11-25.md)。在当前分支 `feature/s1.3-checkpoint-setup` 上进行。

| 子任务 | 目标 | 产出 | 验收 |
|---|---|---|---|
| T7.1 | 入口先校验配置再加载应用 | `main-api.ts`、`main-worker.ts` 先用只依赖Zod的配置模块校验，通过后再 `await import()` 对应的创建函数；拆分 `bootstrap.ts`，API与Worker各自只导入自己的模块树；启动失败报告函数移到不依赖Nest或 `AppLogger` 的独立模块 | `process.test.ts` 原有断言与10秒/8秒限制不变；新增测试：用Node 24 `module.registerHooks` 预加载脚本记录已加载模块，断言缺配置路径不加载任何 `@nestjs/*`；有效配置下API/Worker启动、关闭与日志事件不变 |
| T7.2 | Qdrant测试的“创建结果未知”清理 | `infrastructure.test.ts` 在create失败或超时后进入有界对账：在固定期限内轮询存在性，出现即删除；期限内仍无法确认时，把本轮集合名写入 `data/` 下的manifest并让测试明确失败。删除前核对Qdrant容器的Compose项目、服务、端口与卷标签 | 用本地可控延迟的HTTP桩复现“客户端超时 → 首次查询不存在 → 服务端迟到创建 → 最终被删除”；真实Qdrant运行后 `s12_*` 残留为0；只删除本轮精确名称，不按前缀批量删除 |
| T7.3 | 文档去除易过期的计数 | README、ADR-0001、架构、部署文档中不再写具体的通过/失败数量，改为链接[开发进度](progress.md)；[测试文档](testing.md#当前验收状态)的“当前验收状态”只指向最新进度记录 | 除progress.md外，文档不复制具体通过/失败运行计数；链接与锚点有效 |
| T7.4 | 分任务提交 | 按T1–T7分别提交（可把紧密相关的任务合并为一个提交），说明格式 `S1.3-T2 增加Checkpointer独立schema与受控setup`；凭证、`data/`、`dist/`、生成目录不入库 | `git status` 干净；`git log` 能对应到任务编号。不推送、不合并，合并由维护者在重新验收后进行 |
| T7.5 | 回归与记录 | 在progress.md追加T7记录 | 提交后在同一环境连续运行 `pnpm test` 3次、`pnpm run test:integration` 2次，全部通过；记录每次的通过数与耗时、Qdrant残留检查结果。任一次失败如实记录，不以重跑通过覆盖 |

不在T7范围：

- 迁移Docker数据盘或项目到SSD（环境事项，另行安排）。
- 提高测试或客户端超时、跳过或放宽断言、关闭兼容性检查、把持久化卷改为tmpfs。
- `ObservabilityService` 的全局provider生命周期问题（已记录为非阻塞观察，接入业务进程时处理）。

T7完成后将阶段状态改为“待验收”，由维护者重新验收。

## 4. S1.4 任务与消息可靠性

目标：两类任务（AnalysisTask、JobIndexTask）共享交付、幂等和fencing机制，但业务状态独立。本阶段只建立任务基础设施和合成任务契约，不实现简历或岗位业务。设计依据见[架构 §5–§6](architecture.md#5-rabbitmqoutbox与任务一致性)。

| 任务 | 目标 | 依赖 | 产出 | 验收 |
|---|---|---|---|---|
| S1.4-T1 | 开发期身份适配与任务数据模型 | — | 开发单用户IdentityModule（固定ownerId，接口可替换）；AnalysisTask、JobIndexTask、TaskAttempt、TaskEvent、OutboxEvent、ConsumerReceipt、Quarantine的Prisma模型与迁移 | 迁移可重复部署；唯一约束与状态字段符合[架构 §6.1](architecture.md#61-实体与约束)；所有查询显式带ownerId |
| S1.4-T2 | 任务创建事务与幂等键 | T1 | 应用服务：同事务写任务、输入快照、OutboxEvent；Idempotency-Key与requestHash绑定 | 同key同请求返回原taskId；同key不同请求返回409；事务回滚时不留Outbox |
| S1.4-T3 | Outbox发布器与业务拓扑 | T1 | 租约领取（`FOR UPDATE SKIP LOCKED`）、confirm+mandatory+return、有界退避；`resume.tasks` 交换机、quorum队列、DLX策略 | return/nack/超时/断连都不标published；confirm后标记前崩溃会重复发布且被消费端吸收；多发布器不同时领取同一事件 |
| S1.4-T4 | 消费者、收据、租约与fence | T3 | 手动ACK消费者、ConsumerReceipt、条件更新领取租约、单调fenceToken、心跳 | 重复投递不重复产出；终态或过期generation直接ACK；旧token的写入被拒绝；数据库不可写时不ACK |
| S1.4-T5 | 重试、死信与隔离区 | T4 | RETRY_WAIT+延迟Outbox、失败分类、dead事件、Quarantine | 重试次数和总预算有界且跨尝试累计；不可恢复错误进入FAILED并可靠发dead事件；无法解码的消息进入Quarantine |
| S1.4-T6 | 对账器 | T4 | 定时扫描过期租约、未发布事件、无终态任务 | 过期RUNNING被恢复调度；不抢占仍持有锁的执行 |
| S1.4-T7 | Checkpoint与业务fence联合隔离（自S1.3移入） | T4、S1.3-T3 | session advisory lock、graphGeneration与activeGraphThreadId切换、真实Worker/PostgreSQL故障测试 | 暂停旧执行并使锁/租约失效后启动新执行，再恢复旧执行：旧token不能提交产物或终态；无法确认旧执行停止时新执行使用新thread，旧Checkpoint迟到写入不影响新thread；确认旧执行结束才复用原thread。JobIndexTask旧执行不能更新新版本状态。不能用mock token或普通重启代替 |
| S1.4-T8 | 任务查询与取消API | T4 | `GET /api/v1/tasks/:taskId`、`POST /api/v1/tasks/:taskId/cancel`，契约见[接口契约规范](api-contract.md) | owner检查；返回真实stage与计数；取消在安全边界生效，终态不被迟到Worker改回 |
| S1.4-T9 | OpenAPI契约生成 | T8、D8 | 由Zod契约生成OpenAPI文档的脚本与提交的产物 | 生成结果与运行时校验使用同一组Schema；CI可检测产物过期 |
| S1.4-T10 | 文档与进度 | T1–T9 | 架构、API、测试文档与进度记录 | 同上 |

2026-11-26：`feature/s1.4-task-foundation` 已实现T1–T10。按维护者授权一起开发T8–T10，仍分别提交：本地开发身份下查询真实任务阶段/计数、请求取消及安全边界终结；由 `@asteasolutions/zod-to-openapi` 生成同源OpenAPI并检测过期；同步架构、API、部署、测试与进度。T7真实旧Worker暂停/迟到saver写入隔离保持回归。默认Docker全量仍有Qdrant创建超时，不满足“完整回归通过”的完成定义，阶段保持“进行中”，不自行宣布验收通过；原生对照与全部实际结果见[开发进度](progress.md)。任务编号、范围、依赖、验收条件保持原样，无S2功能或新规划任务；未推送、未合并。

2026-11-26阶段验收：对5b02616复核，类型检查、Lint、基础测试、openapi:check、迁移状态及远端CI通过；默认Docker全量集成仅Qdrant集合创建超时失败，原生Qdrant对照全部通过。维护者决定接受S1.4，剩余失败记录为已知环境限制L2，在部署服务器或硬件满足条件后重新验证（已加入S3.3验收要求）。验收记录、L2的判断依据与处理规则见[开发进度](progress.md)。5b02616已通过PR #2合并到master（合并提交736c8d5）；本验收记录在同一分支追加提交并推送，需另行合并。

当前S1.4交接索引（合成任务基础设施，不代表简历/岗位业务已交付）：

| 任务 | 实现与验证入口 | 主要边界 |
|---|---|---|
| T1/T2 | [任务创建服务](../src/modules/tasks/task-creation.service.ts)、[模型](../prisma/schema.prisma)、[真实事务测试](../test/integration/tasks.test.ts) | 固定开发身份和合成版本ID，无创建HTTP/生产认证 |
| T3 | [Outbox发布器](../src/infrastructure/outbox/outbox.publisher.ts)、[故障测试](../test/integration/outbox.test.ts) | 至少一次交付；独立publisher confirm与消费者ACK |
| T4/T5 | [消费处理器](../src/infrastructure/consumer/task-delivery.handler.ts)、[重试测试](../test/integration/retry.test.ts) | 租约/fence、持久收据、跨尝试预算与隔离区；无真实模型副作用保证 |
| T6 | [定时对账](../src/infrastructure/reconciliation/reconciliation.service.ts)、[锁与恢复测试](../test/integration/reconciliation.test.ts) | 显式once/watch、固定owner，持锁不抢占 |
| T7 | [官方合成图](../src/infrastructure/checkpoint/task-handler.ts)、[真实暂停/恢复测试](../test/integration/checkpoint-fence.test.ts) | 未知旧执行换thread；确认停止才复用；合成索引目标替身 |
| T8 | [HTTP契约](../src/contracts/task-api.ts)、[控制器](../src/modules/tasks/task.controller.ts)、[真实HTTP测试](../test/integration/task-api.test.ts) | 显式本地启用；202只保存请求，消费者/对账器安全终结 |
| T9 | [生成脚本](../scripts/openapi.mjs)、[产物](openapi.json)、[过期检查](../test/openapi.test.ts)、[CI](../.github/workflows/check.yml) | 文档生成开发依赖；远端CI须推送后另验，不替代真实集成 |
| T10 | [架构](architecture.md)、[接口](api.md)、[部署](deployment.md)、[测试](testing.md)、[进度](progress.md) | 保留失败/未执行项；阶段验收和后续S2启动由维护者确认 |

## 5. 后续阶段交付与验收

下表是各阶段的交付与验收要求；任务拆分、执行顺序与停止条件见本节后续小节。S2.1于2026-11-26进入准备阶段，“进行中”仅表示已启动范围梳理，尚无业务代码交付。

| 阶段 | 交付内容 | 验收要求 |
|---|---|---|
| S2.1 简历文件与证据 | StoragePort与本地实现、`POST /api/v1/resumes` 上传、简历列表与版本详情接口、文件签名/大小校验、PDF/DOCX文本块、ParsedResume契约与引用校验（语义抽取执行见S2.4） | 正常、损坏、加密、扫描、双栏、表格样本；无任意路径读写；引用可逐字核对；空文本不算成功；多任务不串数据；DOCX/ZIP解压总量、条目数、压缩比、路径穿越限制；解析CPU/内存/总耗时上限。扫描PDF明确拒绝或提示不支持，首版不承诺OCR |
| S2.2 JD与Rubric | JD入库与结构化、要求确认、不可变版本、发布事务内创建JobIndexTask与Outbox、六维Rubric版本；岗位草稿、确认、发布与列表接口 | 要求来源可追踪；硬门槛和权重确认后才发布；旧索引执行不能把新版本标为READY；所有权检查 |
| S2.3 岗位召回 | 技能字典与关键词召回、Qdrant索引、Dense Vector、RRF融合、CandidateSet冻结 | 至少100条合成JD；索引幂等；旧版本不混入；维数变化建新collection；中文技能相关性标注；向量失败显式降级 |
| S2.4 六维画像与逐项匹配 | 简历语义结构化EXTRACT节点（产出ParsedResume，经S2.1校验器校验）、Profile与Matching节点、结构化判断、预算控制与部分失败；分析任务创建接口 `POST /api/v1/analyses` | 抽取只读取授权简历版本的已存文本块，缺失信息为null/空数组且不编造，简历中的指令只视为数据；抽取产物按resumeVersionId及prompt/model/schema版本复用，不按taskId重复调用；六维只作辅助上下文；逐要求基于证据判断；unknown不伪装成低分；计划内要求都有结果或未完成状态；400条默认预算超限时返回截断与未完成数量；模型不输出总分；拒绝伪造或越界引用；并发受限 |
| S2.5 确定性评分与排名 | 评分纯函数、冻结判断、Top10、调权重算 | 固定输入重复100次结果一致；缺失/负数/NaN/Infinity/零总权重/重复ID/不支持维度/同分/unknown边界；重算不调用模型；原候选第11名可进入新榜单；不足10条不补造 |
| S3.1 报告与进度API | 报告快照与历史、TaskEvent、SSE、调权重算接口、前端所需列表与详情接口 | 报告关联输入、结构化简历、候选、画像与匹配判断、Rubric与评分版本；刷新、断网、重启后仍可查；PARTIAL显示覆盖率；SSE按seq补读；API返回前端展示所需的全部计算结果，前端不自行计算分数 |
| S3.2 身份、权限与数据生命周期 | 登录与会话、资源所有权检查、保留期限、用户数据删除 | 未登录与越权访问被拒绝；删除覆盖文件、产物、Checkpoint、向量与trace；删除前取消活动任务 |
| S3.3 质量评测与发布准备 | 合成或授权脱敏的标注评测集、预算与性能数据、部署与运维方案 | 至少20份简历与100–300条JD的目标集；人工标注质量评估；故障注入；备份恢复演练；依赖安全审计；实测时延；在目标服务器或满足条件的硬件上解除已知环境限制L1：连续运行 `pnpm test` 3次与 `pnpm run test:integration` 2次全部通过，并核对Qdrant集合创建耗时；同一批次中默认Docker Qdrant集合创建不超过原5秒限制，以解除已知环境限制L2 |

模型评测关注引用有效率、结构化正确率、unknown合理性、逐要求判断质量、Recall@K与推荐相关性以及费用，不只判断输出非空。上线阈值须依据标注数据确定，不预先宣称准确率。

恢复和重试保持原任务身份与冻结输入；重新分析或重新召回创建新的AnalysisTask和报告，不覆盖历史。NodeArtifact的operationKey需覆盖输入、组件/Schema及适用的prompt/model版本，并以jobVersionId及必要的requirementId/batchId区分并行分支。

文档中的并发数、超时、重试、租约和400条默认判断预算是待验证参数，不是生产级保证。

### 执行顺序与停止条件（前后端连续执行）

适用于由AI连续执行后续任务。前端对应规则见[前端开发计划](https://github.com/Mingan-X/Resume-Studio-Frontend/blob/main/docs/development-roadmap.md)，两边编号与门禁一致。

2026-11-27维护者确认了全部待决策事项（见[§6](#6-待决策事项)）及本小节的执行方式，授权AI连续完成S2.1至S3.3与F1.1至F3.2，不逐阶段停下等待验收。

**分支**：`develop` 为集成分支。每个阶段分支从最新 `develop` 创建；阶段完成后以 `--no-ff` 合并回 `develop`，阶段状态改为“待验收”，再从更新后的 `develop` 创建下一阶段分支。可以推送阶段分支与 `develop`；不得推送、合并或修改 `master`（前端为 `main`）。全部阶段完成后由维护者统一验收 `develop`，再由维护者合并到 `master`。分支流程见[CONTRIBUTING](../CONTRIBUTING.md)。

**顺序**

| 批次 | 后端 | 前端 | 进入条件 |
|---|---|---|---|
| 1 | S2.1 | F1.1 → F3.2-T1（CI）→ F1.2 → F1.3 | 前端F1.x不依赖新后端接口，可与S2.1并行 |
| 2 | S2.2 | F2.1 | F2.1需S2.1已合并到后端develop |
| 3 | S2.3 | F2.2 | F2.2需S2.2已合并到后端develop |
| 4 | S2.4 | — | 依赖S2.1、S2.3 |
| 5 | S2.5 | F2.3 | F2.3需S2.4已合并到后端develop |
| 6 | S3.1 | F2.4 → F2.5 | 前端需S3.1已合并到后端develop |
| 7 | S3.2 | F3.1 | — |
| 8 | S3.3 | F3.2（T1已提前） | — |

前端先基于MSW开发，再与本地真实后端冒烟；依赖真实模型产出的冒烟按下方延后规则处理。同一批次内后端与前端在各自仓库的分支上进行。

**统一验收前延后的任务**：下列工作需要维护者的API Key、人工标注或目标服务器，维护者决定留到统一验收时完成。AI先完成表中“照常完成”的部分，在progress标明延后项，然后继续后续任务；延后项不阻塞阶段合并到develop。

| 任务 | 照常完成 | 延后到统一验收 |
|---|---|---|
| S2.2-T8 | OpenAI兼容模型适配器 | T7 | 基于LangChain ChatOpenAI并配置baseURL的ModelPort实现（新增依赖按AGENTS核对）；baseURL、Key、模型名与modelConfigVersion只来自不入库的本地配置并经Zod校验；本地HTTP桩测试；经中转站的真实验证记录（延后到统一验收） | 适配器只替换ModelPort实现，不改调用方；模型不支持工具调用或JSON Schema结构化输出时明确失败；发送前移除联系方式；日志与观测不含Key；桩测试覆盖超时、429、5xx、非法JSON与结构化输出不符；真实验证完成前不宣称可用 | 基础检查；桩测试专项 |
| S2.3-T7 | 百炼文本向量适配器 | T3、T4 | 阿里云百炼文本向量的EmbeddingPort实现（具体模型ID、维数与接口形式按实施时官方文档核对并记录来源）；配置只来自不入库的本地文件；本地HTTP桩测试；真实embedding重建索引与验证（延后到统一验收） | 适配器只替换EmbeddingPort实现；维数与配置一致，不一致即失败；合成embedding不作为正式索引目标；日志不含Key；真实验证完成前不宣称召回可用 | 基础检查；test:integration；native-qdrant对照 |
| S2.3-T8 | 标注格式、标注说明与Recall@K脚本 | 人工标注与指标 |
| S2.4-T9 | — | 全部（真实模型端到端运行） |
| S3.3-T1、S3.3-T2 | 合成数据集、标注说明与评测脚本 | 人工标注与质量指标 |
| S3.3-T4 | 本地可测部分（如创建任务p95） | 依赖真实模型的分析耗时、token与费用 |
| S3.3-T5、S3.3-T7、S3.3-T8 | 备份恢复步骤、部署配置及本地可做的验证 | 目标服务器上的演练、部署验证与L1/L2解除回归 |
| F2.3-T4、F2.4-T7、F2.5-T4 | MSW流程用例及不依赖模型的真实冒烟 | 依赖真实模型产出的真实冒烟 |
| F3.2-T2 | 不依赖模型的真实后端流程 | 完整真实后端流程 |
| F3.2-T6 | 部署配置与本地验证 | 目标环境部署与回滚演练 |

延后项不得用假模型、假标注或占位数据补齐并标记完成；阶段回归任务对已完成部分执行检查，并列出延后项。

**检查失败**：失败不属于已知环境限制L1/L2、且无法在不改变范围、验收条件或已验证行为的前提下修复时，在progress记录失败输出与原因。若后续任务不依赖它，跳过并继续；若后续任务依赖它，停止并等待维护者。

2026-11-28维护者追加例外：未确认的PostgreSQL SocketTimeout保存诊断与失败记录，不阻塞后续开发/阶段收尾，不宣称修复或生产验证通过。该例外不允许删除安全检查、用未知停止状态启动清理或掩盖其他业务故障。禁止所有会话使用goal模式；阶段后续与前端恢复安排见S3.2当前说明。

2026-11-27维护者在S2.3阻塞修复中明确授权适当放宽Qdrant超时。依据服务端集合创建实测5.67–6.46秒，当前Qdrant单请求上限调整为10秒；仍受任务/操作剩余总期限与取消约束，不增加重试层数。仅此项覆盖此前“Qdrant原5秒不变”的执行约束，API、数据库、RabbitMQ、Langfuse及父测试期限/行为断言不变。历史L2记录及目标环境原5秒性能核对保留；10秒下通过不等于解除历史L2性能限制。

S2.4-T1回归又实测同项目Qdrant集合创建11.929918秒，超过上述10秒。沿用“适当放宽Qdrant”的既有授权，单请求上限进一步调整为15秒；原15秒初始化/清理总期限和其他操作/任务总期限均不增加，所有请求仍取剩余总期限与单请求上限的较小值，不新增重试。历史L2的原5秒目标不变；证据与验证见[本次诊断](research/s24-qdrant-2026-11-27.md)。

2026-11-27维护者在S2.4-T10的Langfuse projects查询5008ms超时后，明确授权“这个的超时限制也适当放宽”。先将projects查询改为10秒，专项又观察到observations读取5014ms超时，因此观测集成测试projects/observations/trace清理的单请求统一为10秒；读取请求同时受剩余轮询窗口约束，持久化轮询总窗口45秒、父测试90秒、生产观测导出配置及重试/丢失/脱敏断言保持。此项覆盖前述Langfuse期限不变约束中的诊断HTTP部分；通过调整后的验证才能解除当前回归阻塞，不作为已定位底层性能问题或新增环境豁免。

**必须停止并等待维护者的情况**

1. 上一条中被后续任务依赖的失败。
2. 需要改动任务编号、依赖、验收，或发现架构/需求矛盾；需要新的D编号决策。
3. 需要删除卷/数据库/本地配置、重写远程历史、操作其他项目实例或修改 `master`/`main`。
4. 需要上表之外的真实API Key、付费调用、人工输入或真实/授权数据。

**每个任务**：按AGENTS与CONTRIBUTING执行；运行该任务“检查”列与完成定义要求的命令；在progress追加记录（含失败、延后与未执行项）；按任务提交。

**检查简称**：下文后端任务表中“基础检查”指 `pnpm run typecheck`、`pnpm run lint`、`pnpm test`；“迁移检查”指 `db:generate`、`db:validate`、`db:deploy` 两次与 `db:status`；涉及真实服务时加 `pnpm run test:integration`，涉及HTTP契约时加 `pnpm run openapi:check`，依赖变化时加 `pnpm install --frozen-lockfile`。默认Docker全量唯一失败为已知Qdrant创建超时（L2）时按L2记录；涉及Qdrant的阶段（S2.3起）另跑 `test:integration:native-qdrant` 对照。

### S2.1 任务拆分（2026-11-27维护者确认）

基线：2026-11-26已fetch确认S1.4及验收记录经PR #2/#3合并，最新master为`c728ef8`；从该提交创建`feature/s2.1-resume-evidence`。L1/L2沿用已接受的环境限制，不以进入新阶段重新判定S1.4未完成。本次只补充任务与依赖，未安装解析依赖、修改Schema或实现接口。

#### 范围与已确认事项

2026-11-26维护者审阅草案后确定以下方向（修订记录见[开发进度](progress.md)）；2026-11-27维护者确认D6、D11及本节任务表。

- **D6（已确认）**：首版支持带文本层的PDF，以及正文/表格含文本的DOCX；扫描PDF、加密文件、损坏文件及空文本给出明确失败原因，OCR不纳入本阶段。10 MiB、30页沿用需求中的建议值，30页仅适用于PDF，DOCX以文本量上限代替页数；其他文本量、解压、CPU、内存与总耗时限制由T1样本方案及T4–T6实测定稿，不能把建议值视为已测保证。
- **解析依赖（D11，已确认）**：PDF使用pdfjs-dist，DOCX使用mammoth，流式ZIP检查使用yauzl；mammoth通过JSZip整包读取文件，因此先用yauzl在交给mammoth之前核对实际解压量、条目与路径。T1按当时registry复核版本、engines/peers、维护状态与许可证并记录，与确认版本不一致时按AGENTS说明原因。不引入Python服务或第三方云端解析；解析器经ParserPort接入，数据模型不绑定具体解析器。
- **文本解析在上传请求内同步完成**：不新增第三类任务。上传在受限子进程中解析，成功时在同一事务提交FileAsset、ResumeVersion与ExtractedDocument并返回201；扫描、加密、损坏、空文本或超限返回413/422及具体原因，不留业务记录，暂存文件即时补偿。崩溃或断连遗留的暂存文件由T2的定期回收处理。分析图的PARSE节点改为按resumeVersionId读取已存产物，不重复解析。总期限由T4–T6实测确定。
- **语义结构化执行移到S2.4**：[需求R2](requirements.md#1-用户与范围)的教育/工作/项目/技能由LLM抽取（[架构§4.3](architecture.md#43-普通函数与llm分工)），且分析图已具备Checkpoint、租约、预算与恢复能力。S2.1只交付ParsedResume的Zod契约与引用校验器（T9），抽取执行作为分析图EXTRACT节点在S2.4实现。S2.1因此不依赖D2；上传后的版本详情只返回文本块与警告，不返回结构化字段占位。R2分期与架构调整由T1同步。
- **上传幂等与版本**：`POST /api/v1/resumes` 要求Idempotency-Key，与owner及文件sha256绑定，同key同文件返回原版本，同key不同文件返回409。本阶段每次上传创建新Resume及version 1；给已有简历追加版本的接口不在本阶段，数据模型保留unique(resumeId,version)。
- **交付边界**：原文件、提取文本块、引用和结构化产物分别保存；仅使用合成或已授权脱敏样本。沿用可信IdentityPort与本地开发访问限制；岗位、召回、画像评分、报告、生产认证仍按原阶段推进。所有权检查属于本阶段，各资源始终绑定owner及版本。不把真实简历伪装为现有`kind: synthetic`分析输入。

#### 任务与验收

以下编号已于2026-11-27确认。每项包含实现时应执行的检查；实际运行结果见progress。

| 任务 | 目标 | 依赖 | 产出 | 验收 | 检查 |
|---|---|---|---|---|---|
| S2.1-T1 | 冻结文件、证据及处理契约 | 拆分与D6确认 | 文件/版本/文本块/引用的Zod契约设计；上传（201/409/413/422）与查询响应、失败原因；Idempotency-Key与文件sha256绑定规则；合成样本矩阵和资源限制方案；D11依赖的registry、engines/peers、维护状态与许可证复核；同步需求R2分期、架构§4.1 PARSE读取已存产物与§9上传调用链 | 明确字符区间单位、换行/归一化顺序、块身份、版本与哈希；页码/坐标/段落等位置字段标为暂定，待T5/T6样本实验定稿；样本覆盖中文、双栏、表格、项目列表、扫描、加密PDF、加密DOCX（OLE/CFB容器）、旧版.doc、.docm及损坏/超限文件；不提前发布未实现路由 | typecheck、lint、pnpm test；设计与样本人工核对 |
| S2.1-T2 | 本地文件存储与精确补偿 | T1 | StoragePort、本地适配器、受控根目录、服务器生成storageKey、流式大小限制、哈希、暂存与提交协议；暂存区定期回收命令 | 拒绝路径穿越/绝对路径/链接逃逸；同名文件不覆盖；中断、写失败与结果未知有可核查状态；即时补偿只删除本次操作的暂存文件；定期回收只处理受控暂存区内超过期限且无数据库引用的文件，删除前核对路径归属，不按名称前缀推断，不误删已提交文件 | typecheck、lint、pnpm test、真实临时目录文件测试 |
| S2.1-T3 | 简历与证据持久化模型 | T1 | FileAsset、Resume、ResumeVersion、EvidenceBlock映射及上传幂等记录；新增Prisma迁移与repository | 所有权与版本关联由查询和数据库约束共同保护；unique(resumeId,version)；原文件/文本版本不可原地替换；失败事务无半套业务记录；重复部署无待执行迁移；保留S1.4合成任务数据，不对其虚构版本ID直接追加真实外键 | db:generate、db:validate、db:deploy两次、db:status；typecheck、lint、pnpm test、真实数据库专项 |
| S2.1-T4 | 文件预检与有界解析执行 | T1、T2、D11 | 扩展名/签名/类型交叉检查；DOCX包结构的流式ZIP预检；解析隔离子进程执行器及超时/中止清理 | 限制条目数、实际解压总量/单条目、压缩比与文本量，检查实际展开量而非只信ZIP声明，预检通过后才交给mammoth；拒绝异常路径、符号链接及嵌套压缩，禁止解析器读取外部资源与网络；子进程有总期限、JS堆上限及RSS轮询，超限即终止并确认退出、释放资源，不仅依赖Promise超时；记录资源限制在哪个平台实测（本机Windows，Linux待部署环境验证） | typecheck、lint、pnpm test；恶意合成文件、真实子进程退出及资源边界测试 |
| S2.1-T5 | PDF文本块与定位 | T4 | pdfjs-dist解析适配器、稳定块ID、页码及能可靠获得的位置、parserVersion、警告；PDF位置字段定稿 | 正常中文和多页可提取；双栏阅读顺序用样本逐块核对，不能保证时明确警告/失败；超过30页、扫描、加密、损坏及空文本明确处理；不伪造坐标，不把图像页当成成功文本 | typecheck、lint、pnpm test；PDF合成样本与定位专项 |
| S2.1-T6 | DOCX段落与表格文本 | T4 | mammoth解析适配器、段落/表格来源与稳定块ID、parserVersion、警告；DOCX位置字段定稿 | 中文段落、换行及表格单元格顺序可核对；保留段落/抽取块定位，不虚构页码；文本量超限、损坏包、缺失正文、空文本、加密及旧版.doc明确失败 | typecheck、lint、pnpm test；DOCX合成样本与ZIP边界专项 |
| S2.1-T7 | 引用校验与不可变解析产物 | T3、T5、T6 | ExtractedDocument持久化、EvidenceRef校验、按版本读取文本块 | quote与已存文本区间逐字一致；拒绝跨owner/跨版本/不存在块/越界区间；覆盖中文、换行和代理对边界；并发处理两份简历不串数据；哈希与解析版本可追溯 | typecheck、lint、pnpm test、引用单元测试、真实数据库与文件集成专项 |
| S2.1-T8 | 上传、列表与版本详情HTTP | T2、T3、T7 | POST /api/v1/resumes（请求内同步解析）、简历列表与版本详情接口；本地开发装配；同源OpenAPI及错误文档；接口契约中上传与Idempotency-Key规则 | multipart字段file；成功201，大小超限413，签名/格式/扫描/加密/空文本422并给出原因；同key同文件返回原版本，同key不同文件409；可信owner隔离；稳定游标分页；详情返回解析结果、文本块与警告，不返回结构化字段占位；无内部路径/凭证；解析失败、文件提交/DB提交失败及客户端断连后无业务记录且暂存文件被补偿或可被定期回收；重启后结果可查 | typecheck、lint、pnpm test、真实HTTP/文件/数据库专项、openapi:check |
| S2.1-T9 | ParsedResume契约与引用校验 | T7 | 教育/工作/项目/技能的ParsedResume Zod契约（schemaVersion、每项sourceRefs、null/空数组语义）及校验器；手工合成的固定样例 | 校验器复用T7 EvidenceRef校验，拒绝越界、伪造、跨版本及跨owner引用，拒绝未知字段和额外分数字段；缺失信息只能为null/空数组；样例覆盖中文、多段经历和无引用项；不调用模型、不持久化抽取结果，抽取执行属于S2.4 | typecheck、lint、pnpm test、契约与校验单元测试 |
| S2.1-T10 | 阶段回归与文档交接 | T1–T9 | README、API/OpenAPI、依赖、部署、测试及进度同步；前端F2.1可消费的契约说明 | 上传至文本块、引用校验全链路与故障边界可复核；不将文本抽取或固定样例当作语义结构化完成；原功能回归；新依赖冻结安装；精确清理本轮文件/记录；未执行项与L1/L2独立记录 | typecheck、lint、pnpm test、openapi:check、test:integration；依赖变更时install --frozen-lockfile；文档链接及git diff --check |

建议实施顺序：T1 → T2/T3 → T4 → T5/T6 → T7 → T8/T9 → T10。每项验证后追加progress，并按任务组织本地提交；推送及合并按已有工程约定。

S2.1使用文件与PostgreSQL，不因本阶段额外调用Qdrant。完整回归仍执行原集成命令；若唯一失败为已知Docker Qdrant创建超时及其父测试，且精确清理无残留，按L2如实记录。新增文件/解析/数据库/任务用例失败不能归入L1/L2，不扩大现有超时或跳过断言。

### S2.2 任务拆分：JD与Rubric

范围：岗位草稿、结构化要求、确认与不可变发布、发布事务内创建JobIndexTask与Outbox、六维Rubric版本。真实索引执行（embedding与Qdrant写入）属于S2.3；本阶段发布的JobIndexTask保持待执行，合成处理器不得把真实岗位标为READY。

设计取舍：JD结构化抽取是用户等待确认的交互步骤，采用HTTP请求内同步调用，受单次超时与总期限约束；先保存草稿再调用，失败不影响草稿，用户可手工录入要求。抽取结果只作为待确认建议，不自动写入已确认要求。不新增任务类型。

| 任务 | 目标 | 依赖 | 产出 | 验收 | 检查 |
|---|---|---|---|---|---|
| S2.2-T1 | 岗位、要求与Rubric契约 | S2.1 | Job/JobVersion（草稿、已发布）、JobRequirement（stableId、dimension、kind=HARD/SOFT、threshold、weight、sourceRef、priority）、RubricVersion的Zod契约；JD正文作为证据来源（sourceType=JD）的文本块规则；权重校验规则；JobIndexInputSnapshot区分合成与真实（`kind`）；无处理器时真实索引任务的处理方式 | 六维ID与[需求§2](requirements.md#2-六维定义)一致；权重拒绝缺失必需项、负数、NaN、Infinity、重复ID、不支持维度，参与计算的总权重>0；要求sourceRef复用S2.1 EvidenceRef校验；真实快照不能被合成处理器完成 | 基础检查；契约单元测试 |
| S2.2-T2 | 持久化模型与迁移 | T1 | Job、JobVersion、JobRequirement、RubricVersion表与repository；真实JobIndexTask到JobVersion的外键 | 已发布版本及其要求由数据库触发器禁止原地修改；unique(jobId,version)；所有查询显式带ownerId；保留S1.4合成任务数据，不对合成版本ID追加真实外键；失败事务无半套记录 | 迁移检查；基础检查；真实数据库专项 |
| S2.2-T3 | 草稿与要求编辑服务 | T2 | 草稿创建/正文修改（保存正文、哈希与文本块）、要求的增删改、编辑已发布岗位时生成新草稿版本 | 草稿可改，已发布版本不可改；要求sourceRef与JD文本区间逐字一致，越界/跨版本/跨owner拒绝；新草稿从已发布版本复制要求并保留来源 | 基础检查；真实数据库专项 |
| S2.2-T4 | 确认与发布事务 | T3 | 硬门槛与权重确认标记；发布服务：同一事务写JobVersion PUBLISHED与内容哈希、JobIndexTask（当前配置的索引目标）、Outbox `job.index.requested.v1`；发布Idempotency-Key | 未确认的硬门槛或权重拒绝发布；同key同请求返回原jobVersionId与taskId，不同请求409；事务回滚时不留Outbox或任务；旧版本任务不能更新新版本的indexStatus（复用S1.4 fence与目标版本匹配）；真实任务未被合成处理器标READY | 基础检查；test:integration（含真实RabbitMQ发布） |
| S2.2-T5 | Rubric版本存储与加载 | T2 | RubricVersion导入命令、内容哈希、按维度精确加载全部等级；测试用合成Rubric | 发布后不可变；加载时六维与L1–L5齐全，缺失即失败；不通过检索随机取等级；合成Rubric只用于测试且不注册为默认版本 | 基础检查；真实数据库专项 |
| S2.2-T6 | 正式Rubric v1（AI起草） | T5 | 依据[需求§2](requirements.md#2-六维定义)六维定义起草的RubricVersion v1：各维L1–L5行为标准、证据门槛、featureId，等级分值采用20/40/60/80/100，导入为首个正式版本 | 版本元数据与progress标明“AI起草、待维护者统一验收审核”；审核前不宣称是已批准规则；审核修改须发布新版本，不原地修改 | 基础检查；导入与加载专项 |
| S2.2-T7 | 模型端口与JD抽取建议 | T3 | 共享ModelPort（基于LangChain的结构化输出抽象，供S2.4复用）、单次超时/最大重试/分类退避（含jitter）/总期限/费用预算的调用包装；JD抽取prompt与promptVersion/modelConfigVersion/schemaVersion；抽取服务层；测试用确定性假模型（只在测试注册） | 输出经Zod与sourceRef校验，未知字段、越界引用、模型给出的分数字段被拒绝；一次受控修复仍失败则返回明确失败，草稿不变；JD中的指令只视为数据；不在数据库事务中等待模型；Langfuse只记录脱敏信息；无可信usage时费用不填0 | 基础检查；假模型与合成故障专项 |
| S2.2-T8 | OpenAI兼容模型适配器 | T7 | 基于LangChain ChatOpenAI并配置baseURL的ModelPort实现（新增依赖按AGENTS核对）；baseURL、Key、模型名与modelConfigVersion只来自不入库的本地配置并经Zod校验；本地HTTP桩测试；经中转站的真实验证记录（延后到统一验收） | 适配器只替换ModelPort实现，不改调用方；模型不支持工具调用或JSON Schema结构化输出时明确失败；发送前移除联系方式；日志与观测不含Key；桩测试覆盖超时、429、5xx、非法JSON与结构化输出不符；真实验证完成前不宣称可用 | 基础检查；桩测试专项 |
| S2.2-T9 | 岗位HTTP接口 | T4、T5、T7 | `POST /jobs`、`GET /jobs`（游标分页）、`GET /jobs/:jobId`及版本详情、草稿正文与要求编辑、`POST /jobs/:jobId/versions/:versionId/publish`、抽取建议路由；错误details字段；OpenAPI | 可信owner隔离，越权404；发布返回jobVersionId与索引taskId；字段级错误通过details返回且不含原始输入值；列表/详情返回发布状态与indexStatus；未配置真实模型时抽取路由返回明确的不可用错误，不使用假模型 | 基础检查；真实HTTP专项；openapi:check |
| S2.2-T10 | 阶段回归与文档 | T1–T9 | README、需求/架构、API/契约、测试、进度；前端F2.2可消费的契约说明 | 草稿→确认→发布→索引任务待执行的全链路可复核；门禁任务未完成时如实记录 | 基础检查；test:integration；openapi:check；文档链接与git diff --check |

### S2.3 任务拆分：岗位召回

范围：技能字典与关键词召回、岗位Qdrant索引、Dense Vector、RRF融合、CandidateSet冻结。召回服务的输入为`RecallQuery`契约（技能列表与去除联系方式的摘要文本）；由简历构造查询在S2.4完成，本阶段用合成查询测试。

| 任务 | 目标 | 依赖 | 产出 | 验收 | 检查 |
|---|---|---|---|---|---|
| S2.3-T1 | 合成JD语料与技能字典 | S2.2 | 至少100条合成中文JD的生成/导入脚本（经S2.2发布流程入库）；版本化技能字典（规范名、中英文别名）与归一化函数；JobCorpusVersion（已发布版本清单哈希、可见性） | 语料只含合成内容；同一输入归一化结果稳定；字典版本变化不修改历史结果；语料快照可重复构建 | 基础检查；真实数据库专项 |
| S2.3-T2 | 关键词召回 | T1 | PostgreSQL技能字段/数组查询、候选上限（默认50）、稳定并列排序、召回参数版本 | 只召回指定JobCorpusVersion内已发布且可见的版本；不以简历缺失的城市/年限做硬过滤；跨owner不可见；结果含来源与rank | 基础检查；真实数据库专项 |
| S2.3-T3 | Embedding端口 | T1 | EmbeddingPort、embeddingVersion与维数配置、调用包装；测试用确定性合成embedding（只在测试注册） | 输入去除联系方式；单次超时、最大重试、分类退避（含jitter）、并发与费用预算；维数与配置不符即失败 | 基础检查；合成故障专项 |
| S2.3-T4 | 版本化集合与索引处理器 | T3、S2.2-T4 | 按embeddingVersion/维数命名的collection与alias切换；确定性point ID（jobVersionId、chunkId、embeddingVersion）；JobIndexTask真实处理器（分块→embedding→幂等upsert→持当前fence标READY）；为缺少当前索引目标的已发布版本补建任务的命令 | 重复投递只产生同一批point；旧版本或旧目标任务不能把新版本标READY；维数变化建新collection，不混入旧collection；Qdrant失败按重试/预算处理并保留可恢复状态；删除或切换前核对collection归属，不按前缀批量删除 | 基础检查；test:integration；test:integration:native-qdrant |
| S2.3-T5 | 向量召回与RRF融合 | T2、T4 | 查询embedding、按jobVersionId聚合chunk、向量候选上限（默认50）、RRF融合与去重、最多20个岗位、参数版本化；向量失败时的显式关键词降级 | 召回结果回查PostgreSQL有效版本；相似度不作为综合分；并列排序稳定；降级结果带degraded标记与原因，不伪造向量分；索引目标未READY时返回INDEX_NOT_READY或按策略降级 | 基础检查；test:integration；native-qdrant对照 |
| S2.3-T6 | CandidateSet冻结 | T5 | CandidateSet/Candidate表与服务：corpusVersion、召回配置、候选顺序、各路来源rank | unique(setId,jobVersionId)；冻结后不可修改；同一任务重放不生成第二个集合 | 迁移检查；基础检查；真实数据库专项 |
| S2.3-T7 | 百炼文本向量适配器 | T3、T4 | 阿里云百炼文本向量的EmbeddingPort实现（具体模型ID、维数与接口形式按实施时官方文档核对并记录来源）；配置只来自不入库的本地文件；本地HTTP桩测试；真实embedding重建索引与验证（延后到统一验收） | 适配器只替换EmbeddingPort实现；维数与配置一致，不一致即失败；合成embedding不作为正式索引目标；日志不含Key；真实验证完成前不宣称召回可用 | 基础检查；test:integration；native-qdrant对照 |
| S2.3-T8 | 中文技能相关性评测 | T5、T7、维护者标注 | 标注格式与标注说明、Recall@K计算脚本；维护者完成的相关性标注 | 指标只基于实际标注与真实embedding计算；未标注时不报告召回质量 | 基础检查；评测脚本测试 |
| S2.3-T9 | 阶段回归与文档 | T1–T8 | 架构§7、部署（collection与alias）、测试、依赖、进度 | 索引幂等、旧版本不混入、维数变更、降级均有可复核记录；L2与原生对照分别记录 | 基础检查；test:integration；native-qdrant对照；文档链接与git diff --check |

### S2.4 任务拆分：语义结构化、六维画像与逐项匹配

范围：真实分析任务与`POST /api/v1/analyses`，LangGraph业务分析图的EXTRACT、PROFILE、召回接入与MATCH节点，预算与部分失败。评分与排名在S2.5接入，报告快照在S3.1接入。

阶段性终态：S3.1之前，分析图在JOIN后由临时finalize提交任务终态，SUCCEEDED/PARTIAL表示画像与匹配产物已提交，reportId为null；S3.1起改为要求报告快照提交（[架构§6.2](architecture.md#62-分工与状态机)届时同步）。

| 任务 | 目标 | 依赖 | 产出 | 验收 | 检查 |
|---|---|---|---|---|---|
| S2.4-T1 | 真实分析输入与创建接口 | S2.1、S2.3 | 真实TaskInputSnapshot（resumeVersionId、asOfDate、jobCorpusVersionId、rubricVersion、scoringVersion、promptVersion、modelConfigVersion、embeddingVersion、预算），与合成快照按`kind`区分；创建服务；`POST /api/v1/analyses`（202、taskId、statusUrl、Idempotency-Key）；OpenAPI | 简历版本须属于当前owner且解析成功；corpus、rubric、配置版本在创建时冻结；同key同请求返回原taskId，不同请求409；事务回滚时不留Outbox；任务查询API能返回真实分析任务；合成消费入口拒绝真实快照 | 基础检查；真实HTTP/数据库专项；openapi:check |
| S2.4-T2 | 分析任务的模型调用预算 | T1、S2.2-T7 | 复用S2.2-T7的ModelPort；modelConfigVersion随输入快照冻结；每次调用前经S1.4 reserveUsage预留次数/token/费用 | 预算跨重试与恢复累计，不可通过嵌套重试绕过；超出预算或总期限时中止后续调用并保存可恢复状态；Langfuse回调只上报脱敏数据 | 基础检查；假模型与合成故障专项 |
| S2.4-T3 | 业务分析图与恢复 | T1、T2 | 分析StateGraph：LOAD → PARSE（读取已存ExtractedDocument）→ EXTRACT → VALIDATE → PROFILE / 召回 → SNAP → MATCH → JOIN → 临时finalize；沿用S1.4-T7执行权与thread切换；NodeArtifact的operationKey增加branchKey及prompt/model版本；`tasks:consume:analysis`命令 | GraphState只含ID与结构化数据；强杀Worker后按S1.4-T7规则恢复，已提交节点不重复写业务产物；旧token写入被拒绝；取消在节点边界生效 | 基础检查；test:integration（真实Worker子进程） |
| S2.4-T4 | EXTRACT语义结构化 | T3、S2.1-T9 | 简历抽取prompt与版本；按resumeVersionId+prompt/model/schema版本复用的抽取产物表；日期归一化纯函数（使用冻结asOfDate） | 输入只来自授权版本的已存文本块；输出经S2.1-T9校验器校验；缺失信息为null/空数组；简历中的指令只视为数据；一次受控修复仍失败则显式失败；同一版本多次分析不重复调用模型 | 基础检查；假模型专项 |
| S2.4-T5 | PROFILE六维画像 | T3、T4、S2.2-T5 | 画像子图（测试使用合成Rubric，正式Rubric来自S2.2-T6）：按rubricVersion加载完整等级，输出六维status、level或null、featureIds、evidenceRefs、rubricRefs、reason；等级到分值的映射按RubricVersion确定性计算 | 六维都有合法状态；证据不足为unknown，不默认等级；模型输出的分数字段被拒绝；引用逐字校验；画像不用于推导逐项verdict | 基础检查；假模型专项 |
| S2.4-T6 | 召回接入与候选冻结 | T3、T4、S2.3-T6 | 由ParsedResume构造RecallQuery（去除联系方式）；调用S2.3召回并冻结CandidateSet | 只读取冻结corpus；索引未READY或向量失败时按S2.3策略处理并记录降级；候选集合随任务冻结，恢复后不重新召回 | 基础检查；test:integration |
| S2.4-T7 | MATCH逐项匹配 | T6 | 按jobVersionId的Send并行分支（初始并发3）及要求批次；日期、年限、显式阈值由纯函数判断；语义要求由模型给出verdict与证据；400条唯一判断预算 | 未知/重复requirementId、缺必需项、越界或不属于该简历的引用不进入结果；预算跨恢复/重试不重置，超出时保存截断原因及计划/已完成/未完成数量；分支失败为显式失败对象，不静默删除；模型不输出总分 | 基础检查；假模型专项；test:integration |
| S2.4-T8 | 汇总、部分失败与进度 | T5、T7 | JOIN规则、PARTIAL/FAILED判定、临时finalize；TaskEvent真实阶段与计数（如已匹配岗位/候选总数） | 按[架构§6.2](architecture.md#62-分工与状态机)判定；解析失败或两个板块都不可用为FAILED；进度不估算百分比；旧代次事件不覆盖新代次 | 基础检查；test:integration |
| S2.4-T9 | 真实模型与正式Rubric验证 | T4、T5、T7、T8、S2.2-T6、S2.2-T8、S2.3-T7、维护者提供Key与预算 | 使用正式Rubric与真实模型，在合成简历与合成JD上的端到端运行记录：延迟、token、费用、失败与修复次数 | 只记录实测结果，不宣称准确率；输入为合成数据；预算上限由维护者确认；本任务未完成时S2.4不能整体验收 | 真实运行记录 |
| S2.4-T10 | 阶段回归与文档 | T1–T9 | 架构§4、API/契约、测试、部署、进度；前端F2.3可消费的契约说明 | 恢复、重复投递、预算截断、部分失败与取消均有可复核记录；门禁任务未完成时如实记录 | 基础检查；test:integration；openapi:check；文档链接与git diff --check |

### S2.5 任务拆分：确定性评分与排名

范围：[架构§8](architecture.md#8-评分引擎设计)的评分纯函数、硬门槛资格、稳定排名与Top10、分析图SCORE/RANK节点、重算服务。评分内核以ScoringPolicy为输入，可在D7确认前实现与测试；默认政策数值须D7确认。

| 任务 | 目标 | 依赖 | 产出 | 验收 | 检查 |
|---|---|---|---|---|---|
| S2.5-T1 | ScoringPolicy契约与版本 | S2.4-T1 | ScoringPolicy Zod契约（dimensionWeights、requirementWeightPolicy、verdictCoefficients、unknownPolicy、hardGatePolicy、rounding、version）、存储与不可变版本 | 拒绝缺失、负数、NaN、Infinity、重复维度/要求ID、不支持维度及总权重为0；计算使用整数基点或有理数，不依赖locale与浮点舍入顺序 | 基础检查；迁移检查 |
| S2.5-T2 | 评分纯函数 | T1 | a_i、contribution、score、coverage、upperBound计算 | 架构示例得到62.5/75%/87.5；无有效要求时score=null；维权重为0不求零分母；同一输入重复100次结果一致；覆盖缺失、负数、NaN、Infinity、零总权重、重复ID、不支持维度、同分、unknown边界 | 基础检查；性质测试 |
| S2.5-T3 | 硬门槛与资格 | T2 | eligible/pending/ineligible判定 | 明确不满足为ineligible，无法验证为pending，全部明确满足为eligible；软技能不升级为硬门槛 | 基础检查 |
| S2.5-T4 | 稳定排名与Top10 | T2、T3 | 固定精度排序、jobVersionId并列规则、最多10条eligible、所有精判候选的完整分数 | 不足10条不补造并给出原因；pending不进入推荐；保存全部候选分数 | 基础检查 |
| S2.5-T5 | SCORE/RANK节点接入 | T4、S2.4-T8 | 分析图在MATCH后计算并保存ScoreResult（judgmentSetHash、policyVersion、weightsSnapshot、contributions、coverage、total、eligibility） | 相同输入唯一；评分不调用模型；恢复时复用已保存结果 | 基础检查；test:integration |
| S2.5-T6 | 重算服务 | T5 | 基于冻结判断与新权重的重算服务（HTTP在S3.1） | 模型调用数为0；只在原CandidateSet内排序；原第11名可进入新榜单；原结果不被修改 | 基础检查；重算专项 |
| S2.5-T7 | 默认评分政策 | T1 | 按D7导入ScoringPolicy v1：六维等权；verdict系数met 1、partial 0.5、unmet 0、unknown 0；unknown单列；硬条件无法验证进入待核实；仅eligible进入Top10 | 数值与D7记录一致并可追溯；后续调整发布新版本，不修改v1 | 基础检查 |
| S2.5-T8 | 阶段回归与文档 | T1–T7 | 架构§8、测试、进度 | 评分边界与重算无模型调用均有测试记录 | 基础检查；test:integration；文档链接与git diff --check |

### S3.1 任务拆分：报告与进度API

| 任务 | 目标 | 依赖 | 产出 | 验收 | 检查 |
|---|---|---|---|---|---|
| S3.1-T1 | 报告快照模型 | S2.5 | AnalysisReport：revision、sourceReportId、输入快照、结构化简历引用、CandidateSet、ProfileAssessment、全部计划要求及执行状态、rubricVersion、scoringPolicyVersion、ScoreResult与权重快照、candidateCoverage、warnings；finalize唯一操作键 | 报告提交后不可修改；未完成要求保留状态与原因，不伪造判断；派生报告关联原报告且不覆盖原报告 | 迁移检查；基础检查 |
| S3.1-T2 | 报告finalize接入 | T1 | 分析图SAVE节点：同一事务提交报告、任务终态与事件，校验当前fence；取消S2.4临时finalize；同步架构§6.2 | SUCCEEDED/PARTIAL要求报告已提交；报告提交后、ACK前崩溃时重投不重复生成报告；Checkpoint结束而终态缺失时由对账幂等finalize，产物不完整则报一致性错误 | 基础检查；test:integration（故障窗口） |
| S3.1-T3 | 报告查询接口 | T2 | `GET /reports/:reportId`、`GET /reports`（游标分页）；OpenAPI | 返回前端展示所需的全部结果：分数、贡献、coverage、upperBound、eligibility、逐项verdict与证据（quote、位置）、六维画像、结构化简历、PARTIAL计数与原因、推荐不足10条的原因；owner隔离；重启后可查 | 基础检查；真实HTTP专项；openapi:check |
| S3.1-T4 | 调权重算接口 | T3、S2.5-T6 | `POST /reports/:reportId/recompute`（Idempotency-Key、details字段级错误）、`GET /reports/:reportId/revisions` | 生成新revision并返回新ID，原报告不变；非法权重按字段返回；模型调用数为0 | 基础检查；真实HTTP专项；openapi:check |
| S3.1-T5 | 任务事件与SSE | S2.4-T8 | `GET /tasks/:taskId/events`：按持久TaskEvent的seq推送，`Last-Event-ID`补读，心跳与连接上限 | 断线不取消任务；跨API/Worker不依赖内存EventEmitter；补读不遗漏、不重复；越权404 | 基础检查；真实HTTP专项；openapi:check |
| S3.1-T6 | 前端所需列表与详情补齐 | T3 | 对照前端F2.3–F2.5所需数据补齐列表/详情接口（如分析列表、可选简历版本与岗位范围）；错误details扩展 | 每个前端页面所需字段都有接口来源；前端无需自行计算或拼装；新增接口同步api.md与OpenAPI | 基础检查；openapi:check |
| S3.1-T7 | 阶段回归与文档 | T1–T6 | API/契约、架构§9、测试、进度；前端F2.4/F2.5契约说明 | 刷新、断网、API/Worker重启后报告与进度可查；SSE补读可复核 | 基础检查；test:integration；openapi:check；文档链接与git diff --check |

### S3.2 任务拆分：身份、权限与数据生命周期

2026-11-28维护者明确要求继续收尾：未确认的SocketTimeout保留为已知问题，不再阻塞T4/T5、阶段合并及后续开发；不得把它描述为修复或解除L1/L2，其他行为失败仍按既有停止条件处理。最新基础136/136、相关数据库集成22/22；历史完整146/149和负载失败全部保留，见[专项诊断](research/s32-postgres-2026-11-28.md)。阶段完成后新开会话按本文件继续后端阶段，后端开发全部完成后恢复前端会话01a218e5-774c-71e3-b816-3d737a491283。各阶段可决定是否新开会话，所有会话禁止goal模式。内置工具缺失/不可调用时授权按修复技能处理。

2026-11-28收尾：T1–T7工程实现完成，基础138/138、最终完整151/151、真实trace删除及文件/恢复专项通过，32条迁移部署与OpenAPI一致性通过。阶段待统一验收；历史首次完整147/151及观测冷启动等待失败保留，未解除SocketTimeout/L1/L2。生命周期须显式启动清理进程，未知停止、旧账号/图线程历史或trace不完整时保留待核实。下一阶段按[交接](handoff-s33.md)新会话执行，运行证据见progress。

| 任务 | 目标 | 依赖 | 产出 | 验收 | 检查 |
|---|---|---|---|---|---|
| S3.2-T1 | 认证方案落地 | S3.1 | 按D9实现：本地账号（命令行创建，不开放自助注册，不接第三方登录）；口令哈希优先使用Node内置crypto.scrypt；PostgreSQL会话存储；登录、登出、当前用户接口；HttpOnly/Secure/SameSite Cookie与CSRF令牌 | 未登录请求返回401 UNAUTHENTICATED；非GET请求缺少或错误CSRF令牌被拒绝；会话过期与登出后不可用；不记录口令或令牌；命令行创建账号不在日志中输出口令 | 基础检查；真实HTTP专项；openapi:check |
| S3.2-T2 | 替换开发身份 | T1 | 生产IdentityPort由会话提供owner；DevelopmentIdentity只在development/test；调整TASK_API_ENABLED等本地限制 | 生产配置下不能启用固定开发身份；请求字段或头仍不能指定owner；403 FORBIDDEN语义明确 | 基础检查；配置与进程测试 |
| S3.2-T3 | 所有权审计 | T2 | 全部HTTP接口、repository与Worker读取的owner检查清单及跨owner测试矩阵 | 每个私有资源的读、写、列表、任务与报告访问都有越权测试；越权统一404 | 基础检查；test:integration |
| S3.2-T4 | 保留期限 | T3 | 按D7的保留政策实现到期标记与清理调度 | 只清理到期且属于该政策的数据；清理可重复执行；活动任务不被清理 | 基础检查；真实数据库/文件专项 |
| S3.2-T5 | 用户数据删除链路 | T3 | 持久删除请求与对账式执行器：禁止新任务、取消活动任务并等待安全停止，再删除文件、解析产物、报告、Checkpoint线程、向量point及可删除的trace | 删除覆盖[架构§10](architecture.md#10-可观测性隐私与部署门槛)列出的全部存储；中断后可继续；无法确认旧执行停止时不删除其资源；删除结果可核查 | 基础检查；test:integration |
| S3.2-T6 | API安全加固 | T2 | 请求频率限制（429 RATE_LIMITED）、请求体上限、生产配置校验、安全响应头 | 限流按owner/来源生效且不影响健康检查；生产配置缺失必需项时启动失败 | 基础检查；真实HTTP专项 |
| S3.2-T7 | 阶段回归与文档 | T1–T6 | API/契约、部署、架构、测试、进度；前端F3.1契约说明 | 未登录与越权访问被拒绝；删除覆盖全部存储 | 基础检查；test:integration；openapi:check；文档链接与git diff --check |

### S3.3 任务拆分：质量评测与发布准备

| 任务 | 目标 | 依赖 | 产出 | 验收 | 检查 |
|---|---|---|---|---|---|
| S3.3-T1 | 评测数据集 | S3.2、维护者提供授权数据或确认合成方案 | 至少20份简历与100–300条JD的合成或授权脱敏数据；标注说明；维护者完成的标注 | 数据来源与授权记录清楚；脱敏不代替授权；标注由人完成 | 数据清单核对 |
| S3.3-T2 | 质量评测脚本与报告 | T1 | 引用有效率、结构化正确率、unknown合理性、逐要求判断质量、Recall@K、费用的计算与报告 | 指标只基于实际标注；上线阈值由维护者依据数据确定，不预设准确率 | 基础检查；评测运行记录 |
| S3.3-T3 | 故障注入 | S3.2 | 覆盖[架构§6.3](architecture.md#63-故障窗口与结果)故障窗口的注入脚本：Worker强杀、broker重启、PostgreSQL/Qdrant/Langfuse不可用 | 每个窗口的实际结果与表中预期一致或记录为缺陷；只操作本项目实例 | test:integration；故障注入记录 |
| S3.3-T4 | 性能与预算实测 | S3.2 | 创建任务p95、单次分析耗时、token与费用的实测记录 | 记录样本规模与环境；不把目标值写成保证 | 实测记录 |
| S3.3-T5 | 备份恢复演练 | S3.2 | 业务库与Checkpoint库、文件、RabbitMQ定义的备份与恢复步骤；Qdrant从PostgreSQL重建 | 在隔离环境完成一次恢复并核对数据；不覆盖现有实例 | 演练记录 |
| S3.3-T6 | 依赖安全审计 | S3.2 | 依赖漏洞与许可证审计、处置记录与升级策略 | 高危问题有处置或记录接受理由；升级后冻结安装与回归通过 | pnpm audit；基础检查；test:integration |
| S3.3-T7 | 部署方案 | S3.2 | 按D10的部署配置：反向代理（与前端同源）、TLS、密钥管理、API就绪检查、Worker/发布器/对账器进程监督 | 配置可在目标环境复现；就绪检查反映数据库/队列可用性；无密钥入库 | 部署验证记录 |
| S3.3-T8 | 目标环境回归 | T7、维护者提供目标服务器 | 在目标环境连续运行 `pnpm test` 3次与 `pnpm run test:integration` 2次，核对Qdrant集合创建耗时 | 全部通过则解除L1/L2；仍失败则按缺陷重新定位 | 回归记录 |
| S3.3-T9 | 发布文档与交接 | T1–T8 | README、部署、运维手册、进度 | 文档只描述已验证行为；未执行项如实记录 | 文档链接与git diff --check |

2026-11-28 T8执行记录：目标服务器尚未提供，按既定“统一验收前延后”规则保留，不标为已执行。目标回归仍要求同批次3次基础、2次完整集成全部通过，并核对默认Docker Qdrant创建的原5秒性能目标；本机15秒上限下的通过、原生Qdrant对照或单次最终153/153均不替代此门禁。目标镜像digest/构建、Linux信号/host networking、TLS/浏览器和备份回滚也须在维护者提供环境后验证。检查清单见[发布运维](release-operations.md#s33-t8目标环境验收清单)，SocketTimeout/L1/L2状态不变。

## 6. 待决策事项

| 编号 | 决策 | 当前候选 | 确认条件 | 阻塞阶段 |
|---|---|---|---|---|
| D1 | 六维Rubric | **已确定**（2026-11-27）：AI按需求§2起草Rubric v1，维护者在统一验收时审核 | 行为标准、证据门槛和等级映射；20/40/60/80/100仅为示例 | 已解除；见S2.2-T6 |
| D2 | LLM服务商与具体模型 | **已确定**（2026-11-27）：经第三方中转站调用，OpenAI兼容接口；baseURL、Key与模型名由维护者在本地配置中提供（统一验收时填写）。维护者知悉中转站可接触发送的简历文本，发送前须移除联系方式 | 结构化输出能力、模型标识与版本、数据区域、预算 | 已解除；真实验证延后到统一验收 |
| D3 | Embedding模型 | **已确定**（2026-11-27）：阿里云百炼文本向量；具体模型ID与维数在S2.3-T7按官方文档核对 | 中文技能检索效果、向量维数、模型版本、费用、区域 | 已解除；真实验证延后到统一验收 |
| D4 | Langfuse部署 | **已确定：本地独立自托管**（2026-11-25） | T4接入时核对资源、镜像、SDK/服务端版本；默认脱敏，不启用云端上报 | 部署方向已解除阻塞；T4/T5实施记录见progress |
| D5 | 前端框架 | **已确定**：Vue 3 + TypeScript + Vite | 见[前端ADR-0001](https://github.com/Mingan-X/Resume-Studio-Frontend/blob/main/docs/decisions/0001-frontend-stack.md) | — |
| D6 | 文件范围 | **已确定**（2026-11-27）：带文本层的PDF与正文/表格含文本的DOCX，不做OCR；扫描、加密、损坏、空文本明确拒绝 | OCR是否首版必须、费用与隐私；复杂版式质量样本 | 已解除 |
| D7 | 评分与数据政策 | **已确定**（2026-11-27）：首次评分用评分政策六维权重、默认等权；verdict系数1/0.5/0/0；unknown单列；硬partial/unknown和未完成候选pending（硬unmet优先ineligible）；仅eligible进Top10；简历上传满30天清理关联分析/报告/Checkpoint/可关联trace、岗位语料保留；主动删除全部业务数据含JD/语料/向量/自定义规则，保留账号 | S2.5确认评分边界；S3.2本轮维护者确认保留起算与主动删除范围 | 已解除；见S2.5-T7、S3.2-T4/T5 |
| D8 | OpenAPI生成方式 | **已确定并在T9接入：`@asteasolutions/zod-to-openapi` 9.1.0**（2026-11-26，与Zod契约同源） | 已核对registry/官方包文档及peer，冻结安装、生成/过期检查通过；结果见progress | 已解除 |
| D9 | 认证方案 | **已确定**（2026-11-27）：本地账号+服务端会话（HttpOnly、Secure、SameSite Cookie）+CSRF；账号由命令行创建，不开放自助注册，不接第三方登录 | 部署形态、是否需要第三方登录、会话存储 | 已解除；见S3.2-T1 |
| D10 | 生产部署形态 | **已确定**（2026-11-27）：单机Docker Compose（反向代理、前端静态资源、API、Worker、发布器、对账器同机） | 数据区域、备份、TLS、成本 | 已解除；目标服务器上的验证延后到统一验收 |
| D11 | 文档解析依赖 | **已确定**（2026-11-27）：pdfjs-dist（PDF）、mammoth（DOCX）、yauzl（流式ZIP检查）；S2.1-T1按当时registry复核版本 | registry版本、engines/peers、维护状态与许可证；冻结安装与最小运行实验；不引入Python服务或第三方云端解析 | 已解除 |

已确定的技术方向不因上述配置待定而重新选型，不提前添加没有明确需求的组件。
