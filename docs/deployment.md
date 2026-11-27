# 本地部署

S2.3岗位索引显式命令与版本/alias边界见[索引执行](job-index.md)；百炼本地配置、消费/对账命令及真实验证延后边界见[Embedding调用](embedding.md)。新增CandidateSet与JobIndexRequest迁移使用既有业务数据库，部署前按原流程备份并核验项目归属，不删除原有数据/卷。真实百炼配置只保存在忽略文件，缺配置时命令安全失败；本地HTTP桩不能作为正式索引目标。

## S2.2 岗位与模型本地装配

JOB_API_ENABLED=true启用岗位路由，DATABASE_URL仍限制本项目本地开发库。JOB_MODEL_CONFIG_FILE和JOB_INDEX_TARGET_FILE为可选绝对路径，文件放入被忽略的data目录；未配置时对应建议/发布操作503，不阻止读取草稿。文件内容经严格Zod校验，大小上限64KiB，错误仅输出字段名，不打印Key。模型连接参数不入库，任务只引用版本标识。

模型文件包含connection和execution。connection必需baseURL、apiKey、model、modelConfigVersion、timeoutMs、currency，可选maxResponseBytes（默认1MiB）；远端要求HTTPS，本地HTTP只允许loopback。execution必需singleTimeoutMs、totalTimeoutMs、maxAttempts、maxRetries、maxTokens、maxCostMicros、currency、inputTokenReservation、maxOutputTokens、costReservationMicros、retryBaseMs、retryCapMs、maxConcurrent，按实测预算填写，不自动选真实模型或费用上限。全部重试和一次修复共享预算；无可信价格时费用返回null，预留额度不冒充实测费用。禁止开启LANGSMITH_TRACING/LANGCHAIN_TRACING/LANGCHAIN_TRACING_V2/LANGCHAIN_VERBOSE或OpenAI debug/info日志；观测走本项目脱敏span。

索引目标文件包含embeddingVersion/indexVersion/chunkerVersion/componentVersion及taskBudget；具体目标由S2.3百炼适配器确认，未配置前不伪造正式目标。测试的http-fixture/fixture-only目标仅存在于测试注入和精确清理记录，不写成本地默认文件。

正式Rubric v1已导入开发owner（00000000-0000-4000-8000-000000000001），状态PENDING_REVIEW；部署新库时显式rubric:import再rubric:load核验，禁止把SYNTHETIC当默认版本。修改规则/审核状态发布新版本。

## S2.1-T2 本地文件暂存与回收

StoragePort与本地适配器已定义；上传装配仍待T8。STORAGE_ROOT须为专用绝对目录，首次初始化只接受空目录，写入项目/路径归属标记；后续必须匹配标记。目录须由运行账号独占，禁止其他主体修改。路径、junction/symlink及文件硬链接检查不构成对恶意本机管理员的防护。

`pnpm run build` 后可由操作系统定时调用 `pnpm run storage:reclaim`。命令从本地未入库配置读取STORAGE_ROOT，核验本项目PostgreSQL容器/端口/卷归属，并查询真实FileAsset引用；T3表尚未部署时明确失败，不把缺表当作无引用。只回收超过24小时、无数据库引用、未提交且未被操作锁占用的暂存文件；数据库异常时停止。命令不清理files区、COMMITTING/COMMITTED清单或崩溃遗留锁，保留这些可核查状态供后续上传对账处理；不得根据名称前缀删除。

文件提交先记录COMMITTING，再移动payload，最后记录COMMITTED。目录保留操作清单；进程终止/写失败时可据operationId检查结果，未知结果不得盲删。commit只提交文件，不代表数据库已提交；跨文件/数据库的补偿与恢复属于T8联调。即时discard只接受本次READY操作，拒绝删除已提交文件。Windows使用真实临时目录测试，Linux与突然断电后的目录元数据耐久性尚未验证。

简历路由由RESUME_API_ENABLED=true启用，同时设置DATABASE_URL与STORAGE_ROOT，先执行db:generate/db:deploy并build。固定开发身份仅允许development/test及127.0.0.1/::1，未配置时路由不注册。每API进程一个解析器，解析并发1，总期限15秒；上传传输30秒。node权限只允许读取本仓库dist/node_modules，部署时从仓库根目录启动；PDF/DOCX解析不需要网络或原生canvas权限。保留root所有权标记，不通过删除本地配置/存储目录修复启动问题。

`pnpm run storage:reconcile`用于上传进程崩溃后的结果对账：仅处理超过24小时、清单记录的uploaderPid已不存在、真实数据库无引用的精确文件；未知旧进程状态、PID复用、旧版无PID清单、活进程或DB查询失败均保留。操作锁有PID标记，只有确认原进程退出才释放遗留锁。该命令可补偿COMMITTING/COMMITTED但未入库的原文件，不做前缀/全目录删除；一般storage:reclaim仍只处理暂存。CLI核验项目DB实例/卷，Windows真实崩溃子进程测试与其他平台限制见progress。

