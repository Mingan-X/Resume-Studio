# 开发进度

按时间倒序记录每个阶段或任务的完成情况与验证证据。阶段定义与状态总表见[开发计划](development-roadmap.md)。

记录规则：

- 每条记录写明日期、阶段/任务编号、分支或提交、完成内容、执行的检查及结果、未执行项及原因。
- 只记录实际运行过的检查。验证结果只代表当时的环境，不能推广为其他平台或生产环境已验证。
- 已有记录不改写；发现错误时追加更正记录。

## 2026-11-26 S1.4-T5 有界任务重试、dead事件与持久隔离区（分支 feature/s1.4-task-foundation）

状态：T5实现与专项验证通过，完整回归仍有既有Qdrant失败，S1.4保持“进行中”。先按维护者授权将此前工作保存为4个本地提交：501544e（T1/T2）、485c004（T3）、8ede21c（T4）、aaea0ab（累计文档）；提交后工作区曾干净，再开始本任务。T5与本记录整理为单独本地提交，未推送、未合并，未以提交表示阶段验收通过。

实现内容：

- 显式失败分类；可恢复错误在同事务写RETRY_WAIT/retryAt、generation+1、结束attempt、原receipt DONE、TaskEvent和新messageId的延迟Outbox，提交后才ACK。首次退避24–30秒、后续96–120秒，任务retryAt另阻止提前消费，taskId/快照不变。
- 永久失败、次数或时间预算耗尽写FAILED与最小dead Outbox后ACK；总期限覆盖重试等待。最后尝试中断后重投也持久终结，旧token不能覆盖新执行。原始异常不写数据库/消息；未知处理器异常映射EXECUTION_FAILED，预算/心跳/提交数据库错误不会误判为可ACK的业务异常。
- 增加budget.reserve端口，调用前在真实事务内预留modelCalls/tokens/costMicros并累计attempt token/cost，跨尝试不归零；超额先拒绝。保守预留不自动退款，真实LLM/SDK尚未接入；外部适配器必须复用此端口，不能把模拟预算测试当成真实账单或外部副作用exactly-once保证。
- Quarantine按可信消费owner/consumerName/dedupeKey唯一写入，与dead Outbox同事务；消息来源owner不可信。存消息哈希、可用UUID和白名单元数据，不存非法正文/原始信封/异常；并发和提交后重投由唯一约束吸收。未知/不可见任务、未来代次、messageId复用冲突也隔离；数据库不可写仍不ACK。
- requested/dead契约均由Zod校验，Outbox核对事件/来源聚合，真实confirm+mandatory+return沿用T3。终端队列新增analysis.dead.v1/job.index.dead.v1绑定并保留原Broker DLX requested绑定。新迁移202611260002只追加retryAt和隔离区可信身份/去重字段，兼容旧诊断行，不改已应用历史迁移。无新依赖/账号/vhost/Docker服务。
- 保留显式有界消费/发布命令，未增加T6对账/常驻调度或T7图锁；更新README、架构、部署回退说明、测试和路线图。

逐次检查（test runner耗时不含构建）：

| 检查 | 实际结果 |
|---|---|
| T1～T4提交前核对 | 仅本阶段53个文件；无凭证/运行数据/生成文件入暂存。T1已应用迁移末尾空行提示保留，未改校验和；T3/T4/文档暂存检查通过。既有验证结果写入commit正文 |
| T5初始build、db:generate | 通过；生成Prisma客户端，未跟随CLI升级提示 |
| PostgreSQL归属、db:deploy第1次 | 通过，新增T5迁移，未重置库 |
| db:deploy第2次、db:status | 通过，无pending，5条迁移均已应用 |
| T5真实专项第1次 | 5通过、7失败（含父测试），116.328秒；前5个失败分类/预算/期限场景通过，后续观察连接丢心跳导致断连、断言连锁失败及清理失败，见排查 |
| 首轮Lint | 通过，零警告 |
| 故障注入接口调整期间build | 3次失败：Prisma扩展客户端与普通客户端的泛型/重载签名不兼容；未用类型断言绕过，最终用仅交互事务的窄端口和真实事务代理注入SQL错误，后续构建通过 |
| 首轮失败遗留精确清理 | 核对测试场景/时间/预算和16组Owner/task精确ID，归属检查通过后删除本轮4队列/策略及16主体关联测试数据，剩余Owner0；证据保存在忽略目录data/s15-runs |
| T5真实专项第2次 | 12通过、0失败、0跳过，65.026秒；真实错误移交/隔离SQL回滚、只读数据库、三种handoff后SIGKILL均通过；本轮资源残留0 |
| outbox:setup复验 | 通过；读回正式resume.dead两条新dead绑定及原requested绑定均存在，无purge |
| typecheck、Lint修正后 | 均通过，零警告；最终代码复核也通过 |
| pnpm test（追加dead return与并发隔离用例后构建） | 38通过、0失败、0跳过，28.376秒；原API/Worker限制保持，L1本轮未复现 |
| db:validate、schema diff | 通过、无差异；5条迁移状态正常 |
| 完整test:integration（最终代码） | 55通过、2失败、0跳过，466.737秒；T5父/子14项全部通过（父78.535秒），T1/T2、T3、T4、Checkpoint及Langfuse均通过；仅既有Qdrant创建超时及父测试失败 |
| tasks:consume analysis（最终Nest装配） | 空队列运行60秒后received=0/acknowledged=0/reason=deadline，退出0；QuarantineStore注入正常 |
| 最终RabbitMQ残留核查 | 只保留4条正式队列和1条正式策略，ready/unacked均0，AMQP连接0；本轮T3/T4/T5临时资源清理完成 |
| Qdrant残留核查 | s12_*残留0，未覆盖原超时失败 |
| 文件检查 | 初步22文件/50本地链接；补齐进度与路线图后24文件/96链接有效、无行尾空白；git diff --check通过，无依赖或锁文件变化，凭证/data/dist/生成产物未进入变更 |

