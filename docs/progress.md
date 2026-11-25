# 开发进度

按时间倒序记录每个阶段或任务的完成情况与验证证据。阶段定义与状态总表见[开发计划](development-roadmap.md)。

记录规则：

- 每条记录写明日期、阶段/任务编号、分支或提交、完成内容、执行的检查及结果、未执行项及原因。
- 只记录实际运行过的检查。验证结果只代表当时的环境，不能推广为其他平台或生产环境已验证。
- 已有记录不改写；发现错误时追加更正记录。

## 2026-11-25 S1.3-T7 提交后连续回归：未全部通过（分支 feature/s1.3-checkpoint-setup）

T7.1–T7.4已实现并按任务本地提交；T7.5规定的检查次数执行完毕，但因首次基础回归失败，**不满足连续全部通过**，不能声称T7或阶段验收已通过。按维护者指示将S1.3状态置为“待验收”，明确保留失败供重新验收；未推送、未合并。

本地提交对应关系：

| 提交 | 内容 |
|---|---|
| 260b25a | S1.3-T1：工作流/观测依赖、锁文件、类型补丁及依赖说明 |
| 93ef449 | S1.3-T2/T3：独立Checkpointer初始化与合成恢复 |
| 8c98e0f | S1.3-T4/T5：本地Langfuse、独立启停、有界脱敏观测与测试 |
| 9ff5683 | S1.3-T7.1/T7.2：先校验后加载、独立启动错误、模块钩子验证、Qdrant归属/对账/manifest |
| f5d9e8b | S1.3-T6/T7.3：文档交接、历史验收与提交前检查记录 |

T1–T6原未提交源码/配置/依赖均保留；原progress历史条目未改写。本轮只在指定T7范围内增加修复。工作区在回归开始前已干净；以下五次均针对 **f5d9e8b**，同一Windows/Node24.22.3/pnpm12.23.0环境、九服务保持运行、无代码/配置/依赖变更、无手动warm-up或服务停机。完成后只追加本条记录与阶段状态提交，不改变已测试代码。

提交后实际执行（本地时间Asia/Shanghai；耗时含pnpm构建，取进程墙钟）：

| 顺序 | 开始时间 | 命令 | 通过/失败/跳过 | 耗时 | Qdrant残留 / 待清理manifest |
|---|---|---|---|---|---|
| 1 | 17:46:16 | `pnpm test` | 21 / 1 / 0 | 36.233秒 | 0 / 0 |
| 2 | 17:47:26 | `pnpm test` | 22 / 0 / 0 | 10.265秒 | 0 / 0 |
| 3 | 17:48:02 | `pnpm test` | 22 / 0 / 0 | 9.580秒 | 0 / 0 |
| 4 | 17:48:40 | `pnpm run test:integration` | 10 / 0 / 0 | 47.376秒 | 0 / 0 |
| 5 | 17:50:00 | `pnpm run test:integration` | 10 / 0 / 0 | 38.235秒 | 0 / 0 |

首次失败为 `process.test.ts` 的有效配置API/Worker生命周期用例，报 `Child api did not start`，用例约8.086秒触发原8秒ready限制。原缺配置用例及新增registerHooks“不加载Nest”用例均通过。这表明T7解决了无效配置路径，但不能据此宣称有效配置冷启动的环境敏感性已消除。此次失败未做分段采样，不能把旧诊断的I/O结论等同于本次已证实根因。

基础回归三次连续结果不是全通过，后两次通过没有覆盖第一次失败；没有追加同版本循环来“刷绿”。两次真实集成通过，Qdrant原创建超时/CRUD/维数断言未放宽，客户端仍5秒。新增对账主要由HTTP桩验证迟到创建，真实回归中未发生create超时，不声称这两次真实运行复现了迟到创建路径。

每次回归后均通过ownedQdrant检查项目、服务、端口、挂载和卷标签，再只读读取集合列表；起始和五次结束的全部集合数、s12_*集合数、data/qdrant-cleanup manifest数均为0，本轮未执行人工删除残留。原始命令日志、精确时间、HEAD和逐次残留数据位于本机忽略目录data/t7-validation，非凭证数据，不入库。