本配置用于本地开发与隔离集成测试，不是生产部署方案。API/Worker在主机运行；Compose项目 `resume-studio` 管理业务三服务及可选Langfuse六服务。基础配置可单独使用，观测配置作为同项目overlay加载。

## 环境与镜像

Node.js **24.22.3**、兼容现有锁文件的 **pnpm 12.x**；Docker Desktop Linux 引擎或等效 Docker 环境，支持 Compose。当前验证平台为 Windows 主机与 linux/amd64 容器；其他平台尚未验证。

### 包管理器版本策略

- `package.json` 的 `engines.pnpm` 为 `>=12 <13`，不固定补丁版本，也不声明 `packageManager` 字段。已实际验证的版本是12.23.0（记录见[开发进度](progress.md)），其他12.x未验证。
- 依赖解析以提交的 `pnpm-lock.yaml` 为准，安装一律使用 `--frozen-lockfile`。锁文件中 `packageManagerDependencies` 段的pnpm 12.23.0快照按原样保留，不代表强制版本。
- 遇到元数据不匹配或工具版本选择问题时，记录实际版本和错误并提交维护审查；不用非冻结安装、忽略校验或手改锁文件绕过。
- 除明确批准的锁文件维护外，不修改依赖解析结果。

| 服务 | 镜像 | 主机端口 | 项目数据卷 |
|---|---|---|---|
| PostgreSQL 16.15 | pgvector/pgvector:pg16 | 127.0.0.1:55432 | resume-studio_postgres_data |
| RabbitMQ 4.4.0 | rabbitmq:4.4.0-management | 127.0.0.1:55672、55673 | resume-studio_rabbitmq_data |
| Qdrant 1.20.2 | qdrant/qdrant:v1.20.2 | 127.0.0.1:56333 | resume-studio_qdrant_data |

[compose.yaml](../infra/compose.yaml) 固定每个镜像的 digest，使用 `pull_policy: never`。已有相同镜像可直接复用；首次在新机器部署时先核对并获取其中声明的精确镜像。不要改接其他项目的容器或挂载其数据卷。PostgreSQL 镜像含 pgvector，但项目仍使用 Qdrant，不依赖该扩展。

### 首次获取与核对镜像

`pull_policy: never` 不会下载缺失镜像。先从Compose的每个 `image:` 逐字复制包含tag和digest的完整引用，再显式获取并检查；例如PostgreSQL当前引用为：

```powershell
docker pull 'pgvector/pgvector:pg16@sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a'
docker image inspect 'pgvector/pgvector:pg16@sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a' --format '{{json .RepoDigests}} {{.Os}}/{{.Architecture}}'
```

RabbitMQ与Qdrant按Compose中各自的完整引用执行同样操作。确认RepoDigests包含声明的仓库digest，镜像平台匹配运行环境；已验证平台为linux/amd64。只有tag相同或下载了latest不足以证明身份一致。若digest不存在或平台不符，停止并核实，不自行改tag/digest、覆盖服务或删除卷。

## 初始化