失败排查和修正：

- 第1次专项在故障注入时临时编译Nest测试容器，观察AMQP连接在该段停顿中被broker关闭。服务端2026-11-26 05:17:02 UTC记录该连接 `missed heartbeats from client, timeout: 10s`；随后共用channel读取和清理失败，残留消息又干扰后续强杀断言。没有把这些失败记为通过。移除不必要的Nest装配，故障测试改为直接代理真实Prisma事务/INSERT（payloadVersion=0触发真实CHECK）；事务端口保留完整事务语义，未降低校验。
- 原清理复用失败channel，已改为独立连接；每轮记录精确命名空间和成功创建的Owner ID到忽略目录manifest，清理成功后标记cleaned。第一次无事先manifest，依据本轮执行时间、16个场景产生的预算/任务状态和精确ID逐一核对后清理，未按前缀批量删业务数据；后续轮次manifest记录正常。
- 完整回归仍出现既有Qdrant创建超时，服务端集合 `s12_05db51d7_be03_4f20_b8d6_4856e2f85c86` PUT耗时6.948138秒，超过未变的5秒限制；迟到200后精确DELETE成功（0.114784秒），s12_*残留0。处理方向仍是独立安排存储性能修复/目标硬件复验，不能扩大超时或改tmpfs掩盖。本批未改Qdrant、API启动测试或观测链路；Langfuse本轮通过，不抹除T4历史HTTP超时记录。

未执行/限制：未实现T6定时对账、常驻Worker调度、T7 Checkpoint隔离、T8查询/取消API或T9 OpenAPI；未实现真实LLM/SDK错误映射与预留额度结算、隔离区重放/清理API、发布预算耗尽人工恢复和告警。未做多节点故障/长期负载、服务器/SSD、新机冻结安装（依赖未变）、容器重启实验。延迟重试仍需再次运行原Outbox发布批次；数据库持久移交不是立即可靠送达，T3发布失败达到上限时保留事件待处理。未推送、未合并。

## 2026-11-26 S1.4-T1～T4 本地提交整理与T5启动

维护者授权按规范保存现有工作后继续下一任务。本轮将T1/T2、T3、T4分别整理为本地提交，累计文档单独提交；保留各次失败与未执行项，未推送、未合并。前述“未提交”是各记录当时状态，不改写历史。T5范围仍严格按路线图：任务重试/失败分类、延迟Outbox、dead事件和Quarantine；不提前实施T6对账/T7 Checkpoint隔离。

提交前复核：工作区均为本阶段既有变更，依赖/锁文件未变，凭证、运行数据与生成产物没有进入暂存区。沿用本会话已完成的T4最终检查：基础36/36、T4专项12/12；全量40通过3失败、Langfuse独立复验通过，未重新声称全量通过。暂存检查发现T1已应用迁移末尾多一空行；因数据库已记录该文件校验和，保留原迁移逐字节内容并如实记录该格式提示，不通过改历史迁移消除它。后续T3/T4暂存检查通过。未重新运行不涉及新代码的完整回归；T5实现后执行对应检查。

## 2026-11-26 S1.4-T4 手动ACK消费者、执行收据、租约心跳与fence（分支 feature/s1.4-task-foundation）