其他检查详见前一条：初次构建通过；专项7/7通过；typecheck通过；Lint首次cause规则失败，修复后零警告；diff-check首次空行失败，修复后通过；文档本地链接/锚点与忽略边界通过。末次收尾再次确认文档无运行计数副本、历史记录完整、未纳入凭证/生成文件。

未执行及遗留：未重新安装、未迁移SSD、未调整Docker资源/存储/WAL、未升依赖、未改超时/测试调度/断言、未处理ObservabilityService全局provider生命周期、未运行持久化重启或真实LLM。有效API启动仍有一次8秒失败，需维护者在此证据基础上安排后续定位，T7.5不得标为通过。未知创建若超过15秒清理期限仍可能迟到，manifest作为明确待处理记录保留；不会自动清理其他轮次或按前缀批量删除。旧persistence.fixture.ts清理入口的历史限制未扩展修复。

## 2026-11-25 S1.3-T7 实现及提交前检查（分支 feature/s1.3-checkpoint-setup）

按维护者给定T7.1–T7.5执行；此条记录提交前工作，提交后的连续回归另追加，不改写原验收失败记录。T1–T6已有未提交文件先保留本机基线快照（data/t7-baseline）；原Checkpoint与观测实现、依赖解析、配置和历史进度均保留。

- T7.1：API/Worker先校验配置，再动态加载各自bootstrap；startup-error只依赖配置模块，不依赖Nest或AppLogger。拆分API/Worker装配，原启动/关闭事件与错误格式不变。新增module.registerHooks预加载测试，实际记录缺配置/非法配置路径未加载Nest或任一bootstrap；原进程测试10秒/8秒限制及所有原断言保留。
- T7.2：Qdrant创建失败后最多15秒对账，每次请求最长5秒且受剩余期限约束；首次exists=false继续等待。出现后检查项目、服务、loopback端口、storage挂载及卷标签，只删除本轮UUID对应集合，并确认消失。无法确认或归属不符写data/qdrant-cleanup/<runId>.json并明确失败；即使清理成功也继续抛原创建错误。原真实客户端5秒、集成父测试45秒及CRUD/维数断言不变。
- 新增可控HTTP迟到创建测试、未确认manifest测试、归属拒绝测试和归属字段校验；原S1.2持久化辅助工具未扩展。
- T7.3：除progress外移除运行通过/失败计数，测试文档“当前验收状态”只链接最新进度；同步入口和清理边界。历史研究文件标注为修复前快照，不用新行为改写旧测量。
- T7.4：将按依赖、Checkpoint、观测、入口/清理修复、文档分组本地提交；不推送、不合并。T7.5提交后连续回归尚未开始，此条不宣称通过。

提交前检查（按实际执行顺序）：

| 检查 | 结果 |
|---|---|
| 初次 `pnpm run build` | 通过；该次未单独采集完整墙钟耗时 |
| `node --test dist/test/process.test.js dist/test/qdrant-cleanup.test.js` | 7通过、0失败、0跳过，命令墙钟7.820秒 |
| 第一次 `pnpm run lint` | 失败，10.079秒；AggregateError缺少catch错误的cause，修复为保留原操作错误与清理错误并设置cause |
| `pnpm run typecheck` | 通过，6.135秒 |
| 第二次 `pnpm run lint` | 通过，7.763秒，零警告 |
| 本地文档链接/锚点检查 | 通过：15份Markdown、133个本地文件链接、26个锚点；无运行计数副本 |
| 首次 `git diff --check` | 失败：lifecycle.ts末尾多余空行；去除后再次检查通过 |
| 保留/忽略边界 | 历史progress原样保留；凭证、data、dist和Prisma生成目录均被忽略；原观测provider和业务基础设施配置未改 |

本轮未迁移SSD、未调整Docker资源、未升依赖、未提高测试/客户端超时、未修改观测provider生命周期。已知本机存储性能限制仍存在；有界对账不保证超过期限的迟到创建在本次运行中清理，故保留manifest并失败。下一条提交后记录将如实列出每次回归及残留情况，不能用重跑覆盖任何失败。

## 2026-11-25 S1.3 阶段验收：未通过（分支 feature/s1.3-checkpoint-setup）