在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm run infra:init
pnpm run infra:config
pnpm run infra:up
pnpm run infra:provision
pnpm run db:generate
pnpm run db:validate
pnpm run db:deploy
pnpm run db:status
```

- `infra:init` 生成 `infra/.env`，已有文件不覆盖。PostgreSQL 管理员、测试账号与 RabbitMQ/Qdrant 使用随机凭证，不打印密码，不修改根目录 `.env`。
- `infra:config` 仅验证配置，不输出展开后的凭证；不要把未脱敏的 `docker compose config` 输出上传到仓库或工单。
- `infra:up` 只启动本项目三个服务并等待健康检查。
- `infra:provision` 不接受容器名参数，仅解析本项目 Compose 服务并检查项目标签。建立非管理员诊断账号/数据库，配置 vhost 前缀权限，不轮换已有密码。
- 初始化脚本的归属校验不自动覆盖所有清理入口；现有持久化cleanup仅使用连接范围和manifest定位资源，尚无独立Compose标签核验。执行前须核对目标实例与manifest归属，后续补强要求见[测试边界](testing.md#数据隔离与已知边界)。
- `db:generate` 生成 `src/generated/prisma`，不连接数据库。生成目录不提交；首次构建前必须执行。
- `db:deploy` 使用现有迁移创建诊断表及S1.4任务模型，重复执行不会重复建表。不要使用重置数据库命令替代迁移。

### S1.4 合成任务迁移

沿用本项目 `resume_studio_s12_test` 数据库及 `resume_studio_test` 账号；保留历史诊断名称，不另建Docker服务、业务数据库或通用任务聚合表。TasksModule仅在显式注册的合成上下文中使用该连接，API/空Worker仍保持原启动依赖。固定开发Owner随迁移建立；真实身份/输入版本及生产配置由后续任务接入。

应用迁移前在仓库根目录先运行 `pnpm run build`（首次先 `db:generate`），再验证PostgreSQL归属：

```powershell
node --env-file=infra/.env --input-type=module -e 'const {ownedPostgres}=await import("./dist/src/infrastructure/checkpoint/ownership.js"); await ownedPostgres();'
pnpm run db:validate
pnpm run db:deploy
pnpm run db:deploy
pnpm run db:status
```

上述命令逐项确认成功后继续；归属失败不得应用迁移。`202611250001_s14_task_foundation`只新增模型、枚举、约束、不可变输入trigger及开发Owner，不修改诊断或官方Checkpoint表。应用使用3连接上限与原事务等待/执行限制，不在事务内访问RabbitMQ/Qdrant/模型。

迁移提交后应用回退可切回S1.3代码并保留新增表，不自动执行破坏性down或删除Owner/任务。后续Schema变更使用新迁移；从合成输入扩展到真实版本时同时更新SQL快照约束与Zod，不直接修改已应用迁移。集成测试只清理本轮已创建的记录，不删除开发Owner或数据卷。

### S1.4-T3 Outbox发布与业务拓扑

沿用当前Compose项目、PostgreSQL库和RabbitMQ vhost，不新增Docker服务。先生成客户端并构建，核对上述PostgreSQL归属后应用迁移，再执行：

```powershell
pnpm run db:generate
pnpm run build
pnpm run db:deploy
pnpm run outbox:setup
pnpm run outbox:publish
```

`outbox:setup`为显式管理操作，逐次核对RabbitMQ Compose项目、服务、127.0.0.1端口与卷标签。它在 `resume-studio-s12-test` 中保留原 `s12.*` 诊断权限，只增加 `resume.tasks`、`resume.dead`、两条主队列和两条终端队列的精确权限；不授予管理用户tag或其他vhost权限。已存在但不同的权限/同名策略会失败，不擅自覆盖。`infra:provision`识别并保留已安装的这组权限。

setup声明durable direct交换机、durable quorum队列并核验实际生效策略。主队列采用at-least-once dead-lettering、reject-publish、delivery-limit=5、15分钟consumer timeout；分析/索引各有终端队列。重复setup不清空队列，不删除资源。首次安装失败时已创建的持久拓扑保留，可修正原因后重新执行；不能使用purge或删除卷修复。

`outbox:publish`只处理开发固定owner的到期事件，一个批次最多10条、60秒，正常无事件输出idle退出。单次连接/发布/确认共同最多5秒，租约15秒；失败时指数退避写回数据库，最多8次、从事件创建起最长1小时，参数见[outbox配置](../src/infrastructure/outbox/config.ts)。遇到失败、非法事件、预算耗尽、取消或失去租约，命令返回非零状态；failedAt/lastErrorCode保留可核查原因。未提供自动预算重置或人工恢复命令，避免无限重发。

命令通过AbortSignal释放本次RabbitMQ连接，退出关闭数据库池。当前不是常驻调度器；API/空Worker启动路径保持兼容，后续在现有Worker内接线。任务创建HTTP未交付；T4提供下述消费会话，T5接入失败移交。消息发布成功不表示任务完成。

T3迁移 `202611250002_s14_outbox_publisher`只追加Outbox失败字段、结果互斥约束和查询索引；不改已应用的T1迁移。回退应用代码时保留新字段和队列/消息，避免数据丢失；权限/策略回退应先核实没有活动发布/消费并单独安排，普通回退不自动删除拓扑。

### S1.4-T4 合成任务消费

先构建、核对PostgreSQL/RabbitMQ归属并应用迁移及T3拓扑，然后按任务类型运行：

```powershell
pnpm run tasks:consume analysis
pnpm run tasks:consume job-index
```

每次只消费对应主队列，默认最多10条或60秒，prefetch=1、noAck=false；正常到达会话期限且无未完成消息可以退出0。会话结束关闭连接和数据库池。Ctrl+C/期限到达中止正在执行的合成工作；未可靠提交或ACK的消息随原连接关闭交回broker，不使用立即nack/requeue循环，不在进程内自动无限重连。数据库/输入错误、活跃执行冲突、停机或仍有未确认消息时返回非零和安全汇总。命令使用固定开发owner，跨owner调度未开放。

领取任务时同事务创建TaskAttempt和RUNNING收据、递增fenceToken；默认租约60秒、心跳10秒，租约不超过冻结输入期限。每次尝试还受10分钟执行上限限制；次数与总期限跨尝试保留，不因进程重启重置。参数与Schema见[consumer配置](../src/infrastructure/consumer/config.ts)。本阶段处理器只接受kind=synthetic的冻结输入，产出一条SYNTHETIC_COMPLETED事件，与任务SUCCEEDED、尝试结束和收据DONE同事务提交，之后才ACK；不会生成真实报告或岗位索引。

有效租约下重复消息不执行、不提前ACK，本次消费返回deferred并关闭连接。租约过期可重新领取，旧token不能心跳/提交。普通模式只执行合成完成处理器；T7另提供下述显式Checkpoint图模式，停止证据与线程切换规则对领取路径统一生效。T8已增加取消API及安全边界终结；取消标志阻止继续执行业务。T5已为预算耗尽和非法消息增加下述持久移交流程。

迁移 `202611260001_s14_task_execution_guard`增加数据库trigger，禁止任务fenceToken/generation回退及已终态任务变回其他状态；无需重建表或改旧迁移。回退应用时保留记录和约束，不重置任务/收据/队列。该trigger不替代应用fence条件，也不限制官方Checkpoint内部SQL。

### S1.4-T5 重试、dead事件与隔离区

更新后先 `pnpm run db:generate`、`pnpm run build`，按前述方法确认PostgreSQL归属后执行 `pnpm run db:deploy`，再执行 `pnpm run outbox:setup` 补齐两类dead路由绑定；旧requested及Broker DLX绑定保留，队列/策略不清空。迁移202611260002只新增任务retryAt和Quarantine可信消费主体/去重字段及约束，兼容历史无owner诊断行。

使用原 `tasks:consume` 和 `outbox:publish` 命令。可恢复错误写RETRY_WAIT和延迟Outbox后ACK，实际到期后需再次运行发布批次及消费会话；也可显式启动下述T6 watch扫描发布。次数、时间、token/成本/调用预算来自冻结输入，不因重试重置；错误分类和24–30秒/96–120秒退避见[架构§5.4](architecture.md#54-重试死信与长任务)。业务FAILED与dead发布成功是不同状态，查询数据库的任务errorCode和Outbox publishedAt/failedAt/lastErrorCode判断各自结果，不通过ACK或返回码宣称所有dead都已投递。

未知/畸形消息在同事务保存脱敏Quarantine和dead Outbox后ACK；数据库不可写或写dead事件失败时整个事务回滚、不ACK。只持久哈希、UUID及允许的元数据，不保存非法正文/原始异常，不能靠隔离记录恢复原报文。当前没有隔离区清理/重放API；禁止按前缀或全部Quarantine记录清库。

回退到T4代码时先停止会读取新dead事件的发布进程并保留数据/消息：旧发布器不认识dead契约，会将其标为INVALID_EVENT，不能保证混跑版本正确。已迁移的字段和数据保留，不删除旧迁移、队列或卷；需要回退时单独评估待发新事件，不能自动重置事件预算。此次无依赖升级、新账号、新Docker服务或新vhost。

### S1.4-T6 定时对账

先生成客户端、构建，按上文核对PostgreSQL归属后应用新增迁移，再使用：

```powershell
pnpm run db:generate
pnpm run build
pnpm run db:deploy
pnpm run tasks:reconcile once
# 前台定时运行，Ctrl+C关闭：
pnpm run tasks:reconcile watch
```

命令启动时核验PostgreSQL和RabbitMQ项目/服务/端口/卷，使用固定开发owner。once运行一轮；watch每轮结束后等待10秒，不重叠执行。默认每种任务10条候选，长期未完成窗口120秒，每轮60秒期限；通过[reconciliation配置](../src/infrastructure/reconciliation/config.ts)验证范围。watch连续3轮数据库/任务修复错误退出；逐轮结构化汇总只包含结果分类、Outbox数量/最老时间，不输出原始数据或异常。once遇到持锁阻塞、失败投递、修复错误或停止会返回非零；这不授权自动重置失败任务/Outbox预算。

对账提交恢复事务后才调用既有Outbox发布器，因此RabbitMQ不可用时已写入的恢复计划仍保留；publisher有界失败不回滚任务。还需运行原 `tasks:consume` 执行合成任务；对账器不在内存执行任务或生成报告。终态跳过，无取消请求时有效租约/未来retryAt跳过；T8的取消请求单独按安全边界终结。持有同任务执行锁时返回lock-held，不抢占。

消费者现在从原3连接池保留一条session advisory lock连接，正常事务继续使用池中其他连接。默认每个消费命令一个执行；不得自行增加同一上下文并发使锁连接占满池。对账使用transaction advisory lock，无长期专属连接。新旧消费者不能与对账器混跑：旧T5进程没有锁协议，可能使对账器误以为执行锁空闲；部署前停止旧消费会话，再统一更新T6消费者和对账器。

迁移202611260003仅新增两类任务recoveryCount（非负、默认0）和owner/status/updatedAt索引；旧记录兼容，不清空数据。默认最多恢复调度3次，输入尝试次数/总期限仍累计。回退时先停止watch和消费者，保留字段、事件、任务及原卷；不改已应用迁移。对账器不改Checkpoint schema/thread，图恢复由T7消费路径处理。

### S1.4-T7 合成图与执行隔离

停止旧消费会话，按上文核验PostgreSQL归属，再生成客户端、构建并部署新增迁移 `202611260004_s14_checkpoint_fence`。该迁移只新增业务attempt停止证据、合成产物与合成索引目标表及图代次约束；不改官方Checkpoint表。Checkpoint运行配置和官方setup需按下一节事先完成。

```powershell
pnpm run db:generate
pnpm run build
pnpm run db:deploy
pnpm run tasks:consume:graph
```

新命令加载 `infra/.env` 和 `infra/.env.checkpoint`，通过现有ConsumerModule/Nest装配analysis消费者与两节点官方StateGraph；沿用有界消费、手动ACK、固定开发owner及冻结输入预算。它不新增服务，也不自动启动API/空Worker的消费者。不要对同一队列同时运行普通合成完成模式和图模式；选择本次验证需要的模式。首次无Checkpoint时从冻结输入启动，已确认停止且有Checkpoint时使用原thread和null输入续跑；旧attempt无停止证据则领取事务切换新thread并递增graphGeneration，复用合法NodeArtifact。

业务池仍最多3连接，其中1条在执行期持有session锁；图执行另使用最多3连接的Checkpoint池，同一进程预算最多6连接，测试父子进程分别计入总额。图处理器等待已开始的产物/saver写入及池关闭，消费者才记录executionStoppedAt并释放锁。中止后5秒内仍未收束，则销毁锁连接并保留“停止未知”，下次恢复使用新thread；这不等于强制终止旧进程。`confirmWorkerExit`仅供可信本地监督方绑定领取身份并确认自己的子进程实际退出，当前没有常驻监督服务。

升级时统一更新消费者，不能混跑缺少停止/线程协议的旧代码。回退前停止图消费者与watch并确认没有活动执行；保留新增表、产物、attempt与Checkpoint，不自动down迁移、删线程或清卷。旧版本不具备新隔离保证，需要重新核对其能否恢复现存任务；不要用不兼容图版本直接续跑。真实报告、LLM与JobVersion/Qdrant索引不在此合成实现范围。

### S1.4-T8 任务查询与取消API

T8复用既有cancelRequested、任务/事件/attempt字段，无新数据库迁移、服务或队列。API默认仍只启用健康检查；要对接本地任务查询/取消，先按上文应用全部已有迁移，再在PowerShell运行：

```powershell
pnpm run build
$env:TASK_API_ENABLED = 'true'
node --env-file=infra/.env --env-file-if-exists=.env dist/src/main-api.js
# 关闭API后，恢复该终端默认设置：
$env:TASK_API_ENABLED = 'false'
```

根目录.env需要APP_ENV=development（或test）、HTTP_PORT与loopback HTTP_HOST；DATABASE_URL由infra/.env提供，必须是现有本机项目数据库/业务账号及55432端口。显式环境变量优先于env文件；不打印配置或把密码复制进命令。启用后拒绝APP_ENV=production、HTTP_HOST=0.0.0.0、非法开关或数据库配置，错误只报告字段名。未启用时不加载任务数据库模块，不改变原健康检查/空Worker启动路径。

当前IdentityPort是固定开发主体，无法通过请求头或正文切换用户，不具备公网认证能力。API只有PostgreSQL池（最多3连接），不在HTTP请求中启动RabbitMQ消费者、LangGraph或观测；详情见[HTTP API](api.md)。关闭应用时释放池。

POST取消仅保存请求并返回202。继续运行 `tasks:consume analysis`、`tasks:consume job-index`（图验证使用 `tasks:consume:graph`）或 `tasks:reconcile once|watch`，它们才能在安全边界提交CANCELLED。持锁执行清理结束前保持RUNNING；对账不能抢占。无锁取消不等待未来retryAt/未过期租约，也不重新发布恢复任务或dead消息；现有调度消息仍可能发布，消费者见终态后可靠ACK。全部消费者和对账器应统一升级到T8，否则旧代码会长期跳过取消请求。

回退前停止API、消费者及watch并核对待取消任务；旧T7消费者/对账器没有完成取消的路径，回退不会自动撤销已保存的取消请求。保留任务、事件、收据与Checkpoint，不重置flag或清空队列。取消终态仅表示业务写入被隔离，不代替旧进程实际退出或资源删除授权。

### S1.4-T9 OpenAPI生成与CI

开发依赖 `@asteasolutions/zod-to-openapi` 固定9.1.0，使用同一组运行时Zod Schema生成OpenAPI 3.1，提交产物为 `docs/openapi.json`。生成脚本先安装其Zod扩展，再动态导入Schema，扩展只存在于生成进程；API/Worker不导入该开发依赖。

```powershell
pnpm install --frozen-lockfile
pnpm run openapi:generate
pnpm run openapi:check
```

生成命令会构建并写入产物；检查命令构建后逐字节比较规范化换行的结果，缺失或过期时退出1，不覆盖文件。文档生成不需要数据库或其他服务；首次编译仍需按初始化步骤生成Prisma客户端。当前只描述health、任务查询及取消，不提前生成规划接口。严格未知查询参数、跨字段计数关系及状态迁移约束仍由运行时Zod/事务实现，不能把OpenAPI结构描述当成全部业务规则。

[CI工作流](../.github/workflows/check.yml)执行冻结安装、生成本地诊断配置/Prisma客户端、类型检查、Lint、基础测试与openapi:check，Actions固定到核验过的官方提交。它不自动启动真实集成服务，也不替代本机真实回归；远端执行结果见[开发进度](progress.md)。依赖变化、Schema和产物应一起提交，勿手工修改openapi.json。

## S1.3 诊断组件初始化

### S1.3 Checkpointer 初始化（独立于业务进程）

在基础设施启动、`infra:provision` 与 `db:deploy` 完成后执行：

```powershell
pnpm run checkpoint:init
pnpm run build
pnpm run checkpoint:provision
pnpm run checkpoint:setup
```

`checkpoint:init` 只创建被忽略的 `infra/.env.checkpoint`，不覆盖已有文件或轮换密码。
`checkpoint:provision` 核对本项目PostgreSQL容器标签、运行状态、端口绑定、数据卷及卷标签，然后建立独立数据库 `resume_studio_checkpoint`、schema `langgraph` 和两个专用角色。数据库仍由本项目管理员持有；`resume_studio_checkpoint_setup` 持有schema并执行官方初始化，`resume_studio_checkpoint` 只有CONNECT、schema USAGE、三张状态表的读写及迁移版本表只读权限。不会把这些表加入Prisma迁移。

为隔离现有诊断业务库，provision撤销 `resume_studio_s12_test` 的PUBLIC CONNECT，保留其所有者 `resume_studio_test` 的连接权限；Checkpoint数据库也不允许业务账号连接。既有数据、诊断表、业务账号密码和迁移保持不变。新建角色/数据库带项目归属注释；同名但无归属标识的资源将被拒绝接管。

`checkpoint:setup` 只在显式命令或集成测试中调用官方 `PostgresSaver.setup()`，使用专用session advisory lock串行化初始化；API/空Worker未自动接入，T7显式图消费者只使用运行账号，不执行DDL。生产升级期间仍须安排受控迁移，不把本地setup当作无停机升级方案。

| 配置 | 约束 |
|---|---|
| CHECKPOINT_DATABASE_URL | 本机55432端口、独立Checkpoint数据库、运行账号；不接受URL查询参数覆盖连接选项 |
| CHECKPOINT_SETUP_URL | 同库的setup账号，仅初始化时加载，不传给合成运行子进程 |
| CHECKPOINT_SCHEMA | 固定 `langgraph`，防止schema名称进入上游SQL时产生注入 |
| CHECKPOINT_POOL_MAX | 1–3，默认生成3 |

业务诊断池上限3，Checkpoint运行池上限3，单个同时持有两类池的进程最多6条连接；setup使用2条独立连接（锁+迁移）。多进程、测试父/子进程与运维连接都须另计入PostgreSQL总预算。池获取超时3秒、SQL超时5秒；关闭显式释放外部pg池。

D4于2026-11-25确定采用本地自托管Langfuse，T4/T5的实际部署及验证见下节。

### S1.3 本地 Langfuse 与独立启停

Langfuse与业务基础设施归在同一个Compose项目 **resume-studio**。`compose.observability.yaml`是叠加配置，六个服务均使用 `langfuse-*` 名称、`observability` profile及专属 `resume-studio_observability` 网络。业务三服务保持原default网络。Langfuse的PostgreSQL、Redis、ClickHouse及MinIO分别使用自己的账号和卷，不连接业务PostgreSQL、Checkpoint数据库或RabbitMQ。

```powershell
pnpm run observability:init
# 首次部署且本机缺少镜像时，显式拉取固定digest：
pnpm run observability:pull
pnpm run observability:config
pnpm run observability:up
pnpm run observability:status
pnpm run observability:stop
```

访问 `http://127.0.0.1:53000`。登录邮箱和随机密码位于被忽略的 `infra/.env.observability` 中的 `LANGFUSE_INIT_USER_EMAIL` / `LANGFUSE_INIT_USER_PASSWORD`，工具不打印秘密。首次初始化同时创建本地组织及 `resume-studio-diagnostics` 项目/API key；后续启动不轮换凭证。Web与MinIO API仅绑定127.0.0.1的53000/59090端口，其他服务没有主机端口；遥测、AI Gateway和实验功能关闭，未配置模型或云观测账号。

