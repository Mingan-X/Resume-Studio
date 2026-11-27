# 测试与验证

S3.3提供[故障注入矩阵](fault-injection.md)、[离线质量脚本](quality-evaluation.md)、[任务创建测量](performance.md)、[隔离恢复](backup-recovery.md)与[依赖审计](dependency-audit.md)。`test:faults`会主动重启本项目RabbitMQ，必须独立串行执行；普通`test:integration`增加测试专有TCP代理故障与就绪探针，不自动重启容器。只读Docker归属代理的真实CLI检查是显式fixture，不修改Docker全局配置。模型质量、目标环境L1/L2解除和发布镜像仍按[发布清单](release-operations.md)延后，不能用合成数据补齐。

S3.2生命周期新增真实数据库/文件/Checkpoint/Qdrant删除重入、停止证据、到期保留、账号保留及跨owner专项，完整报告产物删除复用analysis-runtime；真实Langfuse专项验证先读到trace再确认异步删除。首次完整阶段回归结果见progress。SocketTimeout已由维护者指定记录为已知问题继续开发，不移除故障断言、不把未确认停止转为可删除。

S3.2-T7 SocketTimeout专项增加socket-diagnostics（成功/拒绝连接与脱敏）及恢复Worker的loading/initialized通知。测试错误可区分process-start/module-loading/initialized，并附有界socket连接/字节/错误码数据；不记录地址、SQL、凭证或负载内容。原事件等待20秒、连接/事务/总预算及fence/恢复/ACK断言均不变。2026-11-28本轮只确认资源压力与相关22/22通过，未复现原P1008，不代表完整集成或根因修复，见[专项诊断](research/s32-postgres-2026-11-28.md)。

S3.2增加认证、会话业务身份、共享消费者身份及安全边界测试，详见[所有权矩阵](ownership-audit.md)与[认证说明](auth.md)。真实登录专项使用合成账号且精确清理；HTTP人工发送Secure Cookie不代表浏览器HTTPS部署验收。向量HTTP桩的超时用例在服务端确认收到请求后推进40ms模拟时钟，仍断言一次实际请求和超时，避免将本机调度速度误作协议行为；产品超时未调整。

2026-11-27维护者另授权适当放宽S2.4-T10失败的Langfuse请求：观测集成测试projects/observations/trace清理上限统一由5秒调整为10秒，并记录安全的耗时/状态/预算诊断。projects及observations均曾超过原5秒；读取请求取剩余轮询窗口与10秒较小者，持久化等待45秒、父测试90秒保持。生产导出配置与完整持久化/丢失为0/脱敏断言保持。历史5秒失败仍保留，按新上限通过不代表性能根因已修复。

当前Qdrant单请求上限在S2.4-T1依据11.93秒服务端创建记录进一步调整为15秒，沿用维护者已授权的Qdrant范围；原操作/任务/父测试总期限及取消和重试不变。下段10秒为先前调整记录；[本次证据](research/s24-qdrant-2026-11-27.md)与progress保留全部失败。HTTP桩同时验证5.5秒与11.5秒响应，原更早总期限/取消/错误/归属断言保留。

2026-11-27经维护者明确授权，Qdrant SDK/索引适配器单请求上限从5秒改为10秒（依据服务端6.459秒/5.673秒创建记录）。默认Docker与原生对照使用相同新上限，操作/任务总期限、父测试期限及CRUD/维数/归属/fence断言不变。下述历史“原5秒”记录保留为旧验证条件；独立清理HTTP仍为5秒、清理总期限15秒。API、数据库、RabbitMQ和Langfuse超时未放宽；L2原性能目标不因此自动解除。

同轮修复增加安全诊断：Checkpoint Worker测试fixture在失败时输出lock/claim/execute阶段、耗时及有界cause白名单分类；观测metrics记录最后一次传输失败的stage/reason/status/elapsedMs，不保留错误正文、URL或凭证。诊断不新增重试、不改变导出丢失语义；`safe-failure.test`与原观测故障测试验证分类和隐私边界。`index-vector.test`以5.5秒HTTP响应验证授权后的上限，并保留更早总deadline及取消拒绝测试。