验收人：维护者委托的审查AI。对象为分支工作区中尚未提交的T1–T6改动（基于master `dc6002d`，25个新文件、11个修改文件）。本次只运行检查和阅读代码，没有修改源码、测试、配置或依赖。

环境：Windows，Node 24.22.3，pnpm 12.23.0；resume-studio项目九个容器在检查前均为healthy。

本次实际执行：

| 检查 | 结果 |
|---|---|
| `pnpm run typecheck` | 通过 |
| `pnpm run lint` | 通过，零警告 |
| `pnpm test` | 17项：16通过、1失败、0跳过。失败用例为 `process.test.ts` 的“both real entrypoints fail closed on missing configuration”，`spawnSync` 启动 `main-api.js` 在10秒时ETIMEDOUT |
| `node --test dist/test/process.test.js`（单独运行） | 2项全部通过，约2.2秒与1.3秒 |
| `pnpm run test:integration` | 10项：10通过、0失败、0跳过。Qdrant子测试约10.5秒，本次未出现创建超时 |
| 集成测试后Qdrant集合 | 共0个，`s12_*` 残留为0 |
| 本地凭证与运行数据 | `infra/.env`、`infra/.env.checkpoint`、`infra/.env.observability`、`data/` 均被 `.gitignore` 忽略 |
| `git diff --check` | 通过（仅有LF/CRLF转换提示） |

逐项结论：

| 任务 | 结论 | 依据 |
|---|---|---|
| T1 | 通过 | 精确版本；严格peer未放宽；两份补丁只修改 `.d.ts` 声明 |
| T2 | 通过 | 重复setup不增加表或迁移；业务与Checkpoint账号互相拒绝连接；运行账号DDL被拒；setup使用advisory lock，API/Worker不调用 |
| T3 | 通过 | 先从数据库确认首个Checkpoint落盘再强杀，进程退出后以原thread与 `invoke(null)` 续跑，节点执行记录不重复；首Checkpoint前强杀时从独立输入重启 |
| T4 | 通过 | 真实Langfuse读回全部导出span，父子关系与correlationId正确；OTel为2.x线 |
| T5 | 通过 | 拒绝连接、无响应、503、部分拒绝四种故障均经过真实HTTP；合成图成功且丢失有计数；白名单脱敏，合成手机号/邮箱/密钥未出现在上报数据中 |
| T6 | 需更新 | README、ADR、架构、测试文档中写入的“15/2”“8/2”等计数已与本次结果不一致 |

阻塞项：

1. `pnpm test` 不能稳定通过，不满足路线图“任务完成的定义”第2条。同一用例单独运行约2秒，与其他测试文件并行时超过10秒，与[专项排查](research/failure-diagnosis-2026-11-25.md)中“校验配置前加载648个模块”的结论一致。S1.3新增的测试文件在并行时加载LangGraph等依赖，加重了负载，视为本阶段引入的回归。
2. 全部S1.3改动未提交，无法进行代码审查与合并。

非阻塞观察：

- Qdrant创建超时本次未复现；专项排查显示停止观测服务后仍会超时，主要属于本机机械硬盘环境问题。超时后“迟到创建”的清理窗口仍是确定存在的测试逻辑缺口，纳入S1.3-T7修复。
- `ObservabilityService` 注册全局provider，并在关闭时调用 `trace.disable()`、`context.disable()`；同一进程存在多个实例时，关闭其一会影响其他实例。当前只有测试使用，留待S1.4或后续接入业务进程时处理。