`infra:up/stop`明确指定postgres/rabbitmq/qdrant；`observability:up/stop`明确指定六个langfuse服务。profile负责选择，服务列表负责限制启停范围。不要用整个项目的 `down` 代替分组停止，也不要加 `--remove-orphans` 或删除数据卷。Web健康后才启动Langfuse Worker，避免新库迁移期间缺表。首次安装的上游数据库迁移可能超过240秒等待窗口；记录失败、核实迁移进度后再次运行up，不重置数据库。

观测脚本在操作前核对容器、网络和卷的Compose归属；全新环境由up显式创建五个专属卷，随后以external方式挂载，停止/重建容器不会删除这些卷。`pull`和`status`不创建卷。

2026-11-25合并部署时，保留了首次创建的五个 `resume-studio-observability_*` 卷，并在本机配置中用 `LANGFUSE_POSTGRES_DATA_VOLUME`、`LANGFUSE_REDIS_DATA_VOLUME`、`LANGFUSE_CLICKHOUSE_DATA_VOLUME`、`LANGFUSE_CLICKHOUSE_LOGS_VOLUME`、`LANGFUSE_MINIO_DATA_VOLUME`显式映射。旧卷名称/标签只表示来源，当前所有容器均属于resume-studio；归属检查逐项验证原标签和挂载位置，而非按名称前缀放行。新机器默认使用 `resume-studio_langfuse_*`。不要删除这些映射来修复启动问题，否则可能连到空卷。迁移保留原凭证，验证了旧trace可读后才移除旧容器与空网络；未删除任何卷。回滚所需的原Compose与资源快照保留在本机忽略目录 `data/observability-project-migration/`，回滚前必须停止新实例，禁止两个数据库进程同时挂载同一卷。