状态：S1.4继续“进行中”。T4实现与真实专项通过；完整回归仍失败，未标记阶段验收通过。保留原T1–T3所有未提交改动，本轮未提交、推送或合并。T5–T10仍未实施。

完成内容：

- ConsumerModule/TaskConsumer提供实际手动ACK消费路径及 `tasks:consume analysis|job-index` 显式入口。每个会话一个类型/队列、prefetch=1，默认最多10条/60秒；严格验证8KiB正文上限、JSON Schema、contentType、messageId、exchange/routingKey与taskType。身份从固定开发IdentityPort取得，消息不得指定owner。
- TaskExecutionStore在owner限定的事务内锁任务，校验快照/代次，条件领取租约、递增bigint fenceToken、创建TaskAttempt和RUNNING ConsumerReceipt。每次用独立attemptId作为leaseOwner；有效执行重复返回deferred且不ACK，过期可接管，旧尝试记录LEASE_EXPIRED；原输入与taskId不变。
- 终态/过期generation写DONE处置后ACK，不执行处理器；未来generation、未知/越权任务、同messageId改task/generation均拒绝。即便任务已终态，数据库不可写也不ACK。心跳事务同步更新任务和当前收据的同一数据库时间，失败中止执行；完成前收束已开始心跳。
- 合成处理器校验输入哈希，只产生SYNTHETIC_COMPLETED完成事件；完成事件、任务SUCCEEDED、attempt结束及收据DONE在同事务提交，随后在原channel ACK。数据库写入失败整体回滚；token/attempt/generation/有效租约/RUNNING/未取消条件同时保护产物与终态。此处SUCCEEDED仅代表合成单元完成，不伪装有真实报告或岗位索引。
- 新迁移202611260001增加两个任务表执行保护trigger，拒绝fence/generation回退与终态复活。未改旧迁移、数据表或官方Checkpoint；没有新增依赖和锁文件改动。租约/总期限和最大尝试预算从冻结输入及首次attempt计算，跨接管保留；T5失败分类/重试移交尚未实现，预算耗尽时保留未ACK消息并停止本次消费。
- 断连/异常/停机/无效消息关闭会话，不立即nack/requeue热循环；迟到处理结果不能绕过fence提交。新增真实PostgreSQL+RabbitMQ测试及提交后ACK前强杀子进程；更新README、架构、部署、测试、路线图与本记录。

本机环境与恢复：Windows、Node24.22.3、pnpm12.23.0。开始时Docker Desktop未运行，首次PostgreSQL归属检查失败，迁移未执行。默认安装路径不存在；通过注册表找到 `E:\DockerDesktop` 后后台启动，等待引擎可用，按本项目显式服务列表执行infra:up和observability:up，最终九服务均健康。未修改Docker配置、迁移数据盘、重置数据库、删除卷或停观测来换取通过。操作/清理仍核对项目/服务/端口/卷归属。

逐次检查（test runner耗时不含外层构建）：

| 检查 | 实际结果 |
|---|---|
| 初期build第1、2次 | 均失败：任务类型映射返回值被拓宽为string；显式标注ANALYSIS/JOB_INDEX返回类型修正 |
| 初期build第3次 | 失败：单元测试构造的精简消息不满足amqplib完整MessageProperties；将解码函数输入收窄为实际需要的字段，无类型断言 |
| 后续build及consumer单元专项 | 通过；单元专项3通过、0失败，5.055秒 |
| 集成用例加入后build | 失败：测试模块context变量遮蔽工厂函数；改名testingModule后构建及Lint通过 |
| 首次PostgreSQL归属检查/迁移准备 | 失败，Docker引擎未运行；未执行迁移。安装位置核对及引擎恢复后归属复验通过 |
| 第1次pnpm test | 35通过、1失败、0跳过，124.832秒；失败为原API启动超过8秒（8.043秒），恰逢Docker/WSL冷启动；新增用例均通过 |
| typecheck、Lint | 修正类型/测试错误后通过，Lint零警告；最终代码复核再次通过 |
| infra:up、observability:up | 通过，沿用原业务与观测服务/数据；冷启动等待后九服务全部healthy |
| 第1次db:deploy | 归属检查通过后成功应用T4迁移，现共4条迁移 |
| 第2次db:deploy、db:status | 无pending；4条迁移均已应用 |
| db:validate、Prisma schema diff | 通过，无结构差异；trigger由迁移和真实数据库断言验证，不只依赖schema diff |
| 独立T4真实集成专项 | 12通过、0失败、0跳过，88.626秒（父用例66.554秒）；两类任务去重、并发领取/消费、心跳丢失、只读DB、真实SQL回滚、提交后强杀、停机/非法消息均通过；本轮记录/队列/策略清理完成，数据库池连接0 |
| 第2次pnpm test | 36通过、0失败、0跳过，12.240秒；原API/Worker启动关闭断言及8秒限制不变 |
| 完整test:integration | 40通过、3失败、0跳过，352.721秒；T4全部12项再次通过（父用例53.358秒），T3全部10项通过（父235.062秒，DLX恢复181.981秒），T1/T2与Checkpoint通过；失败为Qdrant创建超时及父测试、Langfuse HTTP超时 |
| Langfuse独立专项复验 | 1通过、0失败、0跳过，11.293秒（用例9.506秒）；按原HTTP超时/断言，无源码/配置调整；不覆盖完整回归中的失败 |
| pnpm run tasks:consume analysis | Nest实际装配/CLI运行成功；当时共享分析队列为空，60秒会话返回received=0、acknowledged=0、reason=deadline，退出0 |
| Qdrant只读残留检查 | 本轮s12_*残留0，原超时失败仍保留 |
| RabbitMQ最终只读检查 | 仅4条正式resume队列，ready/unacked均0；本轮T3/T4临时队列清理，AMQP连接0 |
| 文件与文档检查 | 53个变更/新增文件无行尾空白，最终108个本地链接目标有效；git diff --check通过；依赖声明/锁文件无改动 |