处理：S1.3状态由“待验收”改回“进行中”；新增任务S1.3-T7（见[开发计划](development-roadmap.md#3-s13-工作流持久化与观测)）。T7完成并按任务提交后重新验收。

未执行：重新安装依赖、持久化重启实验、观测服务停机实验、registry在线版本核对。集成测试按原设计写入本轮合成数据并已自动清理。

## 2026-11-25 S1.3 验收失败专项排查（分支 feature/s1.3-checkpoint-setup）

用户要求说明失败原因和解决方案后，完成分段计时、存储对照及清理窗口分析，完整证据见[排查报告](research/failure-diagnosis-2026-11-25.md)。正式源码、断言、超时和服务配置未修改；S1.3仍待验收，旧失败结果没有被本次诊断成功覆盖。

- 启动路径实测：缺配置也先加载648个模块，Worker与API共用bootstrap；原入口在HTTP/观测测试加载竞争下耗9.369秒，CPU约0.781秒。临时最小配置校验原型97个模块，在同轮负载下0.144秒；该样本受缓存影响，不承诺固定冷启动指标。有效API的创建/监听仅222/22ms，主要耗时集中于导入而非监听。
- 存储现场：项目、pnpm store及Docker数据VHD在E盘SATA机械硬盘，I/O等待明显；C为NVMe但剩余空间约20.0GB，小于Docker数据盘文件约22.2GB，未执行迁移。
- Qdrant对照：原卷默认WAL创建2.9–4.5秒，缩小WAL仍约4.0–4.7秒；停止Langfuse后仍测到6.46秒。相同镜像新建的无网络/tmpfs临时实例创建约3.6–3.8毫秒，支持主要瓶颈在持久化存储路径；低层寻道/分页/VHD同步等占比尚未分离。观测停止并不能消除问题。
- 清理缺口：现有finally一次exists=false不能排除迟到创建，需要有界对账和可恢复manifest；与存储性能问题分别修复。
- 给出三项优先方案及验收：配置先校验/入口拆分、精确资源对账清理、容量足够后迁往SSD；不直接提高原超时、跳过断言、关闭安全软件或将真实数据卷替换为tmpfs。

实验使用本轮6个合成collection，清理前检查项目容器/端口/卷，均已按精确UUID清理；tmpfs临时容器仅使用本轮唯一标签且无现有卷挂载，已删除。首轮临时容器readyz解析脚本错误已记录，不隐去失败。观测组在实验中独立停止后恢复，结束时九服务健康。诊断PUT使用15秒观测窗口获取真实服务端时间，不修改或替代正式5秒测试；没有重跑完整验收或宣称修复完成。原始计时与脚本位于本机忽略目录data/failure-diagnosis。

## 2026-11-25 S1.3-T6 文档核对与验收交接（分支 feature/s1.3-checkpoint-setup）

T6文档交付完成；S1.3整体仍为待验收，未提交或合并。此条补充T4/T5期间的文档同步，旧记录原样保留，不将其历史通过覆盖本次失败。本轮只修改Markdown，保留T1–T5全部已有源码、配置和依赖改动。

完成内容：

- 依赖说明统一当前已接入版本、两份类型声明补丁及未接入候选，消除“Checkpointer仍待测试”“工作流与观测仍是候选”的过时表述；来源区分本地清单、2026-11-23/24研究快照和2026-11-25接入记录。
- 架构补充当前入口/模块接线表，区分恢复与观测的两套合成测试、未接入的业务图、跨进程trace传播和S1.4 fence目标；注明脱敏发生于span结束时，排队期限不覆盖活动span或无限生产场景。
- 部署文档分开诊断组件初始化与API/Worker启动，补充完整集成准备顺序；统一九服务、同项目双网络、两组显式启停、原卷映射与凭证恢复边界。持久化重启示例明确指定业务三个服务。
- 测试文档增加当前验收状态表，修正17/10项统计及旧S1.2清理的归属/迟到创建窗口；移除“并发造成超时”的确定性归因，根因仍未定位。
- 路线图增加T1–T6的实现/验证入口及边界，README和ADR同步当前状态。T6文档收尾不使S1.3自动变为已完成。

本次实际执行：

| 检查 | 结果 |
|---|---|
| `pnpm run typecheck` | 通过 |
| `pnpm run lint` | 通过，零警告 |
| `pnpm test`中的构建 | 通过 |
| `pnpm test` | 17项中15通过、2失败、0跳过；缺配置启动用例的子进程ETIMEDOUT，正常API/Worker生命周期用例报Child api did not start |
| `pnpm run infra:config`、`pnpm run observability:config` | quiet配置解析通过，不输出展开凭证 |
| 文档静态核对 | 14份Markdown的本地文件链接、章节锚点及pnpm脚本名有效；36个直接依赖的声明/锁文件specifier/已安装版本一致，2份patch引用存在 |
| 修改边界与历史记录 | 非Markdown文件清单及内容哈希与T6开始时一致；旧progress条目未改写 |
| `git diff --check` | 通过 |

未执行：真实服务集成、重新安装、容器启停/迁移、数据库setup、上游在线版本与外链可达性核验。本轮只核对文档，不重跑会写入外部服务或生成待清理资源的实验；已有集成与迁移证据沿用历史记录并标注日期。没有修复进程/Qdrant问题，没有改超时、调度或断言，也未重复运行测试以获得通过结果。

当前验收遗留：基础测试本轮为15/2；最近完整集成仍是T4/T5末次的8/2（Qdrant子测试及父测试失败），串行化未消除超时。进程启动超时、Qdrant创建超时及迟到创建清理窗口需后续定位并验证，再由维护者验收阶段。历史17/17或10/10只代表当次运行，不能代替当前结果。

## 2026-11-25 S1.3-T4/T5 本地观测、故障隔离及Compose整合（分支 feature/s1.3-checkpoint-setup）

T4/T5实现及专项验证完成，T6相关文档同步；整体回归仍有Qdrant创建超时，S1.3待验收，未宣称全部检查稳定通过；尚未提交或合并。保留同阶段T1–T3的未提交改动，前端仓库未修改。

完成内容：

- 固定Langfuse SDK6.1.1、OTel api1.9.0/SDK2.12.1/协议0.223.2；官方Langfuse callback与手工span共享trace及correlationId。ObservabilityModule按需注册，仅接入合成图，API/空Worker业务路径保持原状。
- 白名单脱敏在进入SDK异步队列之前执行；输入/输出标记REDACTED，自由元数据、异常/事件文本、traceState及资源属性不出网。关闭媒体上传及SDK原始参数日志。配置限制本地地址、队列容量与超时，错误只报告字段名。
- 活动及待导出span共用有界容量；单请求在途、批量/字节限制、排队期限、HTTP总超时、零自动重试；传输失败/部分拒绝/队列满/过期/关闭计入分类丢失计数，业务图不受导出失败影响。
- 本地Langfuse web/worker4.84.0、PostgreSQL16、Redis7、ClickHouse26.3.62.3、MinIO均固定digest。最初另建观测Compose项目，维护者要求统一管理后，已改为同一resume-studio项目、六个langfuse-*服务、observability profile和专属网络；业务与观测脚本均显式列出目标服务，避免整个项目stop/down造成连带停止。
- 迁移前记录原容器/挂载/凭证哈希并持久化合成trace；停止旧六服务后，新服务直接挂载五个原卷，使用原账号和凭证。通过查询读回迁移前6个span及correlationId，确认业务三容器ID/启动时间未变后，删除旧的已停止容器和空网络。未删除任何卷。旧卷名/标签保留并显式映射、核对来源；本机回滚资料保存在data/observability-project-migration，不提交。
- 独立启停实测：停止/启动观测组，业务三服务保持运行；停止/启动业务组，六个Langfuse容器ID/启动时间及健康状态不变，Web健康HTTP200。最后九个容器全部健康；业务仅在default网络，Langfuse仅在observability网络，旧项目无容器。

验证记录：

- `pnpm install --frozen-lockfile --offline`通过，使用本机缓存；`build`、`typecheck`、零警告`lint`通过。
- `pnpm test`最终17项通过，0跳过。OTLP捕获检查callback/手工span父子关系和关联ID，模拟电话/邮箱/密钥未出现在HTTP请求中；关闭端口、无响应、503、部分拒绝均真实经过HTTP传输；200个span冲击8容量，接受8、丢弃192并正确计数。
- 真实Langfuse持久化测试通过：从v2 observations接口读回所有已接受span、关联字段与脱敏结果；测试只提交本轮随机trace的删除请求，上游异步删除不等于完整数据生命周期验收。
- 观测容器实际全部停止时，合成图仍返回9，5条span因传输失败丢失且被计数；随后服务恢复。
- 整套集成按文件串行运行曾10项全部通过；但随后标准 `pnpm run test:integration` 复验再次在Qdrant创建集合处超时，最终8项通过、2项失败（Qdrant子测试及其父测试）。Checkpoint与Langfuse专项均通过。test:integration使用test-concurrency=1降低共享资源竞争，各项原有并发断言和5秒限制不变；串行化没有消除该不稳定问题。
- 重复init不覆盖本地凭证；Compose quiet配置、归属/网络/挂载检查及文档相对链接检查通过。服务端健康接口返回4.84.0。

失败与限制如实保留：首次Langfuse冷启动的上游迁移超过240秒等待窗口；未重置库，等待迁移完成，并修正HOSTNAME与worker等待web健康的启动顺序。初次真实写入检查发生在worker尚未就绪时，测试现要求六服务都健康。Windows冷加载/并行负载下曾出现原进程测试超时及本地捕获导出超时，按原限制重新执行后通过。完整并行集成两次发生Qdrant创建5.50/5.75秒超时，后续串行标准命令仍有5.60秒超时；服务端在客户端超时后创建了集合，按本轮三个精确UUID且核验容器/卷归属后清理。原S1.2清理仍存在迟到创建窗口，未把此次人工清理说成该测试已修复。独立基础设施测试与一次串行完整10项通过，但后续复验失败，根因仍待定位，不能仅归因于文件间并发。未提高5秒限制或跳过检查。

未验证：真实LLM调用、业务Outbox/fence、跨进程trace传播、长期观测负载、生产TLS/备份/灾难恢复和完整数据删除；Docker约5.8GiB内存，仅完成合成诊断。Langfuse登录凭证只在本机infra/.env.observability中；观测为可丢失数据，不能承诺可靠投递。原Qdrant本机HTTP/API Key提示仍存在。依赖补丁和SDK小版本升级需再次验证。

## 2026-11-25 S1.3-T1～T3 Checkpointer隔离与合成图恢复（分支 feature/s1.3-checkpoint-setup）

状态：实现及本地检查完成，待维护者审查；尚未提交/合并，S1.3整体仍进行中。维护者确认D4采用本地独立自托管Langfuse，服务部署与观测接入属于后续T4/T5，本批未部署Langfuse。

完成内容：

- T1：固定LangGraph 1.7.5、core 1.5.1、checkpoint 1.2.3、checkpoint-postgres 1.1.4；复核registry及包清单的engines/peers。补充NestJS漏声明的@standard-schema/spec 1.1.0；core/langsmith的声明使用可复现pnpm补丁，保留严格类型检查，说明见依赖文档。
- T2：增加checkpoint:init/provision/setup命令；独立数据库、langgraph schema、setup与运行账号，容器/端口/卷及资源归属校验；独立有界pg池和显式关闭。初始化调用官方setup，不加入Prisma迁移或API/Worker请求路径。provision收紧本项目诊断库PUBLIC CONNECT并保留诊断账号访问。
- T3：测试专用两节点StateGraph；输入独立保存在诊断表。实际强杀子进程并确认退出后，同thread以null输入续跑；已完成节点执行记录只有一条。首Checkpoint写入前强杀后，从独立输入重新启动并生成预期结果。未实现正式业务任务、Outbox或旧执行fence隔离。
- 本地依赖此前因目录迁移留下无效junction；将旧node_modules移至被忽略的data/s13-node-modules-backup-*保留，按冻结锁文件重建。没有删除凭证、数据库或数据卷。
- 同步README、架构、路线图、依赖、部署、测试和ADR的实现状态与D4决定。

环境：Windows，Node 24.22.3、pnpm 12.23.0；本项目Compose PostgreSQL/RabbitMQ/Qdrant容器。Docker引擎原未启动，本次启动后仅操作resume-studio项目资源。

已执行并通过：

- `pnpm install --frozen-lockfile --offline`：重建362个包；补丁提交后再次冻结安装成功。复用本机store，不等于联网冷安装。
- `pnpm run build`、`pnpm run typecheck`、`pnpm run lint`（零警告）。
- `pnpm test`：13项通过，0失败、0跳过。
- `pnpm run test:integration`：9项通过，0失败、0跳过（Checkpointer父测试及4个子测试，原基础设施父测试及3个子测试）；最后一次执行覆盖子进程去除管理凭证的修订。
- `pnpm run db:status`：原有1条Prisma迁移已应用，未新增或修改Prisma迁移。
- `infra:provision`、两次`checkpoint:provision`及首次`checkpoint:setup`通过；集成测试重复setup不增加表/迁移，不抹除已有线程。
- 权限实测：业务/Checkpoint账号跨库连接拒绝；运行账号创建表/schema及更新迁移版本表被拒绝；并发查询池不超过配置上限，关闭后连接数为0。
- 重复`checkpoint:init`前后凭证文件逐字节相同；测试结束后Checkpoint表记录及s13诊断记录均为0。
- `git diff --check`通过，文档相对文件链接检查通过。

过程中的失败与处理：最初类型检查发现上游可选字段声明不兼容，已用仅声明补丁修复；初次恢复测试发现测试SQL共用参数在UUID/text列上类型推导冲突，已显式转换。一次与Lint/编译同时进行的基础测试出现子进程启动超时，停止并行负载后按原命令与原超时重新运行，13项全通过，未放宽断言或时间限制。Qdrant保留本地HTTP/API Key提示，最后一次集成测试的后台版本探测也有警告，但CRUD/维数断言通过，未关闭兼容性检查。

未执行/限制：未接入真实模型、Langfuse/OTel或业务图；未验证多Worker租约/fence、旧thread迟到写入、生产TLS/认证、其他平台、备份恢复和新机冷安装。合成图恢复不证明模型调用恰好一次，正式隔离仍由S1.4-T7验收。pnpm补丁需在升级时复核；旧依赖备份保留在本机被忽略目录。

## 2026-11-24 文档重构（分支 feature/s1.3-docs-restructure）

- 为路线图补充阶段编号（S1.1–S3.3）、状态列、阻塞决策和S1.3/S1.4任务拆分。
- S1.3中依赖任务表fence的恢复隔离验收移到S1.4-T7，原因是相关字段在S1.4才建立。
- 新增[接口契约规范](api-contract.md)与本进度文档；验证记录从测试和部署文档移到本文。
- 前端框架决策D5确定为Vue 3 + TypeScript + Vite，详见前端仓库ADR-0001。
- 只修改文档，未运行类型检查、Lint或测试。

## 2026-11-24 S1.1 工程基线、S1.2 基础设施诊断（提交 c0881b3、f20769c）

两个阶段在同一次初始化中交付，没有独立历史分支。

环境：Windows主机，Node 24.22.3，pnpm 12.23.0，Docker 29.9.3，Compose 5.7.0，linux/amd64容器。

已执行并通过：

- 类型检查、零警告Lint、11项基础测试、4项真实服务集成测试（1个父测试与3个子测试）。
- Prisma generate/validate/deploy/status；第二次部署无pending migration，迁移记录一条。
- pg连接池上限3；Nest上下文关闭后池连接数为0。
- RabbitMQ：无路由的mandatory消息未被confirm误判为成功；未ACK的消息在关闭channel后重投；相同messageId可被重复交付。
- Qdrant：错误维数返回400；集合与点CRUD通过。
- 持久化重启实验：本项目三个容器重启后，数据库记录、持久消息和向量仍存在；专属测试资源已清理。
- 离线冻结安装通过，但复用了本机缓存，不等于新机器冷安装。

pnpm元数据调整后的安装验证：

- 改动：`package.json` 移除精确的 `packageManager` 字段，`engines.pnpm` 改为 `>=12 <13`。
- 在仓库外空目录复制package.json、锁文件、.npmrc和pnpm-workspace.yaml，使用独立的store、state、cache、config和temp目录及空的用户/全局npmrc，执行 `pnpm install --frozen-lockfile --store-dir <独立store> --state-dir <独立state> --reporter append-only`。
- 结果：退出码0，安装342个包，19个直接依赖版本与清单一致；安装前后清单、两份配置和锁文件逐字节一致。未使用非冻结安装，未跳过安装脚本。
- 该次验证在上述业务测试之后进行，没有重新运行业务与集成测试。

未验证：其他pnpm 12.x版本、Corepack自动选择、其他主机平台、Linux信号关闭行为、生产TLS与认证、完整依赖安全审计、多节点故障、备份恢复。

已知问题：持久化辅助工具与集成测试的清理只校验连接范围、固定数据库/vhost/端口和UUID/manifest，不独立检查Docker标签，见[测试文档](testing.md#数据隔离与已知边界)。