| 应用观测配置 | 含义 |
|---|---|
| OBSERVABILITY_ENABLED | 缺省false；显式启用时其余连接字段必须合法 |
| LANGFUSE_BASE_URL | 本阶段只接受 `http://127.0.0.1:53000` |
| LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY | 本地诊断项目凭证，禁止日志输出 |
| OBSERVABILITY_MAX_QUEUE_SIZE | 8–512，生成默认128；活动与等待导出的span共用容量 |
| OBSERVABILITY_EXPORT_TIMEOUT_MS | 100–5000毫秒，默认2000；每批一次HTTP尝试，包含响应读取 |

ObservabilityModule按需注册一个进程级provider；当前只在合成图测试中接入，API/空Worker仍不启动业务图或观测模块。允许明确的correlationId、固定节点名、状态和计数；输入/输出统一替换为REDACTED，自由元数据、异常/事件文本、资源属性和tracestate不导出。每批最多16个span、128KiB，一条请求在途；排队期限为单次超时的两倍，禁止重定向、自动重试和媒体上传。溢出、过期、传输失败、关闭和处理失败有独立丢失计数，stats可读取，flush/关闭输出不含原文的JSON计数。观测不提供可靠投递保证。

脱敏在span结束时、进入Langfuse异步处理及导出队列之前进行，不等于敏感输入从未存在于进程内存或活动span。容量限制涵盖已接纳的活动span及等待/在途导出；活动span本身没有该排队期限，只有进入exporter后开始计时。流量持续产生时flush也不代表有固定全局完成期限；当前只验证有限合成图和有界请求场景。