失败原因及后续方案：

- API首次有效配置启动超8秒，第二次原限制通过；本次未改API/Worker入口、process.test或超时，与已接受的L1冷启动模式一致。本轮Docker冷启动及模块加载明显慢，不能将单次结果扩大为已定位所有硬件原因；继续在目标服务器/SSD环境按S3.3要求解除L1，不放宽原断言。
- Qdrant本轮集合 `s12_845b5175_9dac_4cc5_bac5_6b71f0019080`，服务端PUT耗时5.458566秒，超过原5秒客户端限制。迟到创建后精确DELETE成功（0.102053秒），只读核对残留0；未触及其他集合。与[原存储排查](research/failure-diagnosis-2026-11-25.md)现象一致，后续仍需独立安排存储性能处理或目标硬件复验，不把它归入仅针对API的L1。
- Langfuse完整回归用例17.081秒时抛HTTP TimeoutError；源码中HTTP单次限制为5秒，九服务当时均healthy。单独复验后全部span持久化/关联/脱敏断言通过。既有异常没有给出请求位置，服务日志未提供足够的请求时序，因此不能断言具体是project查询、observations读回或trace删除，也不能确认冷启动是唯一根因。T4未改观测链路；后续需在独立诊断中采集不含认证/原文的请求阶段与耗时，区分服务健康、API实际就绪、存储响应和清理阶段后处理。保留首次失败，不扩大HTTP超时或关闭兼容检查；不声称该失败运行的trace已完成删除，也不按时间范围批量删trace。

未执行/边界：未实现T5重试/错误分类/隔离区、T6对账、T7图锁与Checkpoint联合fence、T8取消/查询API或T9 OpenAPI；未实现常驻Worker接线、跨owner消费授权、真实报告/索引处理、模型调用、跨进程trace、告警与人工恢复入口。T4租约接管仅覆盖受fence保护的合成数据库写入，不能证明旧LangGraph已停止或Checkpoint不会被迟到写入。未运行新机冻结安装（无依赖变化）、容器重启持久化、多节点故障、Linux信号或生产负载/认证测试。全量回归仍未通过，不宣布S1.4完成或验收通过；没有提交/推送/合并。

## 2026-11-25 S1.4-T3 Outbox发布器与quorum业务拓扑（分支 feature/s1.4-task-foundation）

状态：S1.4进行中。保留T1/T2全部未提交工作，在同一阶段分支实现T3；尚未提交、推送或合并。正式消费者、任务执行租约/fence、业务重试与对账仍为T4以后范围。本轮完整回归仍有既有Qdrant超时，不能据T3专项通过宣布阶段验收通过。

完成内容：

