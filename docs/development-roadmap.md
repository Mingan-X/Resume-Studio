# 开发计划

本文是后端阶段划分、任务拆分和验收标准的唯一来源。每个阶段的完成情况记录在[开发进度](progress.md)；前端计划见[前端路线图](https://github.com/Mingan-X/Resume-Studio-Frontend/blob/main/docs/development-roadmap.md)。未标记为“已完成”的内容都不是已交付能力。

## 1. 阶段总览

阶段编号同时用于分支命名（`feature/s1.3-<功能名>`，见[CONTRIBUTING](../CONTRIBUTING.md)）。

| 阶段 | 名称 | 主要交付 | 依赖 | 阻塞决策 | 状态 |
|---|---|---|---|---|---|
| S1.1 | 工程基线 | 依赖锁定、ESM/装饰器编译、类型检查/Lint/测试、API与空Worker入口、Zod配置、统一HTTP错误、requestId日志 | — | — | 已完成 |
| S1.2 | 基础设施诊断 | Compose项目隔离、PostgreSQL/Prisma诊断表与迁移、RabbitMQ confirm/return/ACK、Qdrant CRUD、重启持久化工具 | S1.1 | — | 已完成 |
| S1.3 | 工作流持久化与观测 | 官方PostgreSQL Checkpointer接入与恢复验证、OTel/Langfuse接入与脱敏 | S1.2 | D4 已确定本地自托管 | 已完成（2026-11-25，附已知环境限制L1） |
| S1.4 | 任务与消息可靠性 | 两类任务、Outbox、消费收据、租约/fence、重试/DLQ、对账、任务查询/取消API | S1.3 | D8 | 未开始 |
| S2.1 | 简历文件与证据 | Storage、上传、PDF/DOCX解析、文本块与结构化简历 | S1.4 | D6 | 未开始 |
| S2.2 | JD与Rubric | JD草稿/结构化/确认/不可变发布、JobIndexTask、六维Rubric版本 | S1.4 | D1、D2 | 未开始 |
| S2.3 | 岗位召回 | 技能关键词、Qdrant索引、Dense Vector、RRF融合、CandidateSet | S2.2 | D3 | 未开始 |
| S2.4 | 六维画像与逐项匹配 | Profile/Matching节点、结构化判断、预算与部分失败 | S2.1、S2.3 | D1、D2 | 未开始 |
| S2.5 | 确定性评分与排名 | 评分纯函数、冻结判断、Top10、调权重算 | S2.4 | D7 | 未开始 |
| S3.1 | 报告与进度API | 报告快照与历史、TaskEvent进度、SSE、前端所需全部查询接口 | S2.5 | — | 未开始 |
| S3.2 | 身份、权限与数据生命周期 | 登录、所有权检查、保留与删除链路 | S3.1 | D9、D7 | 未开始 |
| S3.3 | 质量评测与发布准备 | 标注评测集、故障注入、备份恢复、依赖审计、部署方案 | S3.2 | D10 | 未开始 |

S1.1与S1.2是同一次初始化提交交付的基线，没有独立历史分支；它们的验证证据见[开发进度](progress.md)。资源名中的 `s12` 即 S1.2 诊断阶段的标识，为兼容已应用迁移而保留。

状态只使用：未开始、进行中、待验收、已完成、已搁置。状态变化必须同时更新本表和[开发进度](progress.md)。

## 2. 任务规范

只有当前阶段和下一阶段拆分到任务级；更后的阶段保留交付内容和验收要求，在阶段开始时按本节模板补充任务并经维护者确认，避免远期计划与实际实现脱节。

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

2026-11-25重新验收：T1–T7.4通过；T7.5中构建后首次 `pnpm test` 的有效配置API启动用例超过8秒失败，判定为本机机械硬盘冷启动造成的环境限制。维护者决定接受S1.3并记录为已知环境限制L1，在部署服务器或硬件满足条件后重新验证（已加入S3.3验收要求）。验收记录、L1的判断依据与处理规则见[开发进度](progress.md)。D4采用同一resume-studio项目的observability profile，专属网络、账号和数据卷，显式服务列表独立启停。分支feature/s1.3-checkpoint-setup，未推送、未合并。

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

## 5. 后续阶段交付与验收

以下阶段在开始时按第2节拆分任务。

| 阶段 | 交付内容 | 验收要求 |
|---|---|---|
| S2.1 简历文件与证据 | StoragePort与本地实现、`POST /api/v1/resumes` 上传、简历列表与版本详情接口、文件签名/大小校验、PDF/DOCX文本块、结构化简历 | 正常、损坏、加密、扫描、双栏、表格样本；无任意路径读写；引用可逐字核对；空文本不算成功；多任务不串数据；DOCX/ZIP解压总量、条目数、压缩比、路径穿越限制；解析CPU/内存/总耗时上限。扫描PDF明确拒绝或提示不支持，首版不承诺OCR |
| S2.2 JD与Rubric | JD入库与结构化、要求确认、不可变版本、发布事务内创建JobIndexTask与Outbox、六维Rubric版本；岗位草稿、确认、发布与列表接口 | 要求来源可追踪；硬门槛和权重确认后才发布；旧索引执行不能把新版本标为READY；所有权检查 |
| S2.3 岗位召回 | 技能字典与关键词召回、Qdrant索引、Dense Vector、RRF融合、CandidateSet冻结 | 至少100条合成JD；索引幂等；旧版本不混入；维数变化建新collection；中文技能相关性标注；向量失败显式降级 |
| S2.4 六维画像与逐项匹配 | Profile与Matching节点、结构化判断、预算控制与部分失败；分析任务创建接口 `POST /api/v1/analyses` | 六维只作辅助上下文；逐要求基于证据判断；unknown不伪装成低分；计划内要求都有结果或未完成状态；400条默认预算超限时返回截断与未完成数量；模型不输出总分；拒绝伪造或越界引用；并发受限 |
| S2.5 确定性评分与排名 | 评分纯函数、冻结判断、Top10、调权重算 | 固定输入重复100次结果一致；缺失/负数/NaN/Infinity/零总权重/重复ID/不支持维度/同分/unknown边界；重算不调用模型；原候选第11名可进入新榜单；不足10条不补造 |
| S3.1 报告与进度API | 报告快照与历史、TaskEvent、SSE、调权重算接口、前端所需列表与详情接口 | 报告关联输入、候选、画像与匹配判断、Rubric与评分版本；刷新、断网、重启后仍可查；PARTIAL显示覆盖率；SSE按seq补读；API返回前端展示所需的全部计算结果，前端不自行计算分数 |
| S3.2 身份、权限与数据生命周期 | 登录与会话、资源所有权检查、保留期限、用户数据删除 | 未登录与越权访问被拒绝；删除覆盖文件、产物、Checkpoint、向量与trace；删除前取消活动任务 |
| S3.3 质量评测与发布准备 | 合成或授权脱敏的标注评测集、预算与性能数据、部署与运维方案 | 至少20份简历与100–300条JD的目标集；人工标注质量评估；故障注入；备份恢复演练；依赖安全审计；实测时延；在目标服务器或满足条件的硬件上解除已知环境限制L1：连续运行 `pnpm test` 3次与 `pnpm run test:integration` 2次全部通过，并核对Qdrant集合创建耗时 |

模型评测关注引用有效率、结构化正确率、unknown合理性、逐要求判断质量、Recall@K与推荐相关性以及费用，不只判断输出非空。上线阈值须依据标注数据确定，不预先宣称准确率。

恢复和重试保持原任务身份与冻结输入；重新分析或重新召回创建新的AnalysisTask和报告，不覆盖历史。NodeArtifact的operationKey需覆盖输入、组件/Schema及适用的prompt/model版本，并以jobVersionId及必要的requirementId/batchId区分并行分支。

文档中的并发数、超时、重试、租约和400条默认判断预算是待验证参数，不是生产级保证。

## 6. 待决策事项

| 编号 | 决策 | 当前候选 | 确认条件 | 阻塞阶段 |
|---|---|---|---|---|
| D1 | 六维Rubric | 每维L1–L5及unknown | 行为标准、证据门槛和等级映射；20/40/60/80/100仅为示例 | S2.2、S2.4 |
| D2 | LLM服务商与具体模型 | 未选定 | 结构化输出能力、模型标识与版本、数据区域、预算 | S2.2、S2.4 |
| D3 | Embedding模型 | 未选定 | 中文技能检索效果、向量维数、模型版本、费用、区域 | S2.3 |
| D4 | Langfuse部署 | **已确定：本地独立自托管**（2026-11-25） | T4接入时核对资源、镜像、SDK/服务端版本；默认脱敏，不启用云端上报 | 部署方向已解除阻塞；T4/T5实施记录见progress |
| D5 | 前端框架 | **已确定**：Vue 3 + TypeScript + Vite | 见[前端ADR-0001](https://github.com/Mingan-X/Resume-Studio-Frontend/blob/main/docs/decisions/0001-frontend-stack.md) | — |
| D6 | 文件范围 | 文本层PDF与DOCX | OCR是否首版必须、费用与隐私；复杂版式质量样本 | S2.1 |
| D7 | 评分与数据政策 | unknown单列、硬条件待核实、eligible进Top10；真实数据默认保留30天 | 目标岗位类型、权重、真实数据授权与保留时间 | S2.5、S3.2 |
| D8 | OpenAPI生成方式 | `@asteasolutions/zod-to-openapi`（与Zod契约同源）；`@nestjs/swagger` 依赖class-validator DTO，与现有Zod边界不一致 | 2026-11-24 registry核对：前者9.1.0、peer `zod ^4.0.0`；接入时重新核对并真实编译 | S1.4-T9 |
| D9 | 认证方案 | 同源部署下的服务端会话（HttpOnly、Secure、SameSite Cookie）+ CSRF防护 | 部署形态、是否需要第三方登录、会话存储 | S3.2 |
| D10 | 生产部署形态 | 单机Compose或托管容器平台 | 数据区域、备份、TLS、成本 | S3.3 |

已确定的技术方向不因上述配置待定而重新选型，不提前添加没有明确需求的组件。