本机Docker约5.8GiB内存，已经验证合成写入，不代表长期运行或生产容量。部署镜像及兼容版本见依赖说明；故障和脱敏验收见测试文档。

### 完整集成的准备顺序

先完成上文基础设施初始化，再执行以下命令。它们用于准备S1.3验收环境，不代表每次后续任务都会重新执行；实际运行记录见progress。

```powershell
pnpm run checkpoint:init
pnpm run build
pnpm run checkpoint:provision
pnpm run checkpoint:setup
pnpm run observability:init
# 若本机缺少已固定的观测镜像，先运行 observability:pull
pnpm run observability:config
pnpm run observability:up
pnpm run test:integration
```

完整集成要求三份本地配置和九个服务就绪；每次实际执行结果见[最新进度](progress.md)。不要把Compose健康与集成测试通过混为一谈。

### 原生Qdrant回归对照

维护者于2026-11-26授权使用自行启动的 `D:\qdrant-x86_64-pc-windows-msvc\qdrant.exe`。默认 `test:integration` 仍验证项目Docker实例；显式对照命令只替换测试上下文的Qdrant连接，PostgreSQL、RabbitMQ、Checkpoint与Langfuse配置保持原样。它不是应用部署切换，不停止或搬迁任一服务/数据。

在被忽略的 `infra/.env.qdrant-native` 配置以下非敏感字段（先确认文件不存在，已有配置不要覆盖）：