- OutboxStore使用单条短事务CTE、FOR UPDATE SKIP LOCKED按owner领取到期事件；每次独立租约令牌，数据库条件更新拒绝过期或旧领取者的成功/失败标记。默认租约15秒，无数据库事务包围RabbitMQ网络调用。
- 确认发布器使用persistent、mandatory及confirm channel，return先于ACK时判失败，NACK/断连/超时均不标published；每个尝试独立correlationId和连接，重复投递保留messageId。5秒统一截止覆盖握手/通道RPC/confirm，AbortSignal销毁本次socket；publish(false)仅等待确认，不冒充成功。
- 新迁移202611250002增加failedAt/lastErrorCode、结果互斥约束和索引；保留已应用T1迁移。默认最多8次、自createdAt起1小时，指数退避1秒起、30秒上限及50%–100%抖动，写availableAt后释放租约。最后一次尝试中断后也不能无限重新领取；非法事件持久停止，失败事件和任务均保留。领取后总期限已过时不发起网络调用，批次取消明确报告stopped。
- `outbox:setup`受控建立resume.tasks/resume.dead及分析/索引的主/终端quorum队列；精确策略启用at-least-once DLX、reject-publish、delivery-limit=5、15分钟consumer timeout，核验实际队列与生效策略。只扩展已有vhost账号的精确资源权限；重复infra:provision保留该授权，不加管理tag或新服务。
- `outbox:publish`显式执行默认开发owner的一个批次（最多10条/60秒），失败或停止返回非零；未接入定时调度或正式Worker消费者。增加真实RabbitMQ/TCP故障代理、真实发布子进程强杀及仅测试使用的ConsumerReceipt去重事务。
- 同步README、架构、部署、测试与路线图；未新增依赖、未修改锁文件、Qdrant实现或既有超时，未启动新Docker项目。

环境与来源：本机Windows、Node24.22.3、pnpm12.23.0；PostgreSQL/RabbitMQ/Qdrant与Langfuse保持运行。T3管理和清理前核验Compose项目/服务/端口/卷；正式拓扑保留，测试只操作事前确认不存在的精确s12.t3.UUID资源及本轮Owner。查阅RabbitMQ官方confirms/quorum文档与本地amqplib2.4.1源码；官方网页读取成功，raw GitHub源码下载失败，未用无法获取的源码声称验证。实际rabbit配置读取确认dead_letter_worker_publisher_confirm_timeout=180000ms、consumer_prefetch=32。

逐次检查（test runner耗时不含构建）：

| 检查 | 实际结果 |
|---|---|
| 第1次build | 失败：amqplib类型未列出Node socket signal；核对其把选项转交net.connect的实现后使用推导的socketOptions对象，未加类型断言或改依赖 |
| 第2次build | 失败：测试通道callback可选/返回类型及EventEmitter的this类型不匹配；收窄确认函数所需端口并修正测试callback |
| 后续build | 通过；包括专项、两次pnpm test及全量集成的构建 |
| db:generate、db:validate | 通过，客户端重新生成，Prisma schema合法 |
| 第1次db:deploy | 通过，新增T3迁移；应用前PostgreSQL归属验证通过 |
| 第2次db:deploy、db:status、schema diff | 无pending，3条迁移已应用；数据库与Prisma无结构差异，CHECK仍另由SQL维护 |
| 第1次outbox:setup | 通过，实际建立业务队列、DLX策略和精确权限 |
| node --test dist/test/outbox.test.js | 5通过、0失败、0跳过，8.379秒 |
| 第1次T3真实集成专项 | 5通过、5失败（包含父测试），70.161秒；失败原因见下文；最终本轮资源已精确清理 |
| 第1次lint | 失败：两个import应为type、一个测试变量未使用；修正后检查通过 |
| 第2次T3真实集成专项 | 8通过、2失败（DLX及父测试），116.960秒；实际NACK、强杀重放和预算验证已通过；DLX等待窗口仍短于broker周期；最终本轮资源已清理 |
| 第1次pnpm test | 32通过、0失败、0跳过，10.701秒 |
| 第2次outbox:setup | 通过，核验已存在策略和实际队列；未清空消息 |
| 本轮完整test:integration | 29通过、2失败、0跳过，313.820秒；T3父/子共10项全部通过（269.365秒，其中DLX恢复183.170秒）；T1/T2、Checkpoint、Langfuse均通过；仅原有Qdrant创建超时及其父测试失败 |
| infra:provision复验 | 成功；操作前两服务完整归属验证，操作后读回精确T3权限仍保留 |
| outbox:publish | 成功输出results=[idle]，退出0；当时开发owner没有待发事件 |
| Qdrant只读残留检查 | s12_*数量0，清理保留原超时失败 |
| 第2次pnpm test（末次边界修正后） | 33通过、0失败、0跳过，8.506秒；包含领取后过期不发网络、取消批次返回stopped；API启动L1未复现 |
| typecheck/Lint修正后复验 | 均通过，Lint零警告；末次边界修正后的最终复核也通过 |
| 第3次独立T3集成专项（最终代码） | 10通过、0失败、0跳过，243.579秒；父用例243.108秒，其中DLX恢复180.731秒；精确测试资源已清理，数据库池连接0 |
| 最终RabbitMQ残留/连接核查 | 仅保留4条正式resume队列和1条正式策略，队列ready/unacked均0；s12.t3临时队列/策略0，AMQP连接0 |
| 首轮文件/文档检查 | 42个变更/新增文件无行尾空白，105个本地文档链接目标存在；git diff --check通过 |
| 最终文件/文档检查 | 42个变更/新增文件、106个本地链接目标有效，依赖声明和锁文件无改动；凭证、生成文件和临时诊断文件均被Git忽略 |