S2.3语料的确定性生成、技能字典与真实数据库专项见[岗位语料说明](job-recall.md#验证)；运行结果以[进度](progress.md)为准。

当前测试使用 TypeScript 编译产物和 Node 内置 test runner，Nest testing用于创建应用上下文；没有额外的测试转换器。真实集成测试默认连接独立的本项目容器；维护者明确授权的原生Qdrant仅用于下述显式对照入口，不使用其他项目实例。

依据本机慢盘及维护者“严禁并行构建/安装/测试”的执行约束，基础测试和集成测试入口都显式使用 `--test-concurrency=1`，命令之间也串行执行。测试内部用于验证竞争/幂等的必要并发仍保留；所有原超时、断言和用例均保留，不用放宽期限或删除测试应对机器负载。

## 当前验收状态

S3.1新增report-contracts与analysis-runtime/report-api-check验证不可变报告、同事务终态/收据失败回滚、恢复不重复报告、HTTP查询/重算与API重启读回、SSE按seq补读和断线不取消。列表/cursor/越权及连接额度也由真实HTTP覆盖。仅显式假模型的工程报告，不声称真实模型质量；详见[报告说明](reports.md)与进度。

S2.5的scoring-contracts/scoring单元覆盖精确算术、架构示例、100次重复和置换、非法/零权重、资格与Top10；integration/scoring-policy/scoring-recompute及扩展analysis-runtime覆盖不可变政策、冻结hash、无模型重算、第11名换榜、晚期写入失败回滚和图恢复。模型仍为显式测试注入，不生成真实质量指标；结果见[进度](progress.md)，算法与边界见[评分说明](scoring.md)。

S2.4新增单元/真实数据库/官方Checkpoint子进程/真实Qdrant链路的覆盖边界见[分析流程](analysis-workflow.md#本地执行与验证)。默认完整test:integration包含新增专项；真实模型T9仍延后，假模型工程通过不证明准确率或实际token/费用。所有历次失败与未执行项按progress保留。

S2.4-T1的[分析输入专项](analysis-input.md#验证边界)覆盖真实HTTP/数据库及Outbox回滚，默认纳入test:integration；样本全部为本轮临时owner下的合成简历/JD，正式Rubric只复制内容到临时owner。每轮owner清单保存在忽略的data/s24-analysis-runs，清理前重新核验本项目PostgreSQL归属。不证明后续分析图、真实模型或质量评测已交付。

S2.3测试入口及边界见[岗位召回](job-recall.md#验证)、[索引](job-index.md)、[候选冻结](candidate-sets.md)、[百炼HTTP桩](embedding.md)、[评测脚本](recall-evaluation.md)。默认Docker真实索引/召回/冻结测试仅使用独立owner合成数据，精确清理按manifest和实例/集合metadata核验；清理遇可恢复传输失败只在原15秒窗口重试，不覆盖业务失败。真实百炼Key、人工标签与原生对照未执行项按progress逐次记录，不能从单元或HTTP桩报告召回质量。

S2.2使用job-contracts、job-extraction、model-executor单元测试核对权重、来源与有界模型重试/修复/预算；openai-model.test通过本地真实HTTP桩验证JSON Schema请求、脱敏、无SDK内层重试、429/5xx/超时/非法输出/响应上限。没有真实中转或百炼质量数据。integration/jobs、job-drafts、job-publication、rubrics、job-api分别覆盖数据库不可变/并发/owner、发布Outbox和真实RabbitMQ待执行、完整等级与HTTP。模型建议成功/失败不修改JD；测试模型只显式注入，不作生产兜底。

以[开发进度中的最新验收/回归记录](progress.md)为准，本文只维护检查方式与覆盖边界，不复制运行计数。

S2.1专项：`test/evidence-contracts.test.ts`验证严格证据契约与安全响应投影；`test/storage.test.ts`使用本机真实临时目录验证流式大小/哈希、路径和junction拒绝、提交/补偿与回收锁。`test/integration/resume-persistence.test.ts`用于真实PostgreSQL的上传幂等、owner复合外键、不可变触发器、版本唯一约束与晚期失败回滚；需先部署S2.1迁移，运行结果以progress为准。该数据库专项不证明PDF/DOCX解析、HTTP上传或语义抽取已完成。

`test/parser-preflight.test.ts`使用内存生成ZIP与真实隔离子进程，验证类型签名、实际解压量/CRC/路径/外部关系，以及CPU忙循环总期限、RSS/JS堆、abort、PID退出、文件权限与网络拒绝。该专项只证明预检和执行器边界；PDF/DOCX文字与位置实验属于T5/T6。Windows已运行，Linux读取/proc的分支尚未运行。超时不等于成功中止，测试在失败返回后检查原PID不存在。

`pdf-parser.test.ts`、`docx-parser.test.ts`覆盖合成文本质量、位置与明确失败；`evidence.test.ts`/`parsed-resume.test.ts`覆盖逐字引用/代理对、严格语义结构与空值边界。`integration/resume-api.test.ts`覆盖真实HTTP/文件/数据库上传与重放/冲突、owner/分页、文件与DB提交失败、解析断连、已提交响应丢失的幂等恢复。`storage.test.ts`真实强杀子进程验证崩溃后对账只清理无引用的过期精确文件；测试数据不包含真实简历或模型输出。

## 执行命令

首次安装依赖后，先运行 `pnpm run infra:init` 和 `pnpm run db:generate`。生成步骤无需连接数据库；运行集成测试前按[部署文档](deployment.md)启动服务并应用迁移。

依赖安装使用 `pnpm install --frozen-lockfile`，包管理器遵循[pnpm版本策略](deployment.md#包管理器版本策略)。

```powershell
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run openapi:check
pnpm run test:integration
```

S1.3的真实恢复测试还需要先执行 `checkpoint:init`、构建、`checkpoint:provision`、`checkpoint:setup`，步骤见[部署文档](deployment.md#s13-checkpointer-初始化独立于业务进程)。真实观测测试先执行 `observability:init`、`observability:up` 并确认六个langfuse服务健康。集成命令加载 `infra/.env`、`infra/.env.checkpoint` 和 `infra/.env.observability`，缺配置或缺服务时失败，不跳过。

`pnpm test`编译后执行顶层测试文件，不要求外部服务；`test:integration`读取上述三份被忽略的配置并执行真实服务测试，服务不可用会失败而非跳过。

`pnpm run test:integration:native-qdrant`额外读取 `infra/.env.qdrant-native`，只在该测试上下文中改用维护者授权的Windows原生Qdrant。准备方法见[原生Qdrant回归对照](deployment.md#原生qdrant回归对照)。它执行同一组集成文件、当前15秒Qdrant单请求上限（操作总期限不增加）和CRUD/维数断言；默认Docker结果与对照结果分别记入progress，两套不要同时运行。历史L2仍要求目标环境核对原5秒创建性能，对照通过不代表原Docker路径修复。

真实服务测试文件使用 `--test-concurrency=1` 顺序运行，以减少测试共享本机Docker资源时的竞争。并行执行曾出现Qdrant创建超过5秒，但串行后仍复发；专项排查还确认停止观测服务后仍可能超时，不能只归因于测试并发或Langfuse。只限制文件之间的调度，各用例的池并发、重投、强杀与超时断言不变；不将串行验收描述为同时满负载验证。

## 覆盖范围

| 测试 | 验证内容 |
|---|---|
| test/config.test.ts | 配置转换、必需字段、非法端口、未知环境、秘密字段排除 |
| test/openapi.test.ts | 生成产物与运行时Schema一致；过期/缺失副本检查失败且不重写文件；真实路径、两类任务状态与内部字段排除 |
| test/http.test.ts | 编译后的Nest依赖注入、实际HTTP、400/404/500契约、非法JSON、并发requestId隔离 |
| test/process.test.ts | API/Worker真实子进程的启动失败、正常启动、关闭、日志脱敏与端口释放；registerHooks记录缺配置/非法配置时未加载Nest或bootstrap |
| test/infrastructure-config.test.ts | 拒绝外部地址、其他数据库/vhost、管理员账号及非项目端口 |
| test/integration/infrastructure.test.ts | Prisma CRUD/唯一约束/回滚/池关闭；RabbitMQ确认/return/ACK/重投/重复投递；Qdrant CRUD/维数错误及有界对账清理 |
| test/qdrant-cleanup.test.ts | 真实HTTP桩迟到创建后精确删除、未确认结果的manifest与失败、归属拒绝及项目/服务/端口/卷校验 |
| test/checkpoint-config.test.ts | 运行/初始化账号分离、连接范围、schema白名单、池上限及配置错误不泄漏值 |
| test/integration/checkpoint.test.ts | 官方setup重复执行、数据库权限隔离、运行账号DDL拒绝、池关闭；真实子进程强制终止后的续跑和首Checkpoint缺失时恢复 |
| test/observability.test.ts | 配置白名单；实际HTTP捕获OTLP并检查关联与脱敏；断连、超时、503和部分拒绝；200个span冲击8容量及关闭释放 |
| test/integration/observability.test.ts | 核对本项目容器/网络/卷、健康及诊断项目身份；Nest ObservabilityModule运行合成图，查询Langfuse已持久化的callback/手工span及原文脱敏 |
| test/tasks.test.ts | 固定开发身份及可替换provider、递归规范化哈希、严格合成输入、拒绝owner伪造与非法key/预算、最小调度契约 |
| test/integration/tasks.test.ts | 真实PostgreSQL两类任务及Outbox；幂等重放/409、确定性的并发插入竞争、owner隔离、写Outbox前后故障回滚、SQL不可变输入/外键/状态及唯一约束、精确清理和连接池关闭 |
| test/outbox.test.ts | publish(false)等待confirm、return优先于ACK、nack/断连、握手超时关闭socket、独立correlationId、退避及事件契约/归属校验 |
| test/integration/outbox.test.ts | 真实PostgreSQL SKIP LOCKED、并发发布/过期租约令牌隔离、RabbitMQ路由/return/overflow NACK、TCP丢confirm/断连恢复、确认后强杀重复发布、测试收据去重、预算持久化、quorum DLX无绑定后的留存与恢复 |
| test/consumer.test.ts | 有界消息/路由/身份校验、心跳失败中止且拒绝迟到结果、终态和有效执行重复处置、完成事务先于ACK决定；中止后等实际处理器收束才记录停止并释放锁 |
| test/integration/consumer.test.ts | 两类任务重复消费、并发领取与真实双消费者、过期接管/旧token写入拒绝、心跳与收据同步、旧代次/终态、只读数据库不ACK、完成SQL故障回滚、提交后ACK前强杀重投、停机及非法消息保留 |
| test/task-failure.test.ts | 明确错误分类、退避上下限、dead契约与聚合关系、原始异常/正文排除 |
| test/integration/retry.test.ts | 两类任务延迟重试及耗尽dead、调用/token/费用跨尝试累计、执行/总期限、最后尝试中断、dead return、事务故障、隔离区并发去重与脱敏、三种持久移交后强杀重投 |
| test/reconciliation.test.ts | 锁标识稳定性、游标跨过阻塞任务/回绕、修复后才发布、定时不重叠、停止与连续失败上限 |
| test/integration/reconciliation.test.ts | 两类过期任务真实恢复消费、双对账竞争、持锁子进程不抢占/强杀后恢复、锁连接终止中止处理器、行锁/取消/owner隔离、原Outbox预算/过期发布租约、缺消息/旧确认未终态、恢复上限、只读DB与SQL回滚 |
| test/integration/checkpoint-fence.test.ts | 真实旧Worker操作系统级暂停/恢复、终止实际锁连接、未知旧执行分配新thread、官方saver迟到写入隔离、旧token产物/终态拒绝；确认退出后同thread恢复/无Checkpoint重启；旧索引执行不能修改合成新版本目标 |
| test/integration/task-api.test.ts | 实际HTTP/Nest/数据库装配、资源owner隐藏、严格请求与安全错误、持久阶段/计数/重试信息；两类任务重复取消、队列/重试取消、完成竞争、旧token拒绝、只读DB、SQL回滚、实际Worker清理边界与取消收据 |

任务集成用例注册独立TasksModule并替换身份provider，以本轮随机Owner隔离数据；不向API或Worker增加业务路由。并发测试在两次真实SELECT均返回不存在后释放屏障，强制触发唯一约束竞争。故障测试通过Prisma扩展在真实Outbox INSERT之前或之后抛错，执行的SQL仍在真实交互事务内，验证任务与Outbox均不残留，并用原key重试成功。HTTP测试只注册测试专用409路由，验证统一错误体、requestId和日志白名单。

S1.4迁移验证执行 `pnpm run db:validate`、`db:deploy`、再次`db:deploy`和`db:status`；重复部署应无待执行迁移。CHECK和trigger在SQL迁移中手工维护，不能只依赖Prisma schema diff判断完整性。任务集成前及清理前使用ownedPostgres核实Compose项目、服务、端口与卷，清理只针对本轮确实创建的Owner和隔离区精确ID；清理失败仍报告失败，禁止按前缀清库。

T3测试前需应用新迁移。它在已有诊断权限内创建 `s12.t3.<本轮UUID>` 拓扑、策略和本轮Owner；不向共享 `resume.*` 队列灌入测试消息。创建/清理前核对RabbitMQ项目、服务、端口和卷；先确认本轮精确队列名不存在，再声明，清理只处理这些名称。开发用 `outbox:setup` / `outbox:publish` 命令的重复运行另行记录，不由集成用例自动清理其持久拓扑。

实际NACK测试使用quorum长度限制与reject-publish；该限制允许短暂超额，最多五次探测等待真正的broker NACK，不把达到队列长度当成确认失败。TCP代理解析真实AMQP帧，在basic.publish之后丢弃confirm或断开连接；真实发布超时仍为5秒（专项代理用更短故障期限），不靠mock异常代替broker行为。测试子进程在confirm成功、数据库mark之前通知父进程，父进程强杀并确认退出，等待原15秒租约自然到期后重发，验证同messageId和仅一次合成副作用；这里的简化ConsumerReceipt消费者只属于T3测试，T4消费者另有独立验证。

T4使用新的 `s12.t4.<本轮UUID>` 队列与策略，创建和清理前验证本项目归属；只清理本轮确认新建的精确资源。两类任务各测重复投递、条件领取、单调fence和过期接管；使用真实数据库提前过期本轮租约后验证旧token心跳/结果/终态不能提交，不把此测试说成T7旧LangGraph/Checkpoint隔离。

数据库不可写通过单独连接的 `default_transaction_read_only=on` 实现，不改共享账号权限或数据库全局配置。完成事务故障由Prisma扩展注入超过列宽的stage，触发真实PostgreSQL错误，核对终态、事件与DONE收据整体回滚且RabbitMQ重投。`consumer-crash.fixture.ts`运行实际消费者，数据库提交后暂扣ACK并通知父进程，父进程强杀后由另一个实际消费者处理重投，验证只有一次尝试与完成事件。停机/格式错误/活跃租约测试均检查未ACK及redelivered；无skip-on-missing，不自动重置数据库。

T5在 `s12.t5.<本轮UUID>` 资源执行实际发布/消费，默认consumer装配QuarantineStore；T4旧用例显式不装配隔离服务时仍验证安全拒绝，不代表CLI缺少T5接线。T5先断言availableAt/retryAt与发布器idle，再仅对本轮精确任务移动到期时间，加速后续尝试；次数/总期限/预算/错误断言保持。RPC/socket超时均不扩大。

T5故障注入用事务代理修改真实Outbox INSERT的payloadVersion触发CHECK失败；验证retry/dead或Quarantine与Outbox整体回滚，原消息不ACK。数据库预算在每次模拟外部调用前实际预留，逐项使modelCalls/tokens/costMicros的跨尝试剩余量不足，断言第二次外部调用不会发生。`retry-crash.fixture.ts`分别在retry/dead/quarantine事务提交后、ACK前被父进程强杀，重投不得重复写事件。未知/非法报文仅保留哈希和允许元数据，使用模拟秘密检查隔离和dead消息无原文。

T5清理独立建立RabbitMQ连接，不依赖可能已失败的观察channel；本轮队列和成功创建的Owner精确ID保存在被忽略的 `data/s15-runs/` manifest。清理后标记cleaned并验证残留；manifest不授权按前缀批量删除，后续人工处理必须再次核验项目归属与运行记录。全部测试用例通过不代表对账器、真实模型适配器或长期服务稳定性已交付。

T6使用同样的精确资源/独立清理连接方式，命名空间 `s12.t6.<UUID>`、manifest位于data/s16-runs。`reconciliation-worker.fixture.ts`运行实际TaskDeliveryHandler并持有session advisory lock，父进程只使本轮任务租约过期，先断言对账和第二个消费者均不抢占，再SIGKILL并确认子进程退出后恢复调度。另以本轮唯一application_name查找同数据库用户的锁连接PID并pg_terminate_backend，验证实际处理器被Abort、未提交产物且连接池没有归还带锁连接；不停止共享数据库或改账号权限。

过期恢复事务故障通过真实Outbox CHECK错误注入，验证代次、fence、recoveryCount、旧attempt/receipt和事件同时回滚。当前代次事件未发布或已耗尽发布预算不能重建预算；可发布事件沿用T3的confirm/return/次数限制。T4/T5实际消费者fixture同步使用真实执行锁，纯单元测试才用明确标注的无锁端口。定时watch在真实Nest CLI另做两轮扫描/IPC关闭复验，记录在progress；不等于验证Linux信号、常驻负载或Checkpoint图并发。

T7的 `checkpoint-fence-worker.fixture.ts`使用实际TaskDeliveryHandler、PostgresExecutionLock及官方StateGraph/PostgresSaver。先提交首节点业务产物，随后在官方saver写入前屏障处暂停；Windows辅助脚本对本次拥有的Node子进程调用NtSuspendProcess/NtResumeProcess，实际停止/恢复其执行。父进程仅过期本轮任务租约，先证实持锁时对账不抢占，再按唯一application_name及当前数据库用户找到真实锁连接并终止。新子进程领取恢复消息时切换thread、复用首产物并完成；最后恢复旧子进程并释放屏障，等待官方saver真正写入旧thread，核对新thread的Checkpoint ID/状态与业务产物完全不变。旧子进程另独立尝试产物和终态提交，不能只用AbortSignal中断来代替fence断言。

确认停止用例先强杀并等待实际退出，再调用可信 `confirmWorkerExit`；活进程调用必须拒绝。同thread有Checkpoint时null输入续跑、无Checkpoint时冻结输入重启，最终合成值与已提交产物一致。JobIndexTask用两个实际子进程验证新版本SyntheticIndexTarget先完成后旧执行不能改写；同时验证即便旧输入重新取得有效租约，也不能把新版本目标设为READY。此目标为合成替身，不是已实现的JobVersion或Qdrant索引。

T7 manifest位于 `data/s17-runs/<UUID>.json`，记录本轮Owner及全部新旧thread。清理先恢复/结束并等待所有本轮子进程，再复核PostgreSQL归属，逐个调用官方deleteThread并确认不存在，只删除这些Owner下的合成记录，最后验证业务/Checkpoint池均关闭。Windows暂停/恢复已实际执行；其他平台SIGSTOP/SIGCONT分支未验证。测试不停止共享服务、不清空数据库或按前缀删除线程。

T8通过真实HTTP监听器访问TaskController；测试身份只通过Nest provider替换，不新增公开owner输入。GET在真实数据库读回阶段和TaskEvent计数；取消POST先确认202只保存flag，再由实际消费/对账事务完成。专用子进程在收到abort后继续等待清理屏障，父进程确认其仍持锁、仍为RUNNING，释放后才观察CANCELLED和DONE收据。只读连接的取消请求返回安全500；故障注入触发真实TaskEvent列宽错误，核对状态/fence/attempt/收据整体回滚，正常重试只写一个取消事件。T6原“跳过取消”断言随T8行为改为“无锁时取消，终态重复扫描跳过”，保留持锁不抢占及其他隔离断言。

T8使用data/s18-runs/<UUID>.json记录本轮Owner；清理先等待全部自有子进程退出并关闭HTTP，再复核PostgreSQL归属，精确删除本轮记录并确认池关闭。它不请求LLM或写Checkpoint，不创建共享队列/向量数据。基础配置测试另外拒绝生产模式、公网监听、非法开关及非项目数据库；未启用任务API的原进程加载/超时断言保持不变。

T9在独立生成进程初始化官方Zod扩展并载入实际编译后的contracts，输出OpenAPI 3.1；基础测试以临时副本制造过期和缺失状态，确认check退出非零且不写回。测试不通过改动真实产物来模拟失败。CI配置执行同一openapi:check及基础检查，完整真实集成仍单独运行；远端CI未运行时必须在progress记录，不能把本机命令成功称为CI已通过。

DLX测试断开本轮终端队列绑定，拒收一条消息后恢复绑定，观察源quorum队列保留并最终转发。RabbitMQ 4.4.0本地内部dead-letter publisher confirm timeout实测为180000ms，测试最长等待190秒覆盖一次内部重试，父用例最长300秒；该等待与外部publish的5秒截止分开。未修改服务端设置或原有Qdrant/API测试超时，因此完整集成通常需要数分钟。单节点quorum未验证多副本故障或DLX长期积压容量。

`checkpoint-worker.fixture.ts`仅是测试子进程入口。合成输入独立保存在既有诊断表，图状态只保存UUID、数值和步骤；不含简历、模型请求或真实业务任务。中途终止用例先从PostgreSQL确认首节点状态已持久化，再强杀子进程，等待进程退出后以同thread和 `invoke(null, config)` 续跑，通过独立执行记录验证已完成节点没有重复运行。首次Checkpoint用例在官方saver首次put前设置测试屏障并强杀，确认thread不存在后从独立保存的输入启动。屏障不属于生产实现，也不证明任意外部副作用恰好一次。

新测试清理前等待其子进程全部退出，再重新检查容器/端口/卷归属，只使用本轮随机UUID调用官方 `deleteThread` 和删除对应诊断记录。S1.3-T7为infrastructure.test.ts的Qdrant路径补齐归属与对账清理，持久化辅助工具的历史限制仍保留。合成子进程关闭LangSmith tracing，不使用LLM或外部观测。

每次运行的测试总数、通过/失败数、耗时及残留检查统一记在[开发进度](progress.md)，不在本页维护副本。断言验证行为，不以源码文本匹配代替运行验证。

真实Langfuse测试通过HTTP查询全部导出span的持久化结果，检查traceId、parentObservationId与correlationId，同时确认模拟电话、邮箱和密钥未出现在返回数据中。测试只删除本次随机trace，删除请求由上游异步处理；不删除整个项目或共享卷。合成图不请求模型。独立启停/迁移属于主动环境实验，实际结果记录在进度中，不在普通测试中自动停止用户的服务。

### 集成测试辅助设施

`test/integration/persistence.fixture.ts`是通过 `infra:persistence` 手动调用的辅助工具，不是 `*.test.ts` 用例，不计入自动测试统计。它创建专属记录、消息与向量，以manifest保留本轮资源ID，供容器重启后的verify和cleanup使用；具体步骤见下文。拥有辅助工具不代表每次测试都会运行重启验证。

## 验证记录

每次实际运行的检查、环境与结果记录在[开发进度](progress.md)，本文不重复保存。记录只代表当时的环境；后续变更应重新运行适用检查。

## 数据隔离与已知边界

测试数据库/vhost使用固定诊断标识，临时记录、队列和collection附本轮UUID，清理只针对本轮创建资源。不要删除整个数据库、数据卷或全部前缀资源来通过测试。

初始化与清理均应核实实例归属。默认Qdrant集成测试在创建前及删除前验证Compose项目、qdrant服务、127.0.0.1:56333映射、storage挂载和卷标签；集合名由本轮UUID确定，拒绝任意名称。原生对照通过test/support/native-qdrant.ts验证授权exe路径、监听PID/启动时间及文件大小/修改时间，清理前再次核对且不接受进程替换；不把它冒充Compose标签验证。Checkpoint与Langfuse使用各自已有检查。旧persistence.fixture.ts仍只校验连接范围和manifest，未独立验证Docker标签或manifest来源，不应向未知实例执行其cleanup。

当前Qdrant客户端单请求上限为15秒，沿用S2.4经授权的调整，不增加操作总期限；历史5秒失败与L2性能核对保留。S1.3诊断集合创建失败后独立进行最长15秒的清理对账，其中每次HTTP请求不超过5秒且受剩余期限约束；第一次exists=false仍继续等待，出现后检查归属并精确删除、确认消失。对账成功也不覆盖原创建失败，原测试仍失败。到期无法确认或归属不符时，在data/qdrant-cleanup/<runId>.json保留schemaVersion、project、service、runId、精确collection、原因及时间，并抛出QDRANT_CLEANUP_PENDING；不保存凭证。新增target字段记录Docker/原生目标地址，原生还保存已核验的进程身份；project/service表示测试项目归属，不能代替target实例验证。旧manifest无target时只指原Docker实例。原始错误与清理错误同时发生时保留两者。

manifest是待处理证据，不自动授权后续删除。后续操作必须核对文件内容、执行记录和目标实例归属，只处理该条精确名称，确认删除后才清除此manifest；禁止按s12前缀批量删除。创建在对账期限之外完成仍可能留存，因此保留manifest并明确失败，不承诺任意迟到创建都会在本次进程内清理。真实回归后只读统计s12_*残留，并把数量写入progress。

Qdrant SDK可能对HTTP+API Key发出提示，后台版本查询也出现过超时。保持兼容性检查开启；服务端版本由固定镜像及实际请求核验，不将警告等同于全部网络稳定。

Windows子进程关闭测试通过私有IPC触发与SIGINT/SIGTERM共用的关闭函数；未宣称验证Linux信号行为。测试专用500路由不包含在正常应用模块中。

## 持久化重启验证

以下实验需主动执行，会重启本项目容器；不应对其他项目实例运行。先确认没有未清理的data/s12-persistence.json，再执行：

```powershell
pnpm run build
pnpm run infra:persistence prepare
docker compose --env-file infra/.env -f infra/compose.yaml restart postgres rabbitmq qdrant
pnpm run infra:up
pnpm run infra:persistence verify
pnpm run infra:persistence cleanup
```

prepare保留manifest并创建专属测试资源；verify不消费掉持久消息，便于重复核验；cleanup仅处理manifest记录的本轮资源。禁止使用通配删除替代cleanup。

## 尚未验证

S2.2岗位与Rubric契约专项见 [job-contracts.test.ts](../test/job-contracts.test.ts)，真实PostgreSQL模型专项见 [jobs.test.ts](../test/integration/jobs.test.ts)：owner/版本关联、事务回滚、发布后UPDATE/INSERT/DELETE保护、发布与要求写入的锁等待、Rubric不可变及真实索引任务待执行。运行结果、失败与后续修复以[进度](progress.md)为准；存储专项不等于岗位HTTP或真实embedding验证。

真实模型/embedding质量、真实简历代表性解析质量、目标环境TLS/浏览器会话及容量、发布镜像安全审计、多节点故障、目标服务器备份恢复与其他主机平台仍未验证。正式业务Schema/所有权、报告/索引执行器与业务Checkpoint已使用合成模型/数据和真实基础设施验证，S3.3另有本地隔离恢复及npm依赖审计；这些证据不证明模型质量、生产可用性或外部副作用恰好一次。逐次结果见进度记录，对应阶段见[开发计划](development-roadmap.md)。

RabbitMQ重投与合成任务测试不能单独证明真实简历业务可靠。S1.3-T3只验证旧进程已确认退出后的合成图恢复；S1.4-T7另有上述实际暂停/迟到写入/线程隔离和索引目标保护证据，两者不混称真实业务验收。

## 新增测试的约定

- 单元测试放在 `test/*.test.ts`，不依赖外部服务；真实服务测试放在 `test/integration/*.test.ts`。
- 测试名称描述被验证的行为，而不是被调用的函数。
- 每个任务的验收条件至少对应一个测试；故障边界（超时、重复消息、旧执行、非法输入）与正常路径同样需要覆盖。
- 只使用合成或经授权脱敏的数据；新增测试资源使用本轮UUID，并只清理本轮创建的资源。