```dotenv
QDRANT_TEST_TARGET=native-windows
QDRANT_NATIVE_ROOT=D:/qdrant-x86_64-pc-windows-msvc
QDRANT_NATIVE_URL=http://127.0.0.1:6333
```

如实例启用认证，另在该文件设置 `QDRANT_NATIVE_API_KEY`，不提交或输出密钥；本次实例未开启API Key。准备好其他集成依赖后，依次运行，不同时执行两套全量：

```powershell
pnpm run test:integration
pnpm run test:integration:native-qdrant
```

[原生目标验证](../test/support/native-qdrant.ts)仅支持Windows及明确的loopback端点，检查6333监听进程、解析后的授权exe路径、PID、启动时间和二进制大小/修改时间；操作前及精确删除前复核同一进程身份，变化则拒绝删除。该验证没有计算二进制哈希，不以目录名或端口单独认定归属。测试沿用原5秒请求超时、CRUD/维数断言和15秒清理对账，仅操作本轮预先确认不存在的UUID集合。待清理manifest增加目标类别/地址及原生进程身份，不含密钥；它不是后续自动删除授权。

原生与Docker结果分开写入progress。原生通过只证明这台机器该实例的本轮对照成功，不能据此关闭默认Docker验证、标记Docker持久化延迟已修复或完成生产性能验收。