失败排查与修正：

- 第1次NACK用例把quorum队列配置长度=1误当成“第二条必NACK”；实际允许短暂超额，第二条被确认。改为最多五次探测并必须观测实际NACK，未放宽published判断。首轮未消费的合成消息又导致崩溃重放messageId和空队列断言失败；给该场景增加finally内精确清空本轮私有队列，后续真实强杀/收据去重均通过，正式队列不purge。
- DLX前两次分别只等待5秒/40秒，不足以覆盖本机180秒内部重试周期；从运行broker读取配置后，改为190秒观察一个内部周期、父测试300秒。该测试是本批新增，未调整服务端配置或任何publish/API/Qdrant既有限制。恢复绑定后实际183.170秒收到相同messageId及rejected x-death，证明该故障窗口下消息被源quorum保留并恢复转发。
- 完整回归的Qdrant集合为s12_1a30dd83_ed6b_46ba_adae_c4b7ad64a734，服务端PUT耗时5.189154秒，超出原5秒客户端预算；服务端迟到200后DELETE成功（0.284047秒），残留0。与[既有存储排查](research/failure-diagnosis-2026-11-25.md)现象一致；不把本次失败并入仅适用于API冷启动的L1，不把T3专项成功覆盖全量失败。处理方向仍是独立安排持久化存储性能修复或目标服务器/SSD复验，当前未迁盘、重置或改tmpfs。

未执行/限制：未实现T4正式消费者/执行幂等及fence，T3消费去重仅测试fixture；未实现常驻调度、自动恢复耗尽事件、告警/查询API、跨owner发布授权、跨进程trace、业务重试dead事件、真实模型或真实版本数据。未验证多节点quorum容错、长期负载/积压、认证/生产部署、容器重启恢复或新机冻结安装（本批未改依赖）。每次发布新连接是低吞吐阶段的有界实现，不声称高吞吐。全量失败仍待处理；未推送/合并。

## 2026-11-25 S1.4-T1/T2 开发身份、任务模型与事务幂等（分支 feature/s1.4-task-foundation）

状态：S1.4进行中。T1/T2实现与专项检查通过，但全量集成连续两次在既有Qdrant集合创建处失败，未满足完整回归的完成定义，未标记维护者验收通过。T3–T10尚未实施。本轮没有提交、推送或合并。

开始前已阅读AGENTS、CONTRIBUTING、路线图T1/T2、架构§4.4/§5/§6.1、接口契约、需求及S1.3验收记录。`git fetch origin`确认远端master为 `17d4002`（PR #1合并S1.3，包含 `6d45207`），工作区原为干净；从该提交创建新阶段分支，保留原S1.3提交和本地分支。此前验收记录中的“未推送/未合并”是当时状态，本条据远端更新补充，不改写历史验收记录。

完成内容：

- T1：IdentityModule默认固定开发Owner，通过IDENTITY/IdentityPort可替换；应用输入不接受ownerId，未知主体不能自动注册。Prisma新增Owner、AnalysisTask、JobIndexTask、TaskAttempt、TaskEvent、OutboxEvent、ConsumerReceipt、Quarantine及迁移；任务状态分表，PARTIAL只属于分析任务。共享记录用互斥任务外键、类型/ID一致性CHECK和owner复合外键；保留预算、代次、租约/fence及取消字段，未实现执行器。
- T2：严格Zod合成契约，冻结owner/输入版本/预算/配置；应用服务协调仓储，同事务写任务、内嵌输入快照和通用Outbox。按owner及任务类型隔离UUID幂等键，SHA-256规范化完整请求；相同请求重放原taskId，不同请求抛IDEMPOTENCY_CONFLICT并映射HTTP 409。并发P2002回滚后读取已提交赢家。数据库trigger保护输入、版本及幂等绑定不可变。
- TasksModule只显式装配数据库和身份，不将RabbitMQ/Qdrant/观测放入任务事务；尚未注册到API/空Worker。沿用本项目诊断数据库、账号和3连接池，不新增Docker服务，不触碰Checkpoint表或观测存储。没有新增依赖或改锁文件。
- 新增身份/契约单测、真实PostgreSQL并发与故障测试、测试专用HTTP 409验证。更新README、架构、部署、测试、API/契约与路线图；数据映射和未实现边界见架构§6.1。

环境：Windows、Node 24.22.3、pnpm 12.23.0；本项目Compose业务与观测服务保持运行。应用迁移和新集成清理前核验PostgreSQL项目/服务/端口/卷归属；Qdrant残留读取前独立验证其归属。

逐次检查（耗时为test runner报告，不含外层构建；未给出耗时的命令不推测）：

| 检查 | 实际结果 |
|---|---|
| `db:validate`、`db:generate` | 均成功，Prisma 7.10.1；未采用CLI提示的升级 |
| 第1次 `typecheck` | 失败：新增409未进入日志白名单、引用了Zod未导出的JSONType。改为复用错误Schema、从z.json推导类型；随后第1次build成功 |
| 生成迁移 | 以HEAD旧schema对新schema执行Prisma migrate diff --script，补充事务、CHECK及不可变trigger；无reset |
| 第1次 `db:deploy` | 新增S1.4迁移成功，保留原S1.2迁移及数据 |
| 第2次 `db:deploy` | 成功，无pending migration |
| `db:status` | 成功，2条迁移均已应用 |
| 第2次 `typecheck` | 失败：故障测试把Prisma读取的可空JsonValue直接用于create。改为先用快照和budgetUsage Schema验证，再构造写入；随后第2次build成功 |
| 第1次 `lint` | 通过，零警告 |
| `node --env-file=infra/.env --test dist/test/integration/tasks.test.js` | 11通过、0失败、0跳过；10.141秒；本轮owner/task/outbox/attempt/event/receipt/quarantine残留0，池关闭后连接0 |
| 第1次 `pnpm test`（含build） | 27通过、0失败、0跳过；7.774秒；API启动L1本轮未复现 |
| 第1次 `test:integration`（含build） | 19通过、2失败、0跳过；41.947秒。失败为既有Qdrant创建用例及父测试；Checkpoint、Langfuse、新任务专项全部通过；S1.4本轮记录残留0 |
| 第3次 `typecheck`、第2次 `lint` | 均通过，Lint零警告 |
| 第1次Qdrant残留检查 | `s12_*`残留0；对账清理保留原超时失败 |
| 第2次 `test:integration`（含build） | 19通过、2失败、0跳过；38.838秒。同一Qdrant createCollection超时；其他用例含新增任务专项全部通过；S1.4本轮记录残留0 |
| 数据库与Prisma schema diff（--exit-code） | 无差异，退出0；CHECK/trigger另外由真实数据库约束用例覆盖 |
| 第2次Qdrant残留检查 | `s12_*`残留0 |
| 首轮 `git diff --check` | 发现schema末尾新增空行；已移除；最终复核通过 |
| 最终文件与文档检查 | 26个变更/新增文件无行尾空白，104个本地文档链接目标存在；凭证、dist、生成客户端及诊断临时文件均被Git忽略；无依赖/锁文件改动 |

失败排查及处理方案：

- 第1次Qdrant集合 `s12_abc70968_e711_4519_b343_57971baffea7`，服务端PUT耗时6.053957秒；第2次 `s12_aeededd5_1bd3_45dc_af6d_73c0b37722a0`，PUT耗时6.493391秒，均超过未改动的5秒客户端限制。服务端随后返回200；本轮对账分别精确DELETE成功，读回残留均0。说明创建迟到并非任务事务回滚/数据库幂等失败。
- 本批未改Qdrant实现、镜像、超时、存储、兼容性检查或原测试。现象与[既有存储排查](research/failure-diagnosis-2026-11-25.md)一致，当前日志能确认服务端创建慢，不能单凭一次CPU/内存抽样确定物理磁盘/分页/文件系统的具体占比。没有把重复失败归入已接受的API启动L1，也没有通过重跑成功覆盖失败。
- 后续处理应单独安排持久化存储性能修复：备份并核对项目卷、凭证和数据后，在服务器/SSD环境按原5秒限制复验，再运行完整回归。若必须支持机械盘，需另行定义并审查管理操作预算，不能直接提高统一超时换取通过。本批未迁盘、停观测服务、重置数据库或改tmpfs；完整回归失败作为当前遗留保留。