## API 与 Worker

```powershell
if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
pnpm run build
pnpm run start:api
# 另一个终端：
pnpm run start:worker
```

| 配置 | API | Worker | 说明 |
|---|---|---|---|
| APP_ENV | 必需 | 必需 | development / test / production |
| HTTP_PORT | 必需 | 不使用 | 十进制整数，1–65535 |
| HTTP_HOST | 默认127.0.0.1 | 不使用 | 支持127.0.0.1、0.0.0.0、::1；本地使用loopback |

启动脚本用Node env-file读取.env；入口先通过仅依赖Zod的配置模块校验，再动态加载各自应用装配。启动失败报告独立于Nest/AppLogger，缺配置或非法值时不会加载Nest；退出码为1，只输出安全错误码与字段名。`/health` 是 liveness；默认API与空Worker不自动连接诊断服务，显式任务API按T8配置装配数据库。Worker用可清理定时器保持存活，实际消费者仍由显式命令运行。

Ctrl+C触发应用关闭；关闭超过5秒退出失败。脚本/容器停止不应被当成持久化数据删除。

### 与前端联调

前端仓库为 [Resume-Studio-Frontend](https://github.com/Mingan-X/Resume-Studio-Frontend)。API保持默认的 `127.0.0.1:3000`，前端开发服务器把 `/api` 与 `/health` 代理到该地址，因此后端不需要也不应为联调开启CORS。约定见[接口契约规范](api-contract.md#3-部署拓扑与跨域)。

## 诊断资源约定

为兼容现有配置和已应用迁移，保留以下固定标识，不能仅为改名而重建数据库：

| 类型 | 固定标识 |
|---|---|
| 数据库 | resume_studio_s12_test |
| PostgreSQL / RabbitMQ测试账号 | resume_studio_test |
| RabbitMQ vhost / INFRA_TEST_SCOPE | resume-studio-s12-test |
| 诊断表 | s12_diagnostic_record |
| RabbitMQ资源前缀 | s12. |
| Qdrant测试collection前缀 | s12_ |
| 持久化验证manifest | data/s12-persistence.json |

诊断配置只接受本机地址、上述账号/数据库/vhost和专属端口55432/55672/56333；每轮临时资源附UUID。数据库池最大3连接，连接获取超时3秒、SQL超时5秒；Qdrant调用超时5秒，发布确认超时5秒。

这些是当前诊断实现的配置，不是业务任务的生产级吞吐或时延保证。基础设施配置还要求 `DATABASE_URL`、`RABBITMQ_URL`、`QDRANT_URL`、`QDRANT_API_KEY` 和 `INFRA_TEST_SCOPE`；由infra/.env提供，不向日志打印。T5/T6已实现合成任务有界重试、总期限与对账；基础设施长期断线监督和生产负载仍待后续验证。原生Qdrant仅通过上文显式测试入口使用，不放宽应用配置校验。

## 停止与数据保留

`pnpm run infra:stop`只停止postgres/rabbitmq/qdrant，`pnpm run observability:stop`只停止六个langfuse服务；对应up命令分别恢复。两组操作都保留数据卷，显式服务列表与代码入口见[scripts/infra-compose.mjs](../scripts/infra-compose.mjs)和[scripts/observability-compose.mjs](../scripts/observability-compose.mjs)。不要用不带服务名的整项目操作替代这些命令。

禁止删除数据卷、数据库、账号或本地凭证来处理连接问题。丢失任一 `infra/.env`、`infra/.env.checkpoint` 或 `infra/.env.observability` 后重新生成随机密码，不会同步修改已存在的账号；先安排凭证恢复，保留观测旧卷映射。现有本机迁移快照用于回滚参考，不构成已经验收的备份恢复流程。

目前凭证通过本地环境文件注入；Qdrant SDK对HTTP+API Key可能提示非HTTPS连接。仅绑定本机的开发配置不等于生产TLS或完善的权限方案。生产部署前还需认证、TLS、备份恢复、秘密管理、容量与高可用评估。

## 验证

执行 `pnpm run test:integration` 验证真实服务；不能以缺少服务为由跳过。完整覆盖及已有证据见[测试文档](testing.md)。持久化重启实验会写入合成数据并重启本项目容器，需单独安排执行，不作为常规文档检查的一部分。