未执行/限制：未执行新机冻结安装（无依赖变化）、容器重启持久化实验、生产认证/网络部署、真实简历/JD版本绑定、LLM、Outbox发布/消费/重试/fence/对账、任务查询取消HTTP、OpenAPI或跨进程trace。前者不是本批变更所需复验，后者属于后续任务。输入是明确合成版本，不能据此宣称真实业务资源所有权已验证；seq分配及状态迁移仍待执行流程实现。标准完整集成目前未通过，维护者验收和推送均未执行。

## 2026-11-25 S1.3 重新验收：通过，附已知环境限制（分支 feature/s1.3-checkpoint-setup）

验收人：维护者委托的审查AI；最终决定由维护者作出。对象为提交 `2d34b9c`（master `dc6002d` 之后的6个提交），验收开始时工作区干净。本次只运行检查和阅读代码，未修改源码、测试、配置或依赖。

环境：Windows，Node 24.22.3，pnpm 12.23.0；resume-studio项目九个容器保持运行。

本次实际执行：

| 检查 | 结果 |
|---|---|
| `pnpm run typecheck` | 通过 |
| `pnpm run lint` | 通过，零警告 |
| `pnpm test` 第1次 | 22项：21通过、1失败。失败用例为 `process.test.ts` 的“API and idle Worker run separately…”，`Child api did not start`，8.07秒，超过原8秒就绪限制 |
| `pnpm test` 第2、3次 | 均为22项全部通过，约11秒与10秒 |
| `pnpm run test:integration` 连续2次 | 均为10项全部通过，约45秒与42秒 |
| 回归后Qdrant集合、`data/qdrant-cleanup` 待清理manifest | 均为0 |
| 提交内容 | 不含凭证、`data/`、`dist/` 或生成目录；progress.md以外的文档不复制运行计数 |

本次结果与执行AI在T7.5记录的失败模式一致（首次运行同一用例失败，后两次通过），该记录如实。

逐项结论：

| 任务 | 结论 | 依据 |
|---|---|---|
| T1–T5 | 通过 | 沿用上一次验收结论；本次两轮集成测试再次全部通过 |
| T6、T7.3 | 通过 | 文档只描述已验证行为，运行计数只保留在本文件 |
| T7.1 | 通过 | 入口只依赖配置与启动错误模块，校验通过后动态加载各自bootstrap；registerHooks测试证明缺配置/非法配置路径不加载Nest。上次验收的阻塞用例本次3轮均通过 |
| T7.2 | 通过 | HTTP桩按顺序复现客户端超时、首次不存在、迟到创建、核对归属、精确删除；超过15秒期限写manifest并明确失败；删除前核对项目、服务、loopback端口与卷标签，不按前缀删除 |
| T7.4 | 通过 | 提交与任务编号对应，T1–T6原有改动保留 |
| T7.5 | 未完全满足 | `pnpm test` 3次中首次失败1项，原因见下 |

维护者决定：接受S1.3，阶段状态改为“已完成”，以已知环境限制L1记录剩余失败，可以合并。

已知环境限制 L1（本机冷启动）：

- 现象：构建后第一次运行 `pnpm test` 时，有效配置的API子进程可能超过8秒才就绪；同一用例在之后的运行中通过。
- 判断依据：该路径必须加载Nest，不受T7.1影响；失败只出现在文件缓存冷的首次运行；[专项排查](research/failure-diagnosis-2026-11-25.md)测得项目、pnpm store与Docker数据盘位于SATA机械硬盘，且C盘剩余空间小于Docker数据盘。本次未对该失败做分段计时，判断基于排查数据与失败模式，不是逐次证实的根因。
- 不采取的处理：不调大测试或客户端超时，不跳过或放宽断言，不预热后再计入结果。
- 重新处理的时机：部署到服务器，或本机迁移到SSD、更换满足条件的硬件后，在新环境连续运行 `pnpm test` 3次与 `pnpm run test:integration` 2次并记录；仍失败则作为代码问题重新定位。已加入[S3.3验收要求](development-roadmap.md#5-后续阶段交付与验收)。
- 对后续开发的影响：在本机看到该用例首次失败、重跑通过时，按L1记录，不视为新回归；其他用例失败或重跑仍失败时按正常缺陷处理。

保留的非阻塞观察：`ObservabilityService` 注册全局provider并在关闭时禁用全局trace/context，接入业务进程时（S1.4或之后）处理。

后续：本条与路线图、README的状态更新尚未提交，需随分支一起提交后合并到master；合并后按CONTRIBUTING清理已合并的本地分支。未推送。

未执行：重新安装依赖、持久化重启实验、观测服务停机实验、registry在线版本核对。集成测试写入的本轮合成数据已自动清理。

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
