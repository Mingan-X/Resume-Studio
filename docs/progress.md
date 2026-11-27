# 开发进度

按时间倒序记录每个阶段或任务的完成情况与验证证据。阶段定义与状态总表见[开发计划](development-roadmap.md)。

记录规则：

- 每条记录写明日期、阶段/任务编号、分支或提交、完成内容、执行的检查及结果、未执行项及原因。
- 只记录实际运行过的检查。验证结果只代表当时的环境，不能推广为其他平台或生产环境已验证。
- 已有记录不改写；发现错误时追加更正记录。

## 2026-11-27 S2.4-T3图与恢复基础实现保存（阶段回归未通过）

保存固定StateGraph、稳定分支合并、NodeArtifact分支/prompt/model身份及不可变保护、真实analysis模型版本领取过滤、graph代次预算校验与子进程恢复专项。T3生产消费装配与实际节点在T4–T8依次保存后闭合；当前提交只包含图/恢复基础，不把fixture当语义实现。工作区完整代码的类型检查、零警告Lint与基础118/118通过（data/s24-stage-unit.log，76.258秒），OpenAPI一致性通过；19/20条新增迁移均已校验并二次deploy无pending。子进程专项3/3及当前全量中的相同用例通过。

当前完整test:integration仍运行，但已发生Langfuse projects请求5008ms超时，未放宽原5秒门禁、未归L1/L2。先只读核验归属/健康/日志：受检Langfuse容器healthy、restartCount=0、OOMKilled=false；日志无定位原因，当前VM I/O full avg60=26.89仅表明当时有等待，不证明故障根因（data/s24-langfuse-diagnosis.json）。保存已验证实现不等于任务/阶段验收通过；不得合并或推进依赖该门禁的阶段。最终计数和处理结论待本轮结束另记。

## 2026-11-27 S2.4-T3–T8接线与定向验证

T3后续子进程专项3/3、17.668秒通过（data/s24-t3-graph-targeted-3.log）：确认退出复用thread、未确认停止切换thread、已存LOAD/PARSE不重复、旧fence/错误graph/取消写入拒绝、分支/版本冲突及不可变节点验证。第一次新Worker提前退出未复现，诊断修正不宣称定位其底层根因，原失败继续保留。

T4–T8按已确认任务继续编写EXTRACT缓存与日期、PROFILE子图及Rubric映射、冻结RecallQuery/Candidate绑定、Send匹配/持久计划/400预算、汇总/进度及消费入口。代码尚未按完成提交；后续任务用于完成T3业务节点/命令接线，不将测试fixture或部分骨架标成已交付。Prisma generate/validate/deploy两次/status通过，新增17–20条迁移均应用；中断后类型检查发现summary空值TS18047并修正，最新类型/Lint通过。

节点单元定向7/7、7.774秒通过（data/s24-nodes-unit-targeted.log）；抽取真实DB专项1/1、7.046秒（data/s24-t4-extraction-targeted.log），跨任务同简历版本缓存复用，首次模型调用1、后续0，fence与数据库不可变/互斥验证。首次完整业务链路专项3/3、43.543秒（data/s24-runtime-targeted.log），真实PostgreSQL/Qdrant＋显式假模型验证SUCCEEDED/PARTIAL/FAILED、取消、降级、重复投递不重调模型；420计划中400完成/20明确预算行，本轮全部owner/thread/集合清理manifest=true。

收尾补充PROFILE原生子图、等级映射、终态收据失败回滚/恢复不重调模型及运行中取消，尚待新专项结果。首次新命令因CLI测试env类型推断TS2339未进入测试，改为NodeJS.ProcessEnv后重跑。真实模型/embedding、质量结果和原生对照未执行；原生无监听不启动。所有构建/检查按单命令串行，基础入口已显式test-concurrency=1。

## 2026-11-27 S2.4-T3业务图与恢复验证中

T2已提交3284ab8。新增固定业务StateGraph和AnalysisArtifactRepository，图状态只含task/input hash、节点产物ID或显式失败；LOAD→PARSE→EXTRACT→VALIDATE后PROFILE/RECALL并行，SNAP/MATCH后JOIN等待双路，再FINALIZE。节点实现按后续T4–T8注入，当前专项是明确测试节点，不宣称模型/业务终态交付。operationKey包含branchKey/input/component/schema/prompt/model，产物写入/读取核对活fence/租约/取消/deadline/graph身份及完整冻结snapshot，恢复再次核对数据库产物。真实analysis领取要求匹配modelConfigVersion，reserveUsage新增graph代次核对。

Prisma generate/validate/deploy两次/status通过，16条迁移已应用；类型检查、Lint初次通过。第一次真实子进程专项1通过/2失败（含父测试），21.173秒（data/s24-t3-graph-targeted.log）：未确认停止路径切换thread并复用产物通过；确认退出后复用thread路径新Worker在claimed前结束。测试fixture在finally先断IPC导致外层catch安全诊断未送达，先修正诊断顺序和lock-held显式失败，不改业务恢复/超时/断言。第二次命令build遇process.send回调重载TS2345，测试未启动，修正为显式四参数后继续诊断。首次精确owner/thread清理manifest=true，无遗留数据；T3尚未完成/提交。

## 2026-11-27 S2.4-T2模型调用预算封装完成

T1已提交f30b8ab。T2新增AnalysisModelCaller，复用既有ModelExecutor与Worker的reserve接口：逐次网络尝试/一次修复先预留累计次数/token/费用，恢复或并行分支不重置账本；核对真实snapshot owner/modelConfigVersion/币种、总deadline、取消；数据库/fence错误原样交回，慢预留排空后才结束调用服务。保持既有重试层、未settle并发槽及安全错误码。输入末次脱敏和ObservabilityService白名单span不传原文LangChain回调；usage未知为null，不以预留冒充实测费用。

最终typecheck、零警告Lint、基础110/110通过（data/s24-t1-t2-unit-final.log），其中T2四项行为专项覆盖修复/重试、恢复不重置、并发预算拒绝、配置拒绝、DB错误、取消/总期限与迟到预留排空。共用完整集成137/137验证既有累计SQL账本/恢复/取消窗口；本任务新增的是调用封装，尚未把真实任务接入图，不将内存账本测试当作真实分析Worker恢复证明，T3继续接线验证。详见[分析模型预算](analysis-model.md)。

无新增依赖、迁移或HTTP，无需重复部署/OpenAPI生成；文档链接与diff检查通过。真实模型、真实token/费用与T9按路线图延后，不调用Key或付费服务。按任务提交T2后继续T3。

## 2026-11-27 S2.4-T1完成验证，真实分析创建已交付

完成真实TaskInputSnapshot与synthetic区分、POST /api/v1/analyses、202 taskId/statusUrl、所有权/解析产物检查、corpus/Rubric/configuration冻结及真实外键、同事务Outbox、同key同请求复用和不同请求409；查询支持真实任务，synthetic入口不领取。新增配置版本不可变表，不持久化模型连接/Key。API、契约、OpenAPI、架构、部署/测试及分析输入文档同步。Qdrant15秒请求修正、CLI早校验与串行基础入口属于本次回归阻塞修复，依据和历次失败完整保留于下文。

最终typecheck、零警告lint通过；基础110/110、60.465秒（data/s24-t1-t2-unit-final.log，含独立T2四项测试草稿）；此前串行109/109、46.635秒通过。最终完整test:integration137/137、592.790秒（data/s24-t1-integration-2.log），覆盖6项真实分析创建HTTP/DB用例和既有回归；Qdrant基础创建4803.3ms、索引主体34.976秒、Outbox死信181.149秒。OpenAPI生成/一致性通过；迁移generate/validate/deploy两次/status通过、15条。11份文档189项本地文件链接及git diff --check通过。新增配置文件边界测试在完整集成后补充，最终基础已覆盖；生产代码未再变更。

归属核验后的只读资源（data/s24-t1-resources.json）：仅开发owner=1；Job/JobVersion/JobIndexTask/JobIndexRequest/JobCorpusVersion/CandidateSet/Candidate/AnalysisTask/AnalysisConfiguration/Resume/FileAsset全部0；4正式队列ready/unacked=0；Qdrant集合空。正式rubric-v1的hash仍6d958ebc4be30bab8cbe7a68b6ff96d0135cc88104bf901cacda7b3dc176648d，AI_DRAFT/PENDING_REVIEW未改。没有删卷/数据库/配置，旧孤立policy未操作。

未执行：原生6333未监听，按用户手动管理约定不启停；真实Key/embedding/模型T9、人工标注/质量及目标服务器/L1/L2解除仍按路线图延后；没有依赖声明/锁文件变化，不重复冻结安装。T1按任务提交，阶段仍进行中，不合并/推送直到非延后任务和阶段回归完成；接续T2/T3。

## 2026-11-27 S2.4-T1专项通过，基础入口改为遵守串行约束

Qdrant索引专项1/1通过，45.800秒（主体38.553秒，data/s24-t1-qdrant-targeted.log），在原180秒父测试及15秒初始化期限内验证幂等upsert、原子READY、旧目标fence；精确清理成功。随后基础108/109、21.697秒（data/s24-t1-t2-unit-5.log），索引CLI早期拒绝及module-load断言通过，唯一失败为百炼40ms超时用例请求数expected 1/actual 0。单独原样运行百炼专项1/1、0.378秒通过（data/s24-t1-bailian-targeted.log）。

发现pnpm test的Node默认仍并行运行文件，与用户明确“严禁并行构建/安装/测试”的本机约束不符。只为基础test脚本补--test-concurrency=1，与已有集成入口一致；40ms超时、请求数严格等于1和全部其他用例/断言不改，测试内部幂等/竞争并发仍保留。依赖声明和锁文件未变，不新增冻结安装要求。该调整是执行调度，不改业务期限或验收条件；接着执行串行基础及完整回归，历史失败均保留。

## 2026-11-27 S2.4-T1索引CLI早期校验修正

Qdrant15秒调整后基础108/109、33.965秒（data/s24-t1-t2-unit-4.log）；新5.5/11.5秒Qdrant HTTP桩及T2四项调用包装测试通过，唯一失败再次为原索引CLI缺配置路径在10秒时stderr为空。原断言和10秒限制未改，不归L1/L2。源码显示入口在try内校验配置前静态导入数据库、Nest身份和完整运行链路；修正为只依赖Zod/路径校验的入口，模式、开发身份、绝对配置路径及embedding文件校验通过后才动态加载运行模块。执行逻辑、错误码及关闭流程保留，并复用module-load hook增加缺配置/production拒绝时不加载Nest/Prisma/runtime的断言。

此修正属于T1回归阻塞处理，不扩展业务范围或选择新技术。类型检查、Lint通过，正在以原180秒父测试/15秒初始化总期限运行失败索引专项（data/s24-t1-qdrant-targeted.log），通过后再执行完整回归。此前日志均保留；T1/T2尚未提交或标完成。

## 2026-11-27 S2.4-T1回归失败定位与Qdrant调整

新增HTTP/数据库专项5/5通过（data/s24-t1-targeted.log，3.529秒）；随后补充实际API装配缺配置503用例，已进入完整回归。第二次基础104/105、8.139秒，唯一失败为OpenAPI测试路径清单未列新路由，已保留精确路径相等断言并补入/api/v1/analyses；第三次105/105、8.831秒通过（data/s24-t1-unit-2.log、unit-3.log）。此前HTTP桩和索引CLI失败在原限制下通过，不覆盖第一次失败。类型检查、零警告Lint、OpenAPI生成通过；7份文档107项本地文件链接通过。

第一次完整`test:integration`136/137通过，689.444秒（data/s24-t1-integration.log）。唯一失败为既有S2.3 job-index首次ensure的UPSTREAM_TIMEOUT；新建分析及全部其他用例通过，基础Qdrant创建5322.6ms、Outbox死信181.502秒、Langfuse持久化通过。失败的本轮集合/队列/DB已精确清理，manifest cleaned=true；未宣称T1完成。

归属核验后服务端白名单计时确认该集合PUT耗时11.929918秒，超出当前10秒；超时后立即回查404、稍后PUT成功，详细时间序列见[诊断](research/s24-qdrant-2026-11-27.md)，忽略目录保留脚本/JSON。沿用用户已授权“适当放宽Qdrant”，单请求上限进一步为15秒，原15秒初始化/清理及全部操作/任务总期限、取消、重试层数不变；其他服务及父测试时限不变。保留5.5秒HTTP桩，补11.5秒响应覆盖；接着执行验证，不以重复无改动全量碰运气。历史L1/L2及原5秒性能目标保留。

原生6333无监听，未启停/未执行native对照。等待T1全量期间仅另写T2独立ModelCaller/单元草稿，未接入运行图；后续基础检查可能覆盖两任务代码，但T2须单独记录/提交，不能混称T1回归验证了模型业务图。

## 2026-11-27 S2.4-T1实现与验证中

接续feature/s2.4-profile-matching，起点5db9eb0工作区干净。增加真实analysis快照、owner范围创建HTTP、服务端安全配置冻结、AnalysisConfiguration不可变版本及简历/corpus/Rubric/configuration外键；corpus沿用已合并owner/versionName。任务/Outbox同事务；同key同请求先重放原任务，配置轮换不换输入；合成领取入口保持拒绝真实任务。尚未标完成或合并。

已执行：Prisma generate/validate成功，db:deploy两次及status通过，15条迁移已应用；类型检查与Lint曾通过。编写测试期间两次括号语法错误、Lint两处未await test、后加SQL拒绝测试的Prisma JsonValue输入类型错误均逐项修正，不修改有效测试标准。

第一次`pnpm test`为102/105，22.029秒，原日志data/s24-t1-unit.log保留：OpenAPI过期（新增接口尚未generate）；百炼HTTP桩超时路径expected request delta 1实际0；索引CLI原10秒内stderr为空，预期INDEX_RUNTIME_FAILED。后两项不归L1/L2，未修改期限、断言或旧实现。首次openapi:generate被新SQL拒绝测试的TS2322阻断（data/s24-t1-openapi-generate.log），修正为Schema校验后的JSON输入后重跑。后续结果另记，不覆盖旧失败。

真实服务专项与完整回归尚待执行；原生Qdrant仍依用户手动启停、无监听不启动。真实模型/embedding调用、人工指标及目标环境验证继续按路线图延后。没有依赖/锁文件变更，没有操作master、前端或第三方消息。

## 2026-11-27 S2.3合并推送，S2.4接续

S2.3-T9=0ce6ab55625f5ef8529205af4427904c295018d2已--no-ff合并develop，合并e0ccfa7aba565b89cd3f6e5ac22c904a7a9a4e63；origin/develop同值，origin/feature/s2.3-job-recall=0ce6ab5，推送成功。S2.3待维护者统一验收，真实调用/人工标注/原生对照与目标环境限制保留；master及前端未操作。合并后工作区干净，从develop创建feature/s2.4-profile-matching，按-d清理已合并本地S2.3分支，远端保留。

S2.4状态进行中，仅阶段启动，尚无新业务代码。按用户已授权连续开发至S3.3、阶段间自主新会话继续的方式，准备新会话接续T1；本会话在交接后停止写工作区，不与新会话并发修改。新会话先读任务/架构/契约与实际代码，按任务检查/提交，真实模型T9继续按延后表处理，不重复确认D1–D11。

交接要点：14条迁移已应用，9个Docker服务运行；最终基础103/103、全量131/131（782.746秒），OpenAPI/typecheck/Lint通过。Qdrant单请求10秒是用户明确授权的新规则，其余期限/断言保持；原生6333未监听不能启停。正式rubric-v1在开发owner下保持AI_DRAFT/PENDING_REVIEW与既有hash，不能删。最终资源核验只剩开发owner/正式Rubric，队列空、集合空；历史孤立policy仍保留。L1/L2及全部历次失败见前文，不能扩大归因。

实现接口：JobCorpusRepository以owner/versionName存快照（不是自动latest）；RecallService与CandidateRepository已提供内部召回/冻结，SNAP接线时需真实TaskInput版本绑定。现analysisInputSnapshot仍仅synthetic，真实分析输入/创建HTTP、产物、图和临时finalize待S2.4。当前任务预算与fence/graph线程机制可复用，真实索引已显式按embeddingVersion选择能力；百炼仅HTTP桩、无正式Key/实际索引语料。只改启动文档无需重复业务测试，检查diff和链接后提交。

## 2026-11-27 S2.3-T9阶段回归完成，待统一验收

S2.3非延后任务实现完成并按T1–T8提交；T9同步README、架构、部署/测试、需求与JD实现状态。已交付工程链路：100条合成JD与字典/语料快照、关键词/向量/RRF、版本集合/alias与真实索引任务处理器、补建请求幂等、冻结候选、百炼HTTP适配器及本地显式消费/对账、人工标注格式/Recall@K脚本。没有新增HTTP接口，分析图接线留S2.4。

最终检查：typecheck、零警告lint通过；基础103/103通过（12.853秒，data/s23-t6-t8-unit.log）；OpenAPI一致性通过。最终`pnpm run test:integration`131/131通过、0失败/跳过，782.746秒（data/s23-t9-integration.log），覆盖最终城市冻结条件；Docker集合创建5879.9ms在授权10秒内，Outbox死信184.610秒在原窗口内。此前131/131共用回归、所有专项及历史失败分别保留。迁移generate/validate/deploy两次/status通过，14条；没有依赖声明变化，不重复冻结安装。文档12份206项本地文件链接与git diff --check通过。

归属核验后只读资源检查（data/s23-final-resources.json）：仅开发owner=1；Job/JobVersion/JobIndexTask/JobIndexRequest/JobCorpusVersion/CandidateSet/Candidate/AnalysisTask/Resume/FileAsset=0；4正式队列ready/unacked=0；Qdrant集合空。正式rubric-v1 hash=6d958ebc4be30bab8cbe7a68b6ff96d0135cc88104bf901cacda7b3dc176648d、AI_DRAFT/PENDING_REVIEW未修改。旧孤立policy未动，没有删除卷/数据库/配置。

延后/未执行：真实百炼Key与正式embedding重建、人工标签/质量指标、目标服务器及L1/L2解除按原路线图延后；原生Qdrant6333未监听，依用户手动管理约定未启停，native对照如实记未执行，统一验收补做。历史API L1、HTTP桩超时、清理DEPENDENCY_UNAVAILABLE等逐次记录保留；新清理修正不扩大期限。状态改待验收，按授权--no-ff合并develop并推送阶段分支/develop；master与前端不操作，随后新会话继续S2.4至S3.3。

## 2026-11-27 S2.3-T9阶段收尾准备

T4补建/恢复边界bc4a62a、T5召回/RRF与清理修正30ca3b8、T6冻结候选deb8a9e、T7百炼适配器53e811a、T8格式/评测脚本a318a53已分别提交。最后基础103/103、类型/Lint及OpenAPI一致性通过；正在运行最终完整test:integration（data/s23-t9-integration.log），不提前改阶段状态。整理README、架构§7、需求实现状态、JD历史边界、部署与测试入口；不改变需求/验收、不补虚假质量数据。

只fetch origin develop，local/remote均c50faf91fd662562ce1d4f7fc589911e1a84ee86；未操作master或前端。用户已授权阶段完成后--no-ff合并develop并推送阶段分支/develop，以及自主下一阶段会话，后续在检查完毕后执行。原生未监听、不自行启停，真实百炼Key/索引重建、人工标注/Recall指标与目标服务器按原延后安排。历史故障记录完整保留。

## 2026-11-27 S2.3-T8标注格式与Recall@K脚本（标注/指标延后）

新增人工相关性格式与说明、真实运行输入格式、macro/micro Recall@K计算及recall:evaluate命令。拒绝未完整标注的冻结语料、重复/未知岗位、query/corpus hash不一致、非人工声明/非百炼实测声明、降级运行；无相关岗位单列null与排除数，不算100%。文件上限10MiB，错误安全输出。provenance只是声明，不能由文件自动证明人工/实测，文档要求维护者保留可审查来源。

typecheck、lint及基础103/103通过，计算测试验证正例/无正例、截断、重复、缺标和假来源拒绝；测试对象是算术fixture，不生成评测数据文件或实测指标。`pnpm run recall:evaluate`无参数预期退出1且仅安全错误码（data/s23-t8-cli-missing.log），命令接线核验通过。未提供人工标注与真实embedding运行，未执行实际质量评测，不填占位指标；无真实服务/迁移/依赖/HTTP变化。按T8提交格式/脚本，阶段回归T9继续。

## 2026-11-27 S2.3-T7百炼适配器及显式运行入口（真实调用延后）

依据本轮官方同步embedding文档（来源/文件hash见research/bailian-embedding-2026-11-27.md），新增text-embedding-v4 HTTP适配器与显式64–2048支持维数、最多10条/保守8192 UTF-8字节每条、输入脱敏、模型/条数/index/维数/有限值校验、float/base64解码、2MiB响应上限、禁止重定向和适配器内重试。使用Node既有fetch/Zod，无新增依赖，不选择实际地域/Key；真实本地文件配置要求绝对路径、64KiB上限与币种一致，默认CLI拒绝loopback测试endpoint。

新增tasks:consume:index、index:reconcile显式入口（本地开发身份，production拒绝），接入真实处理器、隔离区与现有发布/对账；不匹配的embeddingVersion在领取/对账前保留待执行，不花attempt/恢复预算。API/默认synthetic消费不改为真实兜底。配置与CLI缺项只输出安全码。

typecheck/lint通过；基础103/103含HTTP桩/本地配置/CLI拒绝边界通过；131/131全量覆盖真实索引链路及未配置embedding版本拒绝，原生未运行未对照。真实Key/付费调用、百炼实际向量索引重建与质量指标按路线图延后，未注册正式合成embedding目标。文档/链接/diff核对后按T7提交，不能把桩测试当真实服务可用。

## 2026-11-27 S2.3-T6冻结候选实现与验证完成

T6增加CandidateSet/Candidate及不可变冻结触发器：同task唯一、成员版本/排序唯一、owner复合外键，live fence/租约/graph/cancel/deadline下同事务校验corpus/成员内容并冻结；重放内容相同复用setId，冲突拒绝。load验证内容hash与逐行快照，查询文本脱敏，空候选如实保存；新增显式城市条件在冻结时再次检查。真实分析输入绑定/图恢复消费在S2.4接入，本阶段只验证已有合成任务上的数据库执行权。

迁移generate/validate/deploy两次/status通过，14条已应用；typecheck、lint通过。基础最终103/103通过，12.853秒（data/s23-t6-t8-unit.log）；此前131/131完整集成已覆盖主要冻结实现，最终城市校验专项`node --env-file=infra/.env --test --test-concurrency=1 dist/test/integration/candidates.test.js`1/1通过，39.429秒（data/s23-t6-final-targeted.log）。无HTTP/依赖变更，无额外安装；文档与diff检查通过。按T6提交，阶段终检继续覆盖最终代码。

## 2026-11-27 S2.3-T5完成验证，T6/T7共用回归通过

`pnpm run test:integration`131/131通过、0失败/跳过，793.182秒（data/s23-t5-t7-integration.log），包含补建、候选冻结、索引重试/版本隔离、真实召回/清理及既有全部用例；Docker集合创建6047.8ms，Outbox DLX181.909秒。之前清理失败及HTTP桩超时完整保留，不归L1/L2。各用例本轮资源精确清理成功。

T5类型/Lint、基础最终100/100（包含后续草稿单元）、真实召回专项及上述全量通过，按任务提交向量/RRF、显式降级、有效版本复查和15秒清理对账修正。原生6333未监听，native对照未执行、不自行启停，仍待维护者统一对照。没有真实embedding/人工质量结果。T6城市冻结校验与T7配置/CLI拒绝补测、T8脚本是在本轮build后添加，须另行构建验证，不能宣称已由本全量覆盖。阶段保持进行中。

## 2026-11-27 S2.3-T5清理复核、T6候选冻结专项及T7桩验证

清理修正后db:generate/db:validate、typecheck、lint通过；`pnpm test`100/100通过，20.723秒（data/s23-t5-cleanup-unit.log），含清理失联/丢回复不延长原deadline测试，以及T7百炼HTTP桩（float/base64、维数/index、非法响应、429/503、重定向拒绝、响应上限、取消/超时/脱敏）。没有真实Key/付费调用，合成端口不作正式目标。

`node --env-file=infra/.env --test --test-concurrency=1 dist/test/integration/recall.test.js`清理复核1/1通过，43.790秒（data/s23-t5-cleanup-review.log），新清理hook完成精确资源移除，前次130项129通过的失败保留。T6迁移202611270007_s23_candidates在项目归属核验后deploy两次/status通过，14条up to date；候选专项1/1通过，5.763秒（data/s23-t6-targeted.log）。验证活fence下并发冻结唯一、空候选、内容冲突、跨owner、取消/旧fence、成员与集合不可变、SQL失败原子回滚及脱敏查询保存。真实分析图接线仍在S2.4，测试只使用真实DB上的合成AnalysisTask。

T7依据本轮[百炼官方文档](research/bailian-embedding-2026-11-27.md)实现text-embedding-v4、显式维数与工作空间HTTPS endpoint，配置只读本地文件，消费/对账CLI不提供合成兜底；embeddingVersion不匹配在领取/对账前defer而不消耗预算。T5/T6/T7按任务分开提交，开始共用当前编译产物执行完整`pnpm run test:integration`（data/s23-t5-t7-integration.log）；各任务最终状态须待结果，原生未启动仍未对照。

## 2026-11-27 S2.3-T5全量清理故障及最小修正

`pnpm run test:integration`130项129通过/1失败，665.885秒（data/s23-t5-integration.log）。唯一recall测试的after hook在Qdrant exists返回DEPENDENCY_UNAVAILABLE时退出，manifest=6fd329cb-a97a-4807-b53e-09bf40ae2ae4保持cleaned=false；不是L1/L2，不以之前专项通过覆盖。旧清理助手未捕获可恢复传输错误，没有利用原15秒窗口继续对账。

修正test/support/index-cleanup：每个精确spec仍15秒总窗口，所有请求共享原deadline，存在性/删除响应丢失仅对既有可重试TaskFailure继续对账；归属失败、元数据拒绝立即失败；到期保留清单并报未确认。新增故障测试检查read失败→delete已完成但reply失败→确认缺失、所有尝试相同deadline、归属拒绝和永久错误不重试。没有放宽生产/测试期限或把清理失败忽略。

编译前先用本轮data/s23-recall-cleanup-current.mjs读取上述唯一manifest，核对固定owner UUID、合成spec与确定性岗位版本ID范围，拒绝存在分析任务/正式Rubric/简历数据，再核验项目PostgreSQL/Qdrant归属、metadata及删除结果。只清理这两个owner下4个合成版本及任务/Outbox、指定集合；成功后该manifest标cleaned=true，未操作其他项目或原生Qdrant。

全量期间编写的T6候选冻结与T7百炼适配器/CLI草稿仍未验证。当前仅生成其类型供源码检查，T6迁移尚未部署；先复核T5清理修正再继续，后续结果单独追加。

## 2026-11-27 S2.3-T5真实召回与基础复核通过

`node --env-file=infra/.env --test --test-concurrency=1 dist/test/integration/recall.test.js`1/1通过，24.501秒（data/s23-t5-recall.log）；在真实PostgreSQL/Qdrant上发布/执行索引，多chunk聚合、冻结语料排除新岗位、owner payload过滤、稳定重放、city/limit、显式不可用/未READY降级与同分截断拒绝通过。本轮集合、任务、岗位/owner清理完成，测试embedding仅合成，不报告真实检索质量。

最终typecheck、零警告lint通过；`pnpm test`98/98通过，7.598秒（data/s23-t5-unit-final.log），此前HTTP桩超时不覆盖、不归L1/L2。开始完整`pnpm run test:integration`（data/s23-t5-integration.log）。原生未监听，未启停，原生对照未执行；其他后续任务暂未标完成。

## 2026-11-27 S2.3-T5向量召回/RRF检查进行中

T4已提交bc4a62a，继续T5草稿：exact Qdrant查询仅过滤冻结corpus/owner/private/索引版本，最高chunk分聚合岗位、默认50向量候选；RRF最多20并稳定并列排序。候选返回前两路都再次回查PG有效发布成员/hash/显式城市；显式降级原因且不返回伪向量rank。数据库/预算预留/取消/总deadline失败不能被降级吞掉。结果增加完整indexSpec，维数/版本可追溯；同分在chunk上限处被截断时明确失败/按配置降级，避免任意选择。无HTTP、依赖或迁移变化。

typecheck、lint通过；`pnpm test`98项97通过/1失败，26.886秒（data/s23-t5-unit.log）。新召回/RRF全部通过，唯一原index-vector HTTP故障测试TimeoutError，**非L1/L2**；未改原限制/断言。随后`node --test --test-concurrency=1 dist/test/index-vector.test.js dist/test/recall.test.js dist/test/rrf.test.js`7/7通过，6.465秒（data/s23-t5-unit-review.log），未复现，不覆盖原失败。开始真实SQL/Qdrant专项（data/s23-t5-recall.log），尚未记录结果。

## 2026-11-27 S2.3-T4补建与索引故障边界检查完成

数据库/索引专项`node --env-file=infra/.env --test --test-concurrency=1 dist/test/integration/index-backfill.test.js dist/test/integration/job-index.test.js`2/2通过，42.161秒（data/s23-t4-resume-targeted.log），含补建no-op并发/重放/回滚及实际upsert后故障持久重试、预算累计、alias维数切换。`pnpm run test:integration`129/129通过、0失败/跳过，605.790秒（data/s23-t4-resume-integration.log）。每项精确清理报告完成，正式Rubric未动。原生6333未监听，native全量按用户约定未执行，不自行启停；历史基础92/93中的L1与此前所有失败保留。迁移/类型/Lint已通过，文档/diff检查通过；无依赖或HTTP变化。

T4 no-op请求审查遗留已修正并按任务提交；真实百炼装配仍属于T7，不宣称真实向量质量。等待完整回归期间仅编写未构建的T5测试/实现草稿及读取T7官方文档，没有并行构建/测试。T5草稿单独保留，接着验证。阶段仍进行中，不提前合并/推送。

## 2026-11-27 S2.3-T4接续开发：补建幂等与索引恢复边界

用户继续开发授权后从干净feature/s2.3-job-recall、8931a30接续。按路线图T4补齐已记录的no-op请求缺少幂等绑定：新增JobIndexRequest独立不可变映射，已有同目标也持久绑定key/hash/task；重放返回首次任务不切回旧目标，发布与补建共用锁并拒绝跨操作复用key；新建任务/目标/Outbox/映射仍同事务。13号迁移202611270006_s23_index_request只新增表/约束，目标任务删除时级联映射；未记录的历史no-op无法追溯补写。

新增数据库专项覆盖并发no-op、旧请求重放不覆盖新目标、跨owner/FK、UPDATE拒绝、请求记录SQL失败回滚与重入。扩展原真实索引测试：实际upsert后注入响应丢失，按同任务RETRY_WAIT重放、累计模型预算、点数不增、维数不同的集合完成后alias切换并保留旧集合。未改原超时/断言，沿用已授权Qdrant10秒。

执行PostgreSQL归属核验通过；db:generate、db:validate、db:deploy两次、db:status均通过（13条）；typecheck、lint通过。`pnpm test`93项92通过/1项原API启动8秒L1，22.888秒（data/s23-t4-resume-unit.log），不覆盖此前L1。新数据库/索引专项运行中，结果后续追加。6333无原生监听，按既有授权记未执行，不自行启动。

## 2026-11-27 S2.3-T4授权修复收尾

最终当前源码typecheck、零警告lint通过，文档相对文件链接4份107项及git diff --check通过。只读data/s23-repair-resources.mjs先核验PostgreSQL/RabbitMQ/Qdrant及六观测服务归属/健康，再读取：Job/JobVersion/JobIndexTask/JobCorpusVersion/Resume/FileAsset=0，4正式队列ready/unacked=0，Qdrant集合为空，rubric-v1 hash仍6d958ebc4be30bab8cbe7a68b6ff96d0135cc88104bf901cacda7b3dc176648d。结果保存在忽略的data/s23-repair-resources.json。未删除旧孤立policy、正式Rubric或任何卷/本地配置。

修复效果：Qdrant单请求10秒在本轮真实5318.2ms创建及5.5秒HTTP桩上验证通过，任务总deadline/取消保持；完整128/128通过解除“最新Docker完整回归失败”这一当前阻塞。原生对照未执行、历史L1冷启动及T4功能审查余项仍保留，不代表S2.3阶段已完成或生产性能保证。阶段分支本地提交保存修复；未合并/推送、未操作master/前端或发送第三方消息。

## 2026-11-27 S2.3-T4 Qdrant授权修复完整回归通过

`pnpm run test:integration`128/128通过、0失败/跳过，604.423秒（data/s23-repair-integration.log）。Docker基础集合创建5318.2ms，实测超过旧5秒、在授权10秒内成功；新索引链路、Checkpoint/fence、Langfuse及所有原回归通过，Outbox死信窗口182.122秒。支持本次Qdrant预算调整，不能解释所有历史异常或宣称L1/L2永久解除。Worker/观测本轮仅增强安全诊断，旧UNKNOWN和传输丢失未复现，不称已定位根因。

之前基础93项92通过/1项L1冷启动失败、服务缺失专项7/7失败继续保留；服务就绪后专项11/11通过不覆盖这些历史。没有调整非Qdrant时限/断言，无依赖、迁移或HTTP契约变化，不重复安装/迁移/OpenAPI独立命令（基础原OpenAPI测试通过）。原生Qdrant6333未监听，本轮`test:integration:native-qdrant`未执行，不自行启动；原生对照是阶段余项，不能据本次Docker全量称S2.3整阶段完成。T4 no-op backfill run审查遗留、T5未验证草稿与T6–T9仍按此前记录待续。

最后typecheck/lint、资源归属/残留与文档检查在收尾执行，结果后续追加。只保存当前阶段修复提交，不合并未完成阶段，不操作master/前端。

## 2026-11-27 S2.3修复专项通过，完整回归启动

`infra:up`与`observability:up`成功，九服务全部healthy后重跑四文件专项：11/11通过、0失败/跳过，136.426秒（data/s23-repair-targeted-ready.log）。Checkpoint/fence全部子项、新索引真实队列/upsert/READY/回滚/旧目标隔离、Langfuse均通过；Docker基础集合创建2647.5ms。本轮新索引集合/alias/队列/DB及恢复线程清理报告完成。Worker UNKNOWN与观测丢失未复现，只能记录本轮通过，不能宣称历史根因被诊断增强修复。

已启动`pnpm run test:integration`（data/s23-repair-integration.log）完整门禁，结果待追加。只读检查6333无监听，原生Qdrant未启动，按用户管理约定不自行启停，原生全量对照待服务可用后执行。

## 2026-11-27 S2.3修复期间恢复测试服务

Docker Desktop官方启动后经历starting，随后running；engine版本29.9.3。只读Compose清单显示本项目九容器均exited。使用既有受控`pnpm run infra:up`（项目/服务检查）成功启动本项目PostgreSQL/RabbitMQ/Qdrant并等待healthy；随后执行`pnpm run observability:up`，脚本在启动前核对容器、网络及持久卷归属，启动本项目六观测服务。未删除卷/数据库、修改本地凭证或操作原生Qdrant。启动过程不证明此前间歇超时根因已修复，服务就绪后仍须原断言专项及完整回归。

## 2026-11-27 S2.3修复基础检查及服务缺失记录

`pnpm run typecheck`、`pnpm run lint`通过；`pnpm test`93项92通过/1失败，56.141秒（data/s23-repair-unit.log），唯一原API启动8秒L1；新增5.5秒Qdrant响应、取消/总deadline、安全cause及观测传输分类断言通过，未放宽非Qdrant限制。

四文件专项（checkpoint-fence/infrastructure/job-index/observability，data/s23-repair-targeted.log）7项0通过/7失败，13.261秒：Docker Desktop Linux engine pipe不存在，PostgreSQL/RabbitMQ连接拒绝、实例归属核验无法通过，未进入索引/图/观测业务验证。与此前运行中的间歇故障区分，不标修复失败或通过；无本轮集合/owner/队列创建。`docker version`确认engine不可用后，使用官方`docker desktop start --detach --timeout 30`成功发起启动，待项目实例/健康/归属核验后继续。未操作原生Qdrant。

## 2026-11-27 S2.3-T4按维护者新授权开始修复

维护者明确指示“Qdrant这个可以适当放宽超时限制。开始修复吧”。在干净feature/s2.3-job-recall、b6b5c71基础上继续；仅Qdrant请求上限从5秒调到10秒，依据已确认6.459/5.673秒服务端响应。SDK、新索引适配器及索引测试客户端共用常量；原总deadline/取消、15秒初始化与清理总期限、数据库/RabbitMQ/Langfuse时限及父测试断言不变。路线图新增授权例外，历史L2原5秒性能核对不自动解除。

同时补充Worker fixture的lock/claim/execute阶段耗时与白名单cause分类（不输出raw异常），Langfuse的最后传输失败阶段/原因/状态/耗时（不改变导出/失效行为）。目的是定位非Qdrant失败，不把诊断增强称为已修复。新增测试验证旧5秒以上响应可接受、总期限/取消仍有效、安全诊断不泄露异常内容；观测原故障用例增加分类断言。

本轮typecheck、lint通过；基础测试正在运行，专项及完整回归结果后续追加。没有开启并行构建/安装/测试、改变服务配置、启停原生进程或操作master/前端。

## 2026-11-27 S2.3-T4修复可行性只读复核

维护者询问是否可以修复后，核对feature/s2.3-job-recall基线c1ca520、工作区干净，读取现有规范/失败记录/相关实现，并在项目归属核验后只读提取历史服务日志。Qdrant服务端两次集合PUT最终200，但耗时6.459秒/5.673秒，确实超过原5秒客户端预算；当前Docker I/O等待明显。不能因此把Worker UNKNOWN或Langfuse transport失效全部认定为磁盘根因。C盘仅3.39GiB可用，不足直接容纳历史约22.1GiB的Docker VHD；未迁移/删除配置或启停服务。详见[修复可行性复核](research/s23-repair-assessment-2026-11-27.md)。

本轮只做可行性诊断与文档记录，没有已验证的代码修复；完整回归门禁仍未解除。Worker首次领取前的具体异常、Langfuse传输失败分类及持久化延迟仍待定向诊断，不把旧专项通过改写为修复成功。未修改源码/依赖/Schema/配置，未重复类型/Lint/业务测试；文档链接与diff检查后保存记录，不合并/推送阶段。

## 2026-11-27 S2.3停止交接与保存提交

T4审查实现保存为e6d8bbf，未完成；T5向量查询/RRF/显式降级草稿另作本次保存提交，只有typecheck/Lint通过，没有T5行为测试、真实召回验证或完成声明。当前分支feature/s2.3-job-recall；T1=bb600a4、T3=1c14fab、T2=bfc776f。没有合并develop、推送阶段分支或操作master/前端。依照下文已命中的停止条件1结束，不再继续工具调用；后续先解决/界定恢复与观测失败及新索引门禁，保留原验收标准再恢复S2.3-T4，连续目标S3.3尚未完成。

## 2026-11-27 S2.3收尾源码与资源核验

最终当前源码（含T5草稿）`pnpm run typecheck`、`pnpm run lint`均通过；T5没有行为测试，仍未验证，最后基础91/91与完整128项结果属于T4编译产物，不冒称覆盖T5。文档文件链接检查通过，git diff --check通过。T4无依赖/迁移/HTTP契约变化，冻结安装、迁移和OpenAPI独立命令未重复执行，基础测试内原OpenAPI一致性检查通过。

完整失败套件结束后再执行只读资源脚本，PostgreSQL/RabbitMQ/Docker及原生实例归属核验通过：Job/JobVersion/JobIndexTask/JobCorpusVersion/Resume/FileAsset=0，正式rubric-v1 hash仍6d958ebc4be30bab8cbe7a68b6ff96d0135cc88104bf901cacda7b3dc176648d；四正式队列ready/unacked=0，两个Qdrant集合列表为空、版本1.20.2。未操作旧孤立policy，无卷/配置删除。本次只读结果不解除任何失败门禁。

收尾将T4实现与T5草稿分开按审查提交保存；停止条件已满足，不再继续实现、运行全量或操作服务。后续接手须先复核本记录的失败、T4 no-op run幂等遗留及T5未测边界，不把审查提交当成任务完成。

## 2026-11-27 S2.3-T4最新完整回归未通过，按停止条件保留审查工作

`pnpm run test:integration`128项122通过/6失败、0跳过，693.785秒（data/s23-t4-integration.log）。失败逐项：

- 原无Checkpoint恢复子项在旧Worker首次claimed之前退出，phase=delivery/category=other/code=UNKNOWN、finished=interrupted，及父项；本轮**不是已证实的P1008**，不能从此前故障推断同根因。
- 原Docker Qdrant createCollection 5秒超时及父项，保持L2记录。
- 新索引测试首次集合PUT触发UPSTREAM_TIMEOUT，未执行后续断言；不扩大为L2。
- Langfuse accepted=6/exported=1/transport lost=5，原lost=0断言失败，不归L1/L2。

Outbox/DLX（182.063秒）、其余Checkpoint/消费者/对账、语料/关键词、岗位/文件和任务检查通过；新索引cleanup hook及其他测试均报告精确清理完成。此前原生24/24通过不覆盖本次失败。T4正式全量原生命令**未执行**：已有原生专项成功及首次失败记录，但最新全量出现非Qdrant的恢复/观测故障，当前不能通过切换向量实例证明完整门禁满足。没有提高超时、跳过断言、修改fsync/卷/数据库/本地配置或启动/停止原生Qdrant。

经过本轮默认全量/专项、原条件复核与资源只读检查，尚无可证实且不改变原验收约束的最小修复。依赖T4的T5/T6/T7及后续分析阶段不能继续；依照路线图§5“检查失败”与停止条件1，保留T4审查工作及T5草稿后停止，等待维护者处理或明确新的诊断范围。不是请求重复确认D1–D11，也不将真实Key延后作为阻塞原因。T1 bb600a4、T3 1c14fab、T2 bfc776f已提交；T4按审查提交保存但未完成，T5仅草稿，S2.3保持进行中，无阶段合并/推送，master及前端未操作。最终源码检查、资源核验和保存提交结果后续补记。

## 2026-11-27 S2.3-T4全量进行中的观测失败及审查遗留

本轮Langfuse记录accepted=6/exported=1/transport lost=5并断言失败（data/s23-t4-integration.log），不归L1/L2。新增Docker索引专项同样失败且hook完成精确清理；完整错误仍待套件汇总。继续暂停实现，不放宽限制、不调整服务配置、不反复覆盖失败。

审查尚待完成的边界（未宣称交付）：T4 backfill当前只在新建任务时绑定run派生幂等键；目标已相同的no-op返回不会单独持久保存该run键，因此历史no-op run后来重入不能依赖这段代码获得完整的旧run隔离保证，后续应补齐设计/测试或收窄文档描述。T4真实adapter消费CLI及常驻对账装配待T7。T5草稿尚无行为测试，候选回查/降级/召回配置与持久预算仍需完整审查；不能以能编译等同可用。当前本地依赖与已应用12条迁移保留，无环境重置。

## 2026-11-27 S2.3-T4全量再次出现恢复失败，暂停新增实现

data/s23-t4-integration.log全量运行期间再次出现既有无Checkpoint恢复子项及父项失败，具体错误待runner汇总。没有用此前24/24专项通过覆盖新失败。暂停新增实现并保留未验证T5草稿（RecallResult/RRF、向量查询、回查发布版本、显式关键词降级服务），T5尚无测试或完成声明。T5对job-index.vector/index.repository/recall契约的新增方法写于T4 build结束后，不属于本轮编译产物；后续检查须重新build。此前T4源码与测试未因新失败放宽限制。

## 2026-11-27 S2.3-T4原生专项复核通过，开始全量门禁

上述原生四文件专项24/24通过、0失败/跳过，200.776秒（data/s23-t4-review-native.log）；新索引用例64.662秒，实际覆盖真实RabbitMQ重复投递仅一次attempt、Qdrant点数不增、READY原子提交/SQL回滚、目标变化时旧有效fence拒绝提交、显式对账恢复与失效fence拒绝；既有Checkpoint、消费者、发布回归均通过。清理报告本轮索引metadata/collection/alias、队列和DB全部完成。此前两次创建超时未复现，不宣称环境已修复，不改原测试期限。开始`pnpm run test:integration`全量Docker门禁（data/s23-t4-integration.log），原生全量随后串行执行，结果后续追加。

## 2026-11-27 S2.3-T4 Docker/原生索引专项失败与只读核验

第二次Docker索引专项0/1，36.286秒（data/s23-t4-index-docker-2.log）：新适配器首次PUT集合请求UPSTREAM_TIMEOUT（单次5秒），未到重复投递/READY断言。原生对照`node --env-file=infra/.env --env-file=infra/.env.qdrant-native --test --test-concurrency=1 dist/test/integration/job-index.test.js`同处失败0/1，50.769秒（data/s23-t4-index-native.log）。两个target均由原归属核验通过，清理hook核对metadata后删除本轮精确集合/alias/队列/owner/任务，data/s23-index-runs清单均cleaned=true；没有启动/停止原生进程。**新索引专项失败不直接归L2**，未改测试断言、原5秒请求/总期限或基础设施配置。

最终`pnpm run typecheck`、`pnpm run lint`通过；`pnpm test`91/91通过，12.185秒（data/s23-t4-unit-final.log），包括新增HTTP桩的429/503分类、无内部重试、期限、元数据/实例归属拒绝。T4仍未完成。

只读脚本data/s23-t4-resource-check.mjs先核验PostgreSQL/RabbitMQ/Docker Qdrant归属及原生路径/进程，随后读取（结果data/s23-t4-resource-check.json）：Job/JobVersion/JobIndexTask/JobCorpusVersion/Resume/FileAsset全0；正式rubric-v1哈希仍6d958ebc4be30bab8cbe7a68b6ff96d0135cc88104bf901cacda7b3dc176648d；4正式队列ready/unacked均0；Docker与原生均1.20.2、集合0。只读GET返回正常不能证明集合创建符合5秒限制，也不能证明具体磁盘根因。

再做一次有界原生专项复核并覆盖被T4改动的既有恢复/消费者/发布链路：`node --env-file=infra/.env --env-file=infra/.env.checkpoint --env-file=infra/.env.observability --env-file=infra/.env.qdrant-native --test --test-concurrency=1 dist/test/integration/checkpoint-fence.test.js dist/test/integration/consumer.test.js dist/test/integration/job-publication.test.js dist/test/integration/job-index.test.js`（data/s23-t4-review-native.log），结果待追加。未执行T4全量Docker/native命令，先解决专项门禁；无依赖/迁移/HTTP Schema变化，不重复安装或迁移。T5以后尚未实现。

## 2026-11-27 S2.3-T4实现与首次验证

T2已提交bfc776f。T4新增版本化集合/元数据、UTF-16安全分块与确定性point ID、真实JobIndexHandler、显式能力选择、原子READY+产物+终态+收据、缺目标补建/别名切换命令；消费者默认仍为synthetic，实际真实适配器装配待T7。Qdrant请求单次5秒与调用方总deadline/取消合并，无适配器内重试，失败交持久任务重试；保留默认SDK兼容检查，不修改原VectorService。新适配器使用1.20 REST Schema并检查服务端版本，原因是安装SDK的有限timeout middleware会替换调用方signal，无法传播任务取消。没有新增依赖。

首次typecheck、lint通过；`pnpm test`90/90通过，25.205秒（data/s23-t4-unit.log）。随后增加runtime显式reconcile包装及HTTP故障测试，须在最终检查再次覆盖。`pnpm run build`后Docker索引专项首次失败（data/s23-t4-index-docker.log），新测试namespace不符合既有`^s12\\.t[3456]\\.[a-f0-9]{32}$`约束，在建队列/owner/collection前退出；仅改新测试为既有允许的s12.t4.UUID命名，未放宽拓扑校验。第二次build+专项进行中，结果后续追加。未把本任务或真实索引可用性标完成。

## 2026-11-27 S2.3-T2完整复核通过，T1/T2/T3本地实现保留

第二次`pnpm run test:integration`127/127通过、0失败/跳过，610.052秒（data/s23-t2-integration-review.log）。Checkpoint/fence、Langfuse、本轮关键词与语料、Outbox和所有原回归通过；Docker Qdrant集合创建4126.5ms。此前122/127中P1008、Langfuse及L2失败完整保留，未改原测试超时/断言或恢复/观测实现，不宣称基础设施根因修复或解除L1/L2。T2基础83/83、专项1/1及后续含T3基础88/88通过，文档链接/结构与diff检查通过；无HTTP/依赖/迁移变更，无需相应生成/安装。

T3已独立提交1c14fab（仅依赖已完成T1 bb600a4），T2现按任务提交；阶段保持进行中，未合并/推送。T4前置架构§4.2/§7与消费者、预算、对账、Qdrant1.20.0 SDK契约已阅读，已编写分块/集合契约与有界Qdrant适配器草稿，**未构建、未验证、未接入真实处理器**，不纳入T2提交。原生Qdrant未启停，正式语料/真实embedding仍未导入或调用。

## 2026-11-27 S2.3-T3独立端口检查通过，T2完整复核进行中

T2非L1/L2专项原命令6/6通过，45.384秒（data/s23-t2-failure-review.log）：Checkpoint/fence全部子项与Langfuse通过。没有修改基础设施/恢复/观测源码、测试超时或断言；本次未复现，不宣称根因修复，也不覆盖此前127项中的5项失败。已启动第二次完整`pnpm run test:integration`（data/s23-t2-integration-review.log），T2仍待该回归结果。

按路线图T3仅依赖T1，独立实现EmbeddingPort/EmbeddingExecutor及仅测试注册的确定性合成向量。单次/全部尝试总期限（含reserve及退避）、最大尝试、分类指数退避+jitter、token/费用预算、并发槽、联系方式遮盖和维数/条数/有限数值验证；未报告/失败调用usage为null。未settle的调用保留并发槽，禁止超时后与旧调用重叠。详见[embedding边界](embedding.md)。

`pnpm run typecheck`、`pnpm run lint`通过；`pnpm test`88/88通过，12.478秒（data/s23-t3-unit.log），含T3五项脱敏/可复现合成、重试预算、非法维数/usage、期限与挂起reserve、取消与未settle故障测试。T3无外部服务、迁移、HTTP或依赖变化；不把真实百炼调用/索引/人工质量验证标完成。T3按独立任务提交；T2工作与失败记录保留，阶段不合并/推送，T4尚未实现。

## 2026-11-27 S2.3-T2完整回归失败结果与专项复核启动

`pnpm run test:integration`127项122通过/5失败、0跳过，634.543秒（data/s23-t2-integration.log）。失败：S1.4-T7无Checkpoint恢复子项在**旧Worker首次claimed之前**退出，安全诊断为phase=delivery/category=database/code=P1008，以及父项；Langfuse TimeoutError；Docker Qdrant原createCollection超时及父项（L2）。此前对进程退出/锁释放边界的检查只是假设，最终异常未支持该假设，因此没有修改任何恢复代码或测试等待/断言。P1008与Langfuse不归入L1/L2。

语料与关键词新用例、其他消费者/Checkpoint、Outbox/DLX（182.120秒）、对账、文件与任务检查通过，套件结束且本轮各测试报告精确清理完成。没有把本轮失败用T1的126/126通过覆盖。开始按原编译产物、原超时/断言串行复核：`node --env-file=infra/.env --env-file=infra/.env.checkpoint --env-file=infra/.env.observability --test --test-concurrency=1 dist/test/integration/checkpoint-fence.test.js dist/test/integration/observability.test.js`，结果待追加。基础设施/恢复/观测源码和原测试均无修改。

## 2026-11-27 S2.3-T2关键词实现与回归中的非L1/L2失败

T1已提交bb600a4。T2新增RecallQuery与keyword-overlap-v1参数契约，以及PostgreSQL快照技能数组精确求交；回查owner/发布状态/内容hash，按技能交集数降序、jobId/versionId稳定排序，默认50上限，只有显式city才过滤。无HTTP接口、迁移或依赖变更。

已执行typecheck、lint通过，`pnpm test`83/83通过，11.428秒（data/s23-t2-unit.log）；`node --env-file=infra/.env --test --test-concurrency=1 dist/test/integration/keyword-recall.test.js`1/1通过，21.017秒（data/s23-t2-keyword.log）。专项覆盖上限、并列、别名去重、城市/空技能、owner、旧快照/新版本和已删除版本剔除；只清理本轮独立owner记录。

随后`pnpm run test:integration`运行中（data/s23-t2-integration.log），S1.4-T7的confirmed process exit / restart without checkpoint用例出现失败（2147.855ms）及父项失败，**不归L1/L2**。具体异常待runner结束输出后分析；旧执行挂起换thread与带Checkpoint恢复等子项通过，清理报告本轮记录/线程已移除。暂停后续实现，保留T2与尚未验证的T3 embedding端口/故障测试草稿；没有并行构建/安装/测试，没有更改既有测试断言/超时。

## 2026-11-27 S2.3-T1检查完成，按任务提交

`pnpm run test:integration`完整126/126通过、0失败/跳过，587.864秒（data/s23-t1-integration.log），包含新语料用例和既有Checkpoint/fence、RabbitMQ、Langfuse、Outbox/DLX（原窗口180.812秒）、任务、岗位与文件回归。Docker Qdrant创建3865.7ms；既有L1/L2未因此解除。此前基础81/82的L1失败、首次Lint失败仍保留，不以完整集成通过覆盖。

T1已执行db:generate、db:validate、db:deploy两次、db:status、typecheck、lint、pnpm test、数据库专项与完整集成；文档链接/diff检查通过。未改依赖，不重装；无HTTP变更，不新增OpenAPI产物。原生对照本任务未执行（本任务新增行为只涉及PostgreSQL，T4/阶段回归再按路线图对照）；正式目标/真实embedding与质量验证仍延后。只提交T1的15个文件；T2查询与测试草稿未构建、未运行、单独保留供下一任务验证。阶段仍进行中，未合并/推送。

## 2026-11-27 S2.3-T1数据库专项通过，完整回归进行中

`node --env-file=infra/.env --test --test-concurrency=1 dist/test/integration/job-corpus.test.js`1/1通过，35.659秒（data/s23-t1-corpus.log）。独立owner下100条合成JD经确认/发布入库；重入复用任务/Outbox；跨owner与草稿拒绝；快照冲突/不可变及字典升级保持旧结果通过。结束时重新核验归属并精确清理本轮owner、语料、岗位、索引目标/任务与Outbox，data/s23-corpus-runs对应manifest标cleaned=true；正式rubric未动。

`pnpm run test:integration`串行回归进行中，期间只编写未构建的T2关键词查询/测试草稿，不并行安装、构建或运行其他测试。Docker Qdrant本轮createCollection=3865.7ms且CRUD通过；这不是解除L2的连续目标环境回归。只读核验发现6333由D:\qdrant-x86_64-pc-windows-msvc\qdrant.exe监听；未启停原生进程，T1未调用向量库新能力，原生对照留在涉及Qdrant的T4及阶段回归执行。

## 2026-11-27 S2.3-T1基础测试记录

`pnpm run lint`修正类型导入后通过；`pnpm test`82项81通过/1失败、0跳过，49.789秒（data/s23-t1-unit.log）。唯一失败是原process.test的API启动8秒用例（Child api did not start），按已有L1记录，不称全绿；本轮新增两项字典/100条JD确定性与引用验证均通过。未改原超时/断言。文档本地文件链接4份54项及git diff --check通过。随后执行`node --env-file=infra/.env --test --test-concurrency=1 dist/test/integration/job-corpus.test.js`，结果待追加。

## 2026-11-27 S2.3-T1语料与字典实现，验证进行中

执行交接后核对工作区干净，feature/s2.3-job-recall起点4f08917，与交接一致。已阅读AGENTS、CONTRIBUTING、路线图§5/§6、需求、架构§7、接口及既有岗位发布实现。新增100条合成中文JD生成/重入导入、skills-zh-v1精确技能归一化与JobCorpusVersion不可变私有快照；发布仍走S2.2确认/发布服务，保留真实任务/Outbox。语料快照保存字典、发布清单哈希与原归一化技能，升级字典不修改旧结果。说明见[job-recall](job-recall.md)。

已执行：PostgreSQL项目/服务/卷归属核验通过；db:generate、db:validate、typecheck通过；db:deploy首次应用202611270005_s23_job_corpus、第二次无pending，db:status共12条且up to date。首次lint失败4处consistent-type-imports，已修为import type后零警告通过。基础测试正在运行，数据库专项/完整集成尚未执行，结果后续追加，不提前称通过。

边界：未改依赖声明/锁文件，无新增HTTP接口；正式语料尚未导入，因为正式embedding/index目标仍待后续任务，本轮测试只使用独立临时owner的fixture目标，不注册为正式目标。真实embedding、质量标注与目标服务器验证按路线图延后。原生Qdrant未启停，master及前端未操作，未发送第三方消息。

## 2026-11-27 S2.2已合并推送，S2.3开始

S2.2-T10提交8fe857f已用--no-ff合并develop，合并c50faf91fd662562ce1d4f7fc589911e1a84ee86；origin/develop同值，origin/feature/s2.2-jd-rubric=8fe857f65ed14b5a8eba0b9a28630c53da5cd46b，推送成功。S2.2待统一验收，L1/L2和真实中转/人工审核延后仍保留；master未切换/修改/推送。合并后工作区干净，从develop创建feature/s2.3-job-recall；已合并本地S2.2分支按-d清理，远端保留。

S2.3已复核路线图T1–T9、架构§7及D3，开始阶段准备，尚无召回代码。沿用用户连续开发到S3.3及每阶段可自主开新会话授权，准备在新会话继续；本会话随后停止修改工作区，避免并发改动。

交接：Node24.22.3/pnpm12.23.0，11条迁移；正式rubric-v1在开发owner下且PENDING_REVIEW，禁止清除。最终DB仅开发owner/正式Rubric，岗位/文件/索引任务0；4正式队列空，Qdrant集合0。原生Qdrant由用户手动管理，缺失按未执行记，不能启停。慢盘停顿诊断与逐次失败在此前progress；最近完整123/125仅Qdrant L2，基础79/80仅API L1，类型/Lint/OpenAPI通过。

S2.2模型适配器、本地HTTP桩及岗位全链路已实现；真实Key/中转调用、百炼真实embedding、人工标注及目标服务器均延后。S2.3发布语料需使用S2.2发布服务，不能把fixture-only目标作为正式索引；后续按任务契约实现，遇路线图明确停止条件才停。阶段启动仅文档变更，链接/结构/diff检查，不重复无变化的业务测试。

## 2026-11-27 S2.2-T10阶段交接完成，待统一验收

已完成S2.2全部非延后实现及阶段交接：草稿/要求/确认/不可变发布→真实JobIndexTask+Outbox待执行，Rubric六维完整加载，受限模型端口/JD建议、兼容模型HTTP桩、岗位HTTP和同源OpenAPI。T10保留前会话README/architecture/testing修改，修正API/契约/需求/JD文档的过时状态；新增观测测试安全阶段诊断，原5秒HTTP与所有验收断言不变。状态改为待验收，按授权合并develop并推送阶段分支/develop；master不操作。

本轮检查：

- `pnpm run typecheck`、`pnpm run lint`最终通过，零警告；首次诊断Lint失败与修正见前条。
- `pnpm test`80项79通过/1失败，32.619秒；唯一原API 8秒冷启动失败按L1记录，不称全绿。前会话T9基础80/80及本轮其他测试通过不覆盖此失败。
- `pnpm run openapi:check`通过；依赖声明/锁文件本轮未改，T8/T9冻结安装已有记录，本轮不重复安装。
- `pnpm run test:integration`125项123通过/2失败、0跳过，553.291秒（data/s22-t10-integration.log）；唯一Docker Qdrant原5秒create超时及父项按L2接受。此前非L1/L2失败已完整保留，本轮Checkpoint/fence、消费者、Langfuse、Outbox（DLX182.858秒）及岗位/文件/任务专项全部通过。
- 文档本地文件链接8份91项及git diff --check通过。
- 回归后核验PostgreSQL/RabbitMQ/Qdrant实例归属：正式4队列ready/unacked=0、Qdrant集合0，Job/Resume/FileAsset/JobIndexTask=0；仅开发owner及正式rubric-v1保留，hash=6d958ebc4be30bab8cbe7a68b6ff96d0135cc88104bf901cacda7b3dc176648d、PENDING_REVIEW（data/s22-t10-resources.json）。未删历史孤立policy或正式Rubric。

延后/限制：真实中转Key/模型结构化能力验证、百炼真实embedding与索引、人工审核/标注及目标服务器回归未执行，按路线图延后；S2.3前真实任务不标READY。原生Qdrant未操作。L1/L2未解除，间歇基础设施停顿不是已永久修复。S2.3及后续仍未完成。

远端检查首次fetch包含尚不存在的feature/s2.2-jd-rubric而失败；改为fetch origin develop成功，local/remote develop均b66131e，阶段远端分支本次首次创建。后续提交/合并/推送结果另记。

## 2026-11-27 S2.2-T10基础检查及L1记录

首次Lint因新增观测诊断包装Error未保留cause被preserve-caught-error拒绝；已改为记录安全stage/耗时后原样rethrow，未关闭规则。最终typecheck、零警告lint通过；`pnpm test`80项79通过/1失败，32.619秒（data/s22-t10-unit.log），唯一API启动8秒用例失败，按既有L1单独记录。代码未改业务处理器、SDK、预算或配置。随后单独执行openapi:check与完整test:integration，不让已接受L1误阻断其余检查，结果待追加。

## 2026-11-27 S2.2-T10失败专项复核与安全诊断

执行 `node --env-file=infra/.env --env-file=infra/.env.checkpoint --env-file=infra/.env.observability --test --test-concurrency=1 dist/test/integration/checkpoint-fence.test.js dist/test/integration/consumer.test.js dist/test/integration/observability.test.js`：18项17通过/1失败，121.286秒（data/s22-t10-handoff-targeted.log）。Checkpoint及消费者全部通过，Langfuse再次TimeoutError，不归L1/L2。

只读探针核验观测容器/网络/卷归属通过（3.404秒），原5秒项目API读取200（72.8ms），无法由裸TimeoutError确定读项目/观测/清理哪个HTTP阶段超时。因此仅在observability集成测试增加安全stage/elapsedMs/timeout诊断，不输出URL、Key、正文或原始异常，不改请求次数/5000ms/断言。`pnpm run build`后原observability专项1/1通过（11.920秒），本次未复现，不能宣称已证明根因或修复基础设施。

已启动串行typecheck/lint/pnpm test/openapi:check及完整test:integration阶段门禁，避免安装/编译/多轮测试并行负载。T10文档8份91个本地文件链接有效、git diff --check通过。前会话既有三份文档修改完整保留；正式Rubric仍待审核，真实中转及百炼验证未执行。

## 2026-11-27 S2.2-T10续接与前轮完整回归结果

维护者要求本会话继续，已核对前会话idle、当前feature/s2.2-jd-rubric/da71b6a；保留README/architecture/testing三份未提交T10文档。T6–T9已由前会话提交，正式rubric-v1已入库，真实中转/embedding验证仍延后。没有重做已完成任务或把旧T4阻塞直接当作当前停止结论。

接收前会话仍运行的 `pnpm run test:integration`，未并发启动新测试/编译。最终125项115通过/10失败，821.997秒（data/s22-stage-integration.log）：Checkpoint暂停PowerShell子进程超时及父项；消费者4项（重复消费者/心跳/旧代ACK/提交后强杀IPC）及父项；Qdrant原5秒create超时及父项；Langfuse读取超时。Qdrant按既有L2，其余不归L1/L2。岗位HTTP/草稿/发布/持久化和Rubric通过；既有Outbox/重试及其他组结果保留原日志。

T10已对照实现修正文档过时的“岗位/上传路由未实现”等描述，阶段仍进行中。当前按原命令参数与原断言串行复核失败的checkpoint-fence/consumer/observability专项；未改配置、超时、租约、服务或任何测试断言。待结果后决定是否能够执行阶段完整回归与合并。

## 2026-11-27 S2.2-T9岗位HTTP实现与专项验证，阶段回归中

新增POST/GET jobs、版本详情/PATCH编辑、confirm/publish/suggestions路由，可信owner检查jobId/versionId一致，版本响应不返回owner/内部执行字段。发布202返回jobVersionId/taskId，草稿编辑发布版派生新版本；列表稳定cursor。字段错误details仅path/code，无原始值；伪造引用400、越权404、未确认409、缺模型/索引目标503，不注册假模型兜底。JOB_API_ENABLED仅本地开发，配置文件绝对路径、严格Schema、Key/URL不入库。

检查：首次typecheck因optional配置的exactOptionalPropertyTypes失败，修正为允许显式undefined；首次lint未使用投影变量失败，修正后通过。最终typecheck、零警告lint、OpenAPI generate/check通过；真实HTTP/PostgreSQL专项6/6通过（5.035秒），覆盖草稿→要求→确认→发布→PENDING任务、幂等、分页、跨owner、字段安全错误、建议不变更数据库与真实API装配。后补建议通过实际HTTP路由测试，最终基础80/80通过（10.675秒）；新增模型依赖冻结安装通过，7份文档65个本地链接有效。

阶段pnpm run test:integration已启动（data/s22-stage-integration.log）。当前既有Checkpoint/fence与消费者多个用例失败，未归L1/L2，待完整异常及清理结果；T9保存实现但不宣称阶段回归通过。真实中转API Key/实际模型支持、人工标注及目标机器验证仍延后；S2.3真实索引未开始，发布任务保持待执行。T10及阶段合并/推送尚未完成。

## 2026-11-27 S2.2-T8兼容模型适配器本地验证完成（真实中转延后）

ChatOpenAI1.8.5的ModelPort实现从本地受控配置读取baseURL/Key/model/modelConfigVersion，不入库；显式JSON Schema、禁用LangChain和OpenAI两层自动重试、请求signal/timeout与响应字节上限、禁止重定向。发送前遮盖常见联系方式且保留证据UUID/UTF-16位置；未知usage/cost为null，SDK/HTTP原始异常不出日志。环境开启LangSmith/verbose/OpenAI调试时失败关闭，观测使用项目白名单span。

官方registry与发布包文档核对Node>=22/core^1.5.0/MIT，现有组合兼容；新增SDK7.64.0解析在锁文件，原直接core/graph/Zod版本不变。首次导入typecheck发现上游可选zdrEnabled/modelKwargs声明不兼容，新增仅d.ts/d.cts补丁允许undefined，未改运行JS、skipLibCheck或peer策略；patch-commit与冻结安装通过。T7期间的安装/编译交叉失败已独立记录。

本地真实HTTP桩专项1/1通过（1.745秒），覆盖请求JSON Schema/模型名、脱敏、429/503/400、非法JSON/结构化不符、响应超限、超时/取消、缺usage；断言每次失败只有一次网络请求。最终typecheck、零警告lint、pnpm test80/80（10.675秒）、OpenAPI check通过，65个本地文档链接有效。真实Key/中转站能力验证未执行，按延后表留统一验收，不宣称真实模型可用。依赖与风险见dependency-compatibility。

## 2026-11-27 S2.2-T7模型端口与JD建议完成，T8适配器准备

T7共享LangChain消息/Schema的ModelPort与有界ModelExecutor，分类重试+jitter、单次及总期限、调用/token/费用预留、并发和一次修复共用预算；未结束调用保留并发槽防止重叠重试，持久预算接口待S2.4接任务fence。JD只读取授权草稿，等长遮盖联系方式，按原文和发送文本双重校验引用；不写回草稿、确认或要求。观测使用既有白名单extract span；未知usage/cost保持null，不填0。

typecheck通过；首次lint因类型导入失败，修复后零警告通过；模型/JD合成故障专项8/8通过，覆盖重试/一次修复、预算、挂起预留、总期限、取消、UNSETTLED槽、伪造/跨版本引用、联系方式及草稿不变。完整pnpm test78/78通过，10.874秒。准备T8安装与一次构建交叉，构建读到暂态未补丁声明失败；安装后核对原core补丁在位并串行重跑通过，未改严格设置或patch。后续依赖变动与T8新增声明问题另记。

未执行真实模型/人工标注，T7测试假模型仅在测试注入，无生产默认假实现。尚未注册JD抽取HTTP（T9）。T8已核对并安装@langchain/openai1.8.5，Node>=22/core^1.5.0/MIT与当前环境兼容，冻结安装通过；官方包文档/声明明确ChatOpenAI、baseURL与json_schema。实际导入时发现上游exactOptionalPropertyTypes声明冲突（zdrEnabled/modelKwargs），正以最小仅类型补丁处理，未关闭skipLibCheck或忽略peer。T8真实中转调用继续延后。

## 2026-11-27 S2.2-T6正式Rubric导入与读取完成

专项排查完整回归119/119通过后恢复本阶段。执行rubric:import开发owner的resources/rubrics/rubric-v1.json首次replay=false、第二次replay=true，随后rubric:load成功；6维30等级、reviewStatus=PENDING_REVIEW，内容哈希6d958ebc4be30bab8cbe7a68b6ff96d0135cc88104bf901cacda7b3dc176648d。真实数据库逐维加载核对L1–L5及20/40/60/80/100，并与受控JSON完整比较一致。该正式版本保留在开发owner下，不作为临时测试记录删除。

本项typecheck、零警告lint通过，pnpm test70/70、0跳过（10.437秒）；正式CLI重复导入/加载和逐维读回专项通过。此前T6仅保存草案的未执行项自此补齐；仍为AI起草、待统一验收审核，不宣称批准或模型质量达标。未调用真实模型/embedding，未做人工审核/标注，依照延后规则保留。无依赖/迁移改动；阶段继续进行中，下一项T7。

## 2026-11-27 S2.2-T4基础设施专项结论与完整复验通过

专项报告完成，见[故障诊断](research/infrastructure-diagnosis-2026-11-27.md)。未修改业务代码、服务配置、原超时/验收断言；证据确认共享持久化路径出现过严重同步停顿，但无法由历史日志确定最后一次DLX从路由发现到目标持久化/客户端接收的具体延迟位置，不声称修复了已证明的消息丢失。

实际检查：原Outbox专项10/10通过（255.624秒，DLX181.686秒）；原完整pnpm run test:integration119/119通过、0失败/跳过（595.408秒，DLX183.303秒，Docker Qdrant创建4265.6ms）；typecheck、零警告lint通过；pnpm test70/70通过、0跳过（22.493秒）。两份文档17个本地文件链接与git diff --check通过。

复验后核验Rabbit/Postgres/Qdrant实例归属：仅4条正式队列、ready/unacked均0；Qdrant集合0；数据库只保留原开发owner，Job/Rubric/Resume/FileAsset/DiagnosticRecord均0；两个独立诊断manifest.cleaned=true。已知旧孤立policy继续保留，其精确UUID模式不匹配正式及本轮队列，不盲删。未操作其他项目或原生Qdrant，未迁移数据、删除卷/数据库/配置，未清理C盘或关闭其他程序。

当前最近完整回归已通过，允许恢复原S2.2任务流程；这是本轮回归门禁解除，不是长期环境稳定或L1/L2解除。阶段仍进行中、未合并推送，T6正式Rubric导入及T7–T10、S2.3–S3.3仍未完成。优先改善存储：E/D/F同机械盘，C仅约3.3GiB空闲，现有Docker VHD约22.1GiB，需先提供容量足够的SSD/NVMe/目标机器再制定备份与受控迁移；不以增大190秒窗口换取通过。首次管理观察超时、raw源码下载连接重置等诊断失败保留在前条/报告，不隐藏。

## 2026-11-27 S2.2-T4基础设施故障专项排查（维护者明确授权）

维护者在原会话授权专项排查；续接会话已completed/idle，当前feature/s2.2-jd-rubric、HEAD4fd039c、初始工作区干净。不改变D决策/验收窗口、不修改master或前端。报告见[基础设施诊断](research/infrastructure-diagnosis-2026-11-27.md)。

关键证据：故障时PostgreSQL checkpoint同步耗时121.783秒、单文件60.436秒，同期RabbitMQ CLI net tick遗漏及10秒心跳丢失；Docker I/O full avg60约26%–27%。项目/依赖/约22.1GiB Docker VHD在E盘机械盘，D/E/F同物理盘；C为NVMe但只剩约3.3GiB，未迁移或清理。当前无Rabbit告警、九服务healthy，但不据此否定历史停顿。具体磁盘/VHD/分页/其他负载占比未分离。

读取broker配置180000ms，核对官方v4.4.0源码blob b79a3154fdca46423055c445aacbcb7cc6edf71e；历史失败队列也在180.001秒后发现路由，日志不证明已持久化/客户端收到。独立合成诊断恢复绑定后180.036秒收到同messageId及rejected x-death；321次get最长RPC2.176秒、Node最大事件循环延迟569ms。首轮可选管理HTTP观察超时，实验未进入且已清理；第二轮观察错误单独记录，业务窗口未变，CLI快照补充源队列pending证据。

原Outbox专项node --env-file=infra/.env --env-file=infra/.env.checkpoint --env-file=infra/.env.observability --test --test-concurrency=1 dist/test/integration/outbox.test.js：10/10通过、0跳过，255.624秒，DLX子项181.686秒。末次精确资源核对：4条正式队列均空，两个诊断manifest.cleaned=true；Job/Resume/DiagnosticRecord均0、owner仅开发主体；已知孤立policy仍保留，不凭前缀删除。所有诊断文件保存在忽略data/infra-diagnosis-20261127。没有启停原生Qdrant/服务、改WAL/fsync/超时、删卷/库/凭证或声称问题已稳定修复。

原完整pnpm run test:integration已启动用于确认回归门禁，结果待追加；本轮只改诊断文档，未新增依赖/迁移/业务代码，不额外编写镜像实现的测试。raw GitHub读取两次连接重置后通过官方contents API取得固定版本源码，失败保留。尚未解除阶段阻塞或标记T4完成。

## 2026-11-27 S2.2-T6仅保存AI草案，未导入

T6按需求六维起草30个等级，带行为标准/证据门槛/全版本唯一featureId及20/40/60/80/100分值，元数据AI_DRAFT/PENDING_REVIEW。用已编译rubricVersionSchema只读校验JSON通过（6维、30等级），文档相对链接检查通过。未执行正式导入及加载专项，任务未完成；原因是T4可靠性依赖已触发停止条件。T5实现保存159abd2，当前阶段仍进行中，不合并推送。

检查与范围收口：从src移出的未完成T7草稿保留于忽略data目录；当前受控源代码最终typecheck/lint通过，基础和完整回归以此前逐次记录为准，保存文档/JSON不再重跑服务测试。无真实模型/embedding、人工审核或部署验证。待维护者处理上述阻塞后从T6未执行项续接。

## 2026-11-27 S2.2-T5实现保存（整体可靠性阻塞未解除）

T5导入/加载与CLI、合成Rubric测试保存为独立提交。typecheck/lint最终通过；基础70/70、Rubric专项1/1及最终完整回归中该专项通过，命令/耗时与完整失败见前条。CLI正式文件导入未执行；测试只显式允许SYNTHETIC且精确清理，没有注册默认版本。package.json仅新增两条命令，依赖声明/锁文件未变，不需要重新解析依赖；无新迁移。

T4已保存47c6f52，完整回归非L1/L2阻塞仍存在，不合并/推送。停止后只保存已准备工作和证据，不继续后续业务开发。

## 2026-11-27 S2.2在T4可靠性回归处停止，保留实现与未验收草案

最终联合完整回归 `pnpm run test:integration`119项115通过/4失败/0取消，553.540秒（data/s22-t45-integration-requeue.log）。失败为Docker Qdrant createCollection原5秒超时及父项（L2），另有既有Outbox quorum DLX用例恢复binding后在原190000ms receive窗口内未收到消息及父项（非L1/L2，子项211.463秒）。最后基础 `pnpm test`70/70通过，10.075秒。T4发布专项与T5 Rubric专项在该完整回归中均通过；不据此把阶段标为待验收。

**停止依据**：路线图§5“必须停止并等待维护者”第1条。Outbox可靠交付是岗位发布及后续索引/分析的依赖；本轮已出现多次跨数据库/队列/观测的非L1/L2失败，最后仍有broker死信窗口未满足。尚无证据支持一个不改变已验证行为/验收条件的代码修复；不能增加190秒窗口、降低断言或扩大L2来继续。需要维护者协助确认并恢复本机Docker/RabbitMQ运行条件，或确认单独的故障诊断/修复范围后复验；不要求重新确认D1–D11。

保留范围：

- T1 f853374、T2 2089631、T3 35d0ed7已按任务提交，并各有基础/专项/完整回归记录。
- T4发布事务、目标关系、真实RabbitMQ验证及最小测试同步/脱敏诊断保留为未验收提交；11条迁移已应用，不回滚或删除数据。
- T5 Rubric导入/精确加载实现、CLI、合成专项已验证，但整阶段受上述依赖失败阻塞，保留实现，不注册测试Rubric为默认。
- T6的resources/rubrics/rubric-v1.json与审核说明仅为AI起草/PENDING_REVIEW文件，尚未执行正式导入/加载专项，不标完成。
- T7只曾准备未接线草稿，最后typecheck发现usage累计类型错误，未完成测试；已精确移入忽略的data/s22-t7-unverified-draft供后续参考，不进入src或提交为能力。T7–T10及S2.3–S3.3均未完成。

清理与限制：最终各专项记录本轮资源清理成功；只读数据库复核Job/JobIndexTarget/本轮owner、Resume/FileAsset/Rubric均0。旧孤立policy `s12.t3.d175a1d5332d41dbac3eae8965643b7c.tasks.reliability.v1` 缺少精确创建清单，仍保留，不凭前缀删除；默认resume policy未改。data/s22-residual-audit.json与清理记录仅本机保留；本轮无真实简历、API Key或模型数据。原生Qdrant未启停；正式Rubric未入库；无前端/master修改，无阶段合并或推送。

后续从当前feature/s2.2-jd-rubric恢复，先处理此可靠性阻塞、复验原命令，再续T6导入、T7/T8模型和T9 HTTP/T10阶段交接。真实调用、人工标注与目标服务器仍按原延后表，不用占位结果补齐。

## 2026-11-27 S2.2-T4/T5联合回归失败、最小测试修复与清理核对

联合完整回归（data/s22-t45-integration-final.log）：89项74通过/14失败/1取消，644.114秒。新增发布测试在consumer deferred后立即get消息，broker尚未完成重投导致assert.ok(delivery)失败；另有RabbitMQ clear_policy/installTaskPolicy管理失败、Prisma事务启动超时、PostgreSQL 57014语句超时、Langfuse/PostgreSQL归属检查失败、上传500、retry父项180秒超时及后续发布失败。上述均非L1/L2，不以容器healthy或专项通过替代完整回归。容器只读诊断显示九服务running/healthy，无法据此判定根因；未改超时/配置/数据卷。

最小测试修复：发布测试复用既有消费者测试的有界重投等待模式（5秒内50ms轮询，最终仍断言实际redelivered消息）；不把关闭本地socket误当broker完成重排队。补写data/s22-publication-runs精确UUID/队列/owner清单，以便今后失败核查。此改动后的typecheck/lint通过；build后发布+岗位模型+Langfuse专项14/14通过，60.826秒（data/s22-t4-final-diagnostic.log）。再次pnpm test70/70通过，10.075秒（data/s22-t45-unit-final.log）；修正后的完整回归仍在执行。

上一轮发布清理在clear_policy后中断，确实留下1个Job/2个owner及其版本/任务。只读审计保存data/s22-residual-audit.json；依据精确owner ID、20:56:21Z创建时间、唯一job ID、fixture-only-v1快照且无其他业务资源，已精确删除该轮记录，owner残留0（data/s22-publication-cleanup-record.json）。其他最近s15/s17 manifest均cleaned=true；简历/文件/Rubric计数0。

诊断命令更正：两次list_policies诊断误传name/pattern列参数，rabbitmqctl不接受，不能据此说RabbitMQ仍不可用。去掉列参数后命令成功，未见T4 policy，但存在孤立s12.t3.d175a1d5332d41dbac3eae8965643b7c.tasks.reliability.v1；本轮旧Outbox测试没有manifest，无法仅凭名称证明归属，暂保留，不按前缀删除。真实回归中的clear_policy/installTaskPolicy错误仍按原输出保留。

## 2026-11-27 S2.2-T4诊断复验与T5专项

增加脱敏诊断后 `pnpm run build` 及同一checkpoint-fence专项5通过/0失败，33.886秒（data/s22-t4-fence-diagnostic.log）。本次未复现，仍不宣称已定位前两次claimed前退出；未改业务逻辑或测试窗口。重新启动完整回归以保留诊断证据。

T5 Rubric导入服务/CLI已实现同版本同内容幂等、不同内容拒绝、完整六维L1–L5精确读取、合成版本显式隔离。`node --env-file=infra/.env --env-file=infra/.env.checkpoint --env-file=infra/.env.observability --test --test-concurrency=1 dist/test/integration/rubrics.test.js`1通过/0失败，2.774秒，owner及测试Rubric精确清理。该测试只包含明确标记的合成Rubric，无默认注册。命令只输出版本/内容哈希/计数，不输出原始异常或配置。

联合typecheck/lint通过；随后 `pnpm test`70项69通过/1失败，19.011秒（data/s22-t45-unit.log），唯一原API 8秒冷启动用例失败，按L1单独记录；其他包括新增deadline竞态测试通过。原生Qdrant未操作。T4/T5尚未提交，正式Rubric仍未导入。

## 2026-11-27 S2.2-T4完整回归出现非L1/L2失败，定位中

T4真实PostgreSQL/RabbitMQ发布专项6通过/0失败，18.134秒（data/s22-t4-publication.log）；包括确认/目标缺失、Outbox真实SQL失败全回滚、并发幂等、真实队列deferred无ACK、旧fence/版本/目标拒绝READY；资源精确清理。最终typecheck/lint再次通过。

完整 `pnpm run test:integration`118项115通过/3失败，590.965秒（data/s22-t4-integration.log）；失败为既有Checkpoint/fence两子项在claimed前退出及父项。Docker Qdrant本轮创建3103.0ms通过，不能把该失败归L1/L2。无代码改动直接执行 `node --env-file=infra/.env --env-file=infra/.env.checkpoint --env-file=infra/.env.observability --test --test-concurrency=1 dist/test/integration/checkpoint-fence.test.js`：5项3通过/2失败，61.108秒（data/s22-t4-fence-recheck.log），此次变成另一个同thread无checkpoint恢复用例在claimed前退出，资源仍精确清理。

原fixture丢弃handler异常，父测试只报告Worker ended before claimed。增加仅测试用脱敏IPC诊断（startup/delivery阶段、database/lease/schema/other类别及有限格式错误码；不输出message/SQL/配置）并把finished disposition纳入诊断；未改任何超时/断言/租约。正在复验，T4未提交，后续阶段不得当作该回归已经通过。

T5服务/CLI和T6正式草案文件在工作区准备，尚未导入正式规则或提交；这轮诊断编译包含这些未装配模块，未更改数据库迁移/生产处理器。

## 2026-11-27 S2.2-T4确认与发布事务实现，验证中

T3已提交35d0ed7。T4新增确认标记服务、同事务发布内容哈希/真实JobIndexTask/当前JobIndexTarget/Outbox及owner范围发布幂等。服务器索引目标必须显式配置；同key同版本重放原taskId，即使后续配置改变也不替换冻结目标。新增索引状态提交入口核对任务fence/租约/receipt authority、岗位版本及当前目标；无生产处理器接入，默认消费者仍不领取真实任务。存储测试显式opt-in领取真实kind只用于验证fence，并未生成embedding。

`db:generate`、`db:validate`、ownedPostgres归属核对、`db:deploy`两次、`db:status`通过，11条迁移；类型检查、零警告Lint及 `pnpm test`70/70通过（10.624秒）。真实PostgreSQL/RabbitMQ发布专项与完整回归待追加。没有放宽原租约、超时或消息ACK规则；没有新依赖、真实模型/向量调用、前端/master修改。

## 2026-11-27 S2.2-T3完成：草稿编辑与发布版复制

完整 `pnpm run test:integration`112项110通过/2失败，502.711秒（data/s22-t3-integration.log）；唯一Docker Qdrant createCollection原5000ms超时及父项按L2记录，其他通过。回归后ownedQdrant校验归属并只读查询集合总数0；各测试本轮合成记录/队列精确清理。基础70/70、类型/Lint与草稿专项5/5结果见前条；相对文档链接与git diff --check通过。T3按任务提交，阶段继续进行中，真实模型及人工/目标环境仍延后。

T4发布事务与当前索引目标关系在工作区准备；尚未应用新增迁移、未纳入T3提交，T3全量保持T3编译产物/数据库环境。未修改前端、master或原生Qdrant。

## 2026-11-27 S2.2-T3草稿编辑服务与专项通过

T2已提交2089631。T3新增草稿创建/正文/元数据/要求增删改/权重服务，owner来自可信身份；编辑已发布版本创建新草稿，以岗位锁分配连续版本号，复制stableId与正文后重绑并逐字校验来源。正文改动不猜测引用新位置，失效则整笔回滚；所有编辑重置硬门槛及权重确认。发布、HTTP、真实模型仍未接入。

已执行 `pnpm run typecheck`、`pnpm run lint`通过；`pnpm test`70通过/0失败，17.641秒。`node --env-file=infra/.env --env-file=infra/.env.checkpoint --env-file=infra/.env.observability --test --test-concurrency=1 dist/test/integration/job-drafts.test.js`：5通过/0失败，3.548秒；覆盖owner防伪、要求编辑/伪造/越界/跨版本、正文引用失效回滚、并发从同一发布版生成新草稿及历史不变；本轮owner/岗位/版本/要求精确清理。完整回归待追加，阶段继续进行中。无新增依赖或迁移，无需冻结安装/迁移检查；真实模型、embedding与人工/目标服务器事项继续延后。

## 2026-11-27 S2.2-T2清理补充核对

完整回归结束后再次通过ownedQdrant核对本项目容器/服务/端口/卷归属，并只读getCollections：集合总数0。未删除其他集合或操作原生Qdrant。

## 2026-11-27 S2.2-T2完成：JD/Rubric持久化与真实版本外键

最终 `pnpm run typecheck`、`pnpm run lint`零警告通过；`pnpm test`70通过/0失败，9.472秒。`pnpm run build`后运行 `node --env-file=infra/.env --env-file=infra/.env.checkpoint --env-file=infra/.env.observability --test --test-concurrency=1 dist/test/integration/jobs.test.js`：7通过/0失败，10.523秒，真实锁等待、不可变发布、owner/FK、事务回滚、Rubric及真实任务无处理器待执行/可取消均通过，精确清理完成。

完整 `pnpm run test:integration`：107项105通过/2失败，531.412秒（data/s22-t2-integration.log）。唯一失败为Docker Qdrant createCollection原5000ms超时及父项；清理对账未报失败，依路线图按已接受L2记录，不能称全绿。其余含新增岗位专项和T1修复后的500ms deadline专项均通过。原生Qdrant对照未执行：T2不涉及向量实现，原生实例仅由维护者管理；不自行启停。迁移generate/validate/deploy两次/status结果见前条，未新增依赖。文档/相对链接与git diff检查通过。

T2按任务提交，阶段仍进行中。T3草稿编辑服务/专项已在工作区准备，仅做无emit类型/Lint预检（通过），尚未编译运行或纳入T2提交；T2全量使用T2编译产物与迁移环境。真实模型/embedding、人工审核及目标服务器继续延后。

## 2026-11-27 S2.2-T2迁移与持久化验证中

T1已提交f853374，当前仍feature/s2.2-jd-rubric，未合并/推送。T2新增Job、JobVersion、独立JobRequirement及owner范围RubricVersion，read repository对持久化JSON重新进行Schema、引用和哈希校验。版本身份和已发布内容受触发器保护，要求写入锁住父版本以序列化发布窗口；real_job_version_id与owner复合外键独立于合成UUID，并由CHECK绑定快照kind/版本。

已执行 `pnpm run db:generate`、`pnpm run db:validate`、核对ownedPostgres项目/端口/卷归属后执行 `pnpm run db:deploy`两次及 `pnpm run db:status`，全部通过，10条迁移且无待执行项。不删除旧数据/卷/配置，未更改已应用旧迁移。首次 `pnpm run typecheck` 失败于新测试把Prisma JsonValue直接重用为写入InputJsonValue；已用已校验document/weights/budgetUsage替代，不用类型断言。基础与集成结果待追加。

T2只提供存储边界；草稿编辑服务、发布事务、正式Rubric导入和岗位HTTP仍按T3及后续任务实现。真实模型/embedding、人工审核/标注及目标服务器继续延后。

## 2026-11-27 S2.2-T1完成：岗位/Rubric契约与真实任务隔离

最终检查：`pnpm run typecheck`、`pnpm run lint`零警告、`pnpm run openapi:check`通过；`pnpm test`70通过/0失败/0跳过，10.659秒；修复后的 `pnpm run test:integration`100通过/0失败/0跳过，510.052秒（data/s22-t1-integration-final.log）。Docker Qdrant创建2305.5ms通过原5000ms限制，各专项完成精确清理；未解除L1/L2，仍按S3.3在目标环境复验。相对文档文件链接与 `git diff --check` 通过。

T1按任务提交，包含已复现并修复的既有deadline/heartbeat交错窗口，失败记录见下文。契约覆盖六维/完整Rubric等级/权重边界/JD引用/真实与合成快照；尚无岗位HTTP、真实索引或模型调用。无依赖变更，不需冻结重装；没有真实服务商Key、人工标注或目标服务器验证。T2模型/迁移及专项已在工作区准备，尚未generate/deploy或纳入T1提交；先等T1全量结束以保持运行中数据库及生成代码一致。阶段仍进行中，未合并推送。

## 2026-11-27 S2.2-T1完整集成失败记录与截止时间竞态修复

完整 `pnpm run test:integration`：100项，96通过/4失败，495.931秒。失败是新增真实快照专项（旧数据库约束job_index_task_snapshot_check仍只允许synthetic）及父项、既有retry总期限专项（runtime预算500ms，ACK实际0/预期1）及父项。本轮Qdrant创建4790.1ms在原5000ms内通过，不记L2失败；本轮各专项报告精确清理完成。完整日志在忽略的data/s22-t1-integration.log。

修正新增测试到T1实际边界后，执行 `pnpm run build` 和 `node --env-file=infra/.env --env-file=infra/.env.checkpoint --env-file=infra/.env.observability --test --test-concurrency=1 dist/test/integration/tasks.test.js dist/test/integration/retry.test.js`：26通过/0失败，67.918秒。没有改500ms预算、8秒会话窗口或断言；该通过不覆盖前次失败。

为复核偶发ACK失败，新增mock Date/setTimeout的确定性竞态测试：心跳先开始、总期限到达、在途心跳再返回ExecutionLeaseLostError。修复前consumer专项5项4通过/1失败，返回TASK_EXECUTION_INTERRUPTED而非受fence保护的超时完成（data/s22-t1-deadline-repro.log）。根因是TaskDeliveryHandler无条件把心跳失败视作基础设施故障，绕过TaskExecutionStore.fail已实现的deadline-capped lease特例。

最小修复仅允许总期限已到且心跳为ExecutionLeaseLostError时尝试原fail事务；该事务仍核对token/generation/leaseOwner/receipt以及租约是否确实截断于deadline，真实fence变更仍拒绝。数据库错误、外部取消均不放行，输出提交/续租条件及所有预算不变。回归测试同时验证数据库失败和新fence拒绝时不ACK。此项为保持既有截止时间验收语义的修复，不扩展任务或放宽限制；修复后检查待追加。

## 2026-11-27 S2.2-T1契约实现与验证中（feature/s2.2-jd-rubric）

接续核对HEAD=c3024f0、工作区干净；已读AGENTS、CONTRIBUTING、路线图§5/§6、需求六维及架构JD/任务/评分章节。新增岗位、要求、六维权重、Rubric完整等级契约与JD文本证据规则；真实job-index快照与synthetic分离。未注册岗位HTTP、未实现数据库迁移或真实索引。

执行记录（不覆盖失败）：

- 首次 `pnpm run typecheck` 失败：Zod issue直接传给addIssue不满足exactOptionalPropertyTypes。改为显式复制安全的code/path/message；后续typecheck通过。
- `pnpm run lint` 通过，零警告；补充测试后再次typecheck/lint均通过。
- 首轮 `pnpm test`：69项，67通过/2失败，25.718秒。新增5项全部通过；既有DOCX正常解析报PARSER_TIMEOUT（15.377秒），API启动8秒超时。DOCX不归入L1/L2，未改业务/测试超时或断言。
- 同代码原命令复核 `pnpm test`：69通过/0失败，9.202秒，原DOCX和API用例通过。原始复核日志在忽略的data/s22-t1-unit-recheck.log；首次输出已在本记录保留。
- 完整 `pnpm run test:integration` 已启动，结果待追加。新增真实快照延后执行专项起初提前使用T2尚未实施的数据库契约，复核旧迁移发现kind只允许synthetic；测试调整为T1验证真实写入被数据库拒绝且事务无残留，待T2迁移后再验证真实任务保持QUEUED、不ACK、不消耗尝试/恢复预算及可取消。运行中的已编译测试仍含旧版专项，预计会报此失败，将保留实际结果再复验。

T1文档见[jd-rubric](jd-rubric.md)。真实模型/embedding、人工审核、目标服务器均未执行，按路线图延后；T1未新增依赖、未操作前端或master，阶段保持进行中。

## 2026-11-27 S2.1已合并推送，S2.2开始（feature/s2.2-jd-rubric）

S2.1的10个任务提交已由b66131e以--no-ff合并到develop；origin/develop=b66131e，远端feature/s2.1-resume-evidence=9f9f639，均已推送。合并后工作区干净，本地已合并的S2.1分支按CONTRIBUTING用-d清理，远端阶段分支保留；master未切换/修改/推送。首次fetch发生GitHub SSL_ERROR_SYSCALL，第二次fetch成功后才合并，不以旧远端引用代替最新检查。

从更新后的develop创建feature/s2.2-jd-rubric，阶段状态进行中；尚未交付S2.2代码。按用户明确授权新开会话继续S2.2至S3.3，沿用全部既定决策、每任务检查/提交、每阶段合并推送、延后表和停止条件，不额外请求确认。

本机Windows/Node24.22.3/pnpm12.23.0，九个项目Docker服务已启动；原生Qdrant未运行且仅由用户手动管理。S2.1最终基础64/64、集成97/99仅Qdrant L2，集合及合成文件/业务记录无残留。后续真实模型/embedding/人工标注/目标服务器延后项不能伪造完成，具体见路线图。前端仓库未修改，契约以src/contracts及docs/api-contract.md为准。

## 2026-11-27 S2.1-T10 阶段回归与交接（待验收）

S2.1-T1–T9实现、检查与按任务提交完成，T10同步README/架构/测试/API/契约/依赖/部署及进度。阶段改为待验收，按维护者授权用--no-ff合并develop并推送；不操作master。文本抽取不是语义结构化，ParsedResume仅契约/校验器，模型EXTRACT留S2.4。

| 检查 | 本轮结果 |
|---|---|
| pnpm run typecheck / pnpm run lint | 通过，零警告 |
| pnpm test | 64通过、0失败、0跳过，9.569秒 |
| pnpm run openapi:check | 通过，Schema与产物一致；新增上传/列表/详情与文件reason |
| pnpm run test:integration | 99项：97通过、2失败、0跳过，632.630秒；唯一失败为Docker Qdrant createCollection原5秒超时及父项，按L2接受，非全绿 |
| T8真实HTTP/文件/DB | 6/6通过，父21.276秒；含幂等、owner、分页、空/扫描/加密/超限、文件/DB失败、解析断连、提交响应丢失找回 |
| T7真实文件与DB | 6/6通过，父3.861秒；含并发PDF/DOCX、不可变、引用与回收 |
| 迁移 | generate/validate通过，deploy两次/status通过，共9条迁移，无pending |
| pnpm install --frozen-lockfile | 最终依赖集合通过；原严格peer、安装脚本策略不放宽 |
| 资源复核 | Qdrant集合0；本轮业务简历/FileAsset/ExtractedDocument计数均0；最新fence清单cleaned=true；测试临时文件与队列/策略按精确本轮身份清理 |
| 文档与diff | 9份文档106个本地链接有效；git diff --check通过；后续状态/交接文本再次核对 |

本阶段遇到的编译、Lint、上传与旧测试竞争失败均已逐项追加记录，没有覆盖历史失败；旧测试修正仅确认数据库会话实际退出、直接领取测试续租、心跳用例读取一致快照，未扩大原超时/租约或改变业务恢复逻辑。最终完整回归除L2全部通过，L1/L2仍未解除。

未执行/延后：原生Qdrant未运行，未执行对照且未启停；Linux解析资源分支/新机冷安装/生产负载与认证未验证。S2.1无“统一验收前延后表”中的任务；后续真实模型Key、embedding真实索引、人工标注及目标服务器验证仍按该表延后，不用假数据补成已完成。参考文档不等于OCR/模型/评分/报告可用；PDF复杂阅读顺序显式警告，仅可靠页码；DOCX没有虚构页码。

后续阶段从更新后的develop开始S2.2，依次至S3.3。用户已授权每阶段完成后自主新开会话继续，交接必须沿用本路线图和原生Qdrant手动管理规则。

## 2026-11-27 S2.1-T9 提交补记

T9契约与引用校验已按任务提交，功能与验证同前述T9完成记录：typecheck/lint通过，最终联合基础测试64/64通过，固定中文多经历/多项目样例拒绝无引用、伪造及额外字段。模型调用与语义产物持久化均未执行，属于S2.4。最终阶段集成97通过、2项L2，详见随后T10记录，不以契约样例替代模型验证。

## 2026-11-27 S2.1-T8 上传、列表与版本详情完成

已接线POST /api/v1/resumes同步multipart上传、GET游标列表和版本详情；RESUME_API_ENABLED显式本地开关，可信IdentityPort，生产/公网固定身份拒绝。OpenAPI复用运行时Schema，413/422有安全reason，409按owner/key/原文件哈希绑定；不返回路径/owner/语义占位字段。stream→隔离解析→文件提交→DB事务，失败精确补偿；提交响应丢失保留已引用文件并支持同key找回。storage:reconcile按归属、24小时、已退出原上传进程和真实无引用条件恢复未知提交/遗留锁，不删除数据库/卷或配置。

检查：typecheck、零警告lint、openapi:generate/check通过；最终pnpm test64/64（9.569秒），含配置限制和真实崩溃清理；HTTP+消费者专项17/17（73.662秒），阶段最终HTTP组新增空文件与提交响应丢失后6/6通过（父21.276秒），文件/数据库组6/6通过。busboy与类型依赖精确声明/锁文件、冻结安装通过。首次400、超限500及类型错误均在前记录保留，未降低校验。未执行真实简历/生产认证/模型、Linux/新机验证。

断连边界：提交前中断不会提交业务记录，提交后响应丢失属于幂等恢复窗口，不能删除已提交版本；不是跨系统原子事务承诺。旧清单无PID、PID复用或DB无法查询时保留待核查。阶段仍待最终完整集成结论，不提前合并。

## 2026-11-27 S2.1-T7 引用与不可变产物完成补记

T7新增引用单元测试与真实PDF/DOCX/存储/数据库6项专项均通过；迁移9条已应用，generate/validate、重复deploy/status通过。阶段最终基础检查typecheck、零警告lint、pnpm test64/64通过，openapi:check通过；T7全量中的原心跳测试竞争已按同快照与实际续租修正，专项17/17及阶段全量当前已通过相应组。历史失败不覆盖，最终全量计数随T10追加。

引用及JSONB读写全部经Schema校验，稳定块ID及哈希可追溯；并发两份不同owner文件不串数据。未调用模型，不把ParsedResume契约误当已完成语义抽取。数据库版本/原文件不可原地替换，删除仍由后续S3.2生命周期处理。T7提交保留阶段进行中，不单独推送/合并。

## 2026-11-27 S2.1-T9 ParsedResume契约与引用校验完成

教育/工作/项目/技能的严格Zod契约包含schemaVersion、resumeVersionId和每项sourceRefs；nullable字段必须显式null，缺失集合为空数组，有内容条目缺引用拒绝。校验器复用T7的逐字区间、代理对、owner/版本/块检查；额外字段及totalScore拒绝。固定中文教育/多项目合成样例验证通过，没有调用模型或持久化语义抽取结果，EXTRACT仍由S2.4实现。

本项执行typecheck、零警告lint与pnpm test通过；最终联合基础测试64/64通过、0跳过（9.569秒），包含契约专项。openapi:check通过（T9契约不注册语义抽取路由）。未执行真实模型/标注/语义质量评估：不属于T9且按路线图延后。工作区包含待提交T7/T8与T10文档，不改变其状态；T9可独立于HTTP提交。

## 2026-11-27 S2.1-T8 HTTP专项修复与T9契约实现

上传首次正常请求400已修正multipart parts计数；次轮HTTP3通过/2失败（含父），唯一行为失败为超限文件500而非413。根因是StoragePort超限后终止源流，multipart未同步结束，直到30秒传输deadline；现拒绝时终止parser并保留原始安全错误原因。复验HTTP+消费者专项17/17通过（73.662秒），含真实PDF/DOCX上传、幂等409、列表游标、owner404、422/413、文件提交/DB失败补偿、解析断连。心跳测试改为真实续租通知和同一快照后12/12通过，待阶段全量。

新增storage:reconcile崩溃对账：过期manifest、确认uploaderPid已不存在、DB无引用三条件；未知/复用PID或旧清单保留，操作锁也带PID。测试真实fork后SIGKILL、确认exit、验证活进程/被引用文件保留及精确清理。最新typecheck/lint通过，pnpm test63/63（18.715秒）包含该崩溃专项与T9固定样例。

T9已定义严格ParsedResume教育/工作/项目/技能Schema与每项sourceRefs，缺失为null/空数组；有内容条目无引用拒绝，复用T7拒绝伪造/跨owner/跨版本/越界引用及模型额外分数字段。只验证固定中文多项目合成样例，不调用模型、不持久化语义产物。后续追加最终检查和分任务提交；尚无阶段合并/推送。

## 2026-11-27 S2.1-T7 产物与引用专项，T8接线记录

T7增加ExtractedDocument表及不可变触发器、完成产物后禁止新增文本块；产物与版本/文件哈希复合外键绑定。引用校验覆盖owner/sourceType/version/block、UTF-16半开区间、逐字quote及代理对；块ID由输入版本/parser/ordinal/text稳定派生。generate/validate、deploy两次/status通过（9条迁移）；typecheck、lint通过；pnpm test61/61通过（25.801秒）；真实PDF/DOCX+存储+数据库专项6/6通过（6.857秒），并发不同owner数据不串，精确清理。

T7完整集成93项：89通过、4失败、0跳过（589.030秒），T7全部通过；Qdrant创建超时及父项按L2候选，另有心跳用例/父项失败，actual acknowledged=1预期0。检查测试发现直接等待350ms猜测续租完成，并在两次独立查询间允许心跳更新，断言异常会被生产故障处理器当失败任务持久移交并ACK。最小修正改为等待真实续租通知、RepeatableRead同快照读取两表，再按原逻辑修改fence并验证无ACK；原生产逻辑和8秒会话上限不变，待专项/全量验证。不归入L1/L2。

T8准备：busboy1.6.0/@types1.5.5精确声明与冻结安装通过，官方LICENSE/README已核查；同步上传、列表/详情、配置、OpenAPI已接线。首次typecheck因readonly Schema shape及可空filename失败，已修复；首次真实HTTP正常上传400而非201，定位到busboy partsLimit边界计数，改成保留终止边界空间且files=1/fields=0仍严格拒绝额外字段；原始文件10MiB限制仍由StoragePort流式执行。HTTP专项待复验，不把路由接线当验证完成。

## 2026-11-27 S2.1-T6 DOCX段落与表格文本完成

Mammoth1.13.0在ZIP预检后接收Buffer，通过公开transformDocument hook和Zod节点校验抽取中文段落、软换行、表格行/单元格与段落序号。HTML不提供给客户端，图片不读取，禁止externalFileAccess；不虚构页码。正文缺失/损坏/空文本/加密/旧.doc及文本超限明确失败；节点深度受限，原始文件与文本保持分离。

首次DOCX专项0/2：两例CORRUPT_FILE，直接合成实验定位到Mammoth初始化ExternalPromise.__proto__与新增disable-proto开关冲突；移除非任务要求的开关，文件/网络/进程与资源限制保持。修正后typecheck、零警告lint、完整pnpm test60/60通过、0跳过（8.964秒），其中DOCX两项及T4隔离/PDF全部通过。依赖安装/冻结安装通过，锁文件随T4准备提交；未更换解析器或修改上游源码。位置方案在文件与证据文档定稿。

未执行：Linux、真实简历、任意复杂Word版式保证、OCR、真实模型抽取。页面/表格展示不能把抽取顺序等同原始视觉布局。T4–T6分别提交，阶段仍进行中，尚未推送或合并。

## 2026-11-27 S2.1-T5 PDF文本与页码定位完成

PDF.js6.5.438 legacy文本适配器已接入隔离worker。中文、多页、项目列表、双栏/单行表格、扫描/混合图像页、密码、损坏、空白、30/31页与文本超限使用合成ToUnicode样本验证。PDF位置定稿为真实一基页码与bounds=null；基线矩阵不是精确字形框，不伪造坐标。复杂阅读顺序显式READING_ORDER_UNCERTAIN，混合无文本页PARTIAL_TEXT_LAYER。块持久身份由T7保存，语义抽取仍未实现。

typecheck、零警告lint通过；PDF专项2/2通过（5.699秒）；扩展30页与项目列表后pnpm test58/58通过（10.702秒）。依赖精确安装/冻结安装通过（依赖集中随T4预检执行器提交）；未运行真实简历/OCR/Linux。T4分任务暂存时曾因hash-object绕过换行转换导致cached diff检查发现CRLF尾空白；已在未推送的T4提交中归一化并amend，cached diff检查通过，不修改远程历史。

## 2026-11-27 S2.1-T4 预检与有界解析执行完成

实现文件类型签名交叉校验、OLE/CFB/旧.doc/.docm明确拒绝、ZIP实际解压量/压缩比/条目/CRC/路径/链接/嵌套/外部关系防护；子进程接收内存字节并限制权限、网络、单实例并发、输出量、总期限、JS堆和RSS。拒绝或中止后等待真实close与在途资源监测；不是仅Promise超时。CPU以总执行期限约束，RSS是轮询而非OS瞬时硬配额；Windows实测，Linux待部署验证。

检查：typecheck和最终零警告lint通过（首次类型导入Lint失败已修正）；真实隔离/恶意ZIP专项3/3通过；pnpm test56/56通过；精确安装D11选定yauzl3.4.0、PDF.js6.5.438、Mammoth1.13.0及@types/yauzl3.4.0，锁文件同步，每次冻结安装通过。安装PDF/Mammoth为后续适配器准备，本提交不宣称其解析已接线；T5/T6代码分别提交。T6发现Mammoth与非任务要求的disable-proto开关不兼容，移除该额外开关，权限/网络/资源限制不变，联合复验记录随T6追加。

未执行：Linux、生产负载/安全审计、真实文档质量；测试全部使用合成字节。资源限制是实验参数，不保证生产容量。基础/集成历史失败完整保留；T3全量剩余仅L2，T4不增加外部服务访问。

## 2026-11-27 S2.1-T3 完成与回归结论

第三轮默认Docker完整集成92项：90通过、2失败、0跳过（617.435秒），仅Qdrant createCollection原5秒超时及父测试，子用例6.173秒；归属核验后集合只读查询为空，按已接受L2记录。fence/消费者两处测试前提修正通过全量验证，Langfuse通过，S2.1数据库专项5项全部通过，全部本轮业务测试清理完成。原生Qdrant未运行，对照未执行且未操作。T3完成，仍不解除L1/L2，不把默认命令记成全绿。

累计已执行T3检查：generate/validate、deploy两次/status（8条迁移）、typecheck/lint、真实数据库专项、三轮完整集成，失败与修复均见前述记录。最终共享工作区基础测试58/58通过（含已经完成验证的T4/T5代码，10.702秒）；T3单独开发阶段的52/1 L1结果仍保留。T3按任务提交迁移、repository、专项和回归helper最小修正；解析依赖/实现另按T4–T6提交。未执行Linux、新机冷安装或生产验证。

## 2026-11-27 S2.1-T3 第二轮回归及消费者测试前提修复；T4专项通过

第二轮默认Docker全量92项：88通过、4失败、0跳过，596.987秒；仅消费者analysis并发接管子项/父项与Qdrant创建子项/父项失败。fence、Checkpointer、Langfuse、S2.1数据库、其余可靠性测试均通过。消费者实得limit而预期deferred：测试直接claim后使用2秒租约，但没有TaskDeliveryHandler心跳，发布/接线超过租约时消费者合法接管。最小修正仅在测试验证“仍在租约内”期间按原heartbeatMs续租；随后停止心跳，按原逻辑显式过期并验证新fence/旧写拒绝。未扩大生产租约、测试窗口或放宽断言。专项12/12通过（54.816秒），精确资源已清理；修正后typecheck、零警告lint通过，第三轮完整回归已启动。

T4真实预检/隔离专项3/3通过（4.798秒），含类型与OLE/CFB、伪造ZIP展开量/CRC、路径/链接/嵌套/外部关系、真实子进程超时/abort/RSS/堆限制、权限/网络/环境隔离、输出校验与PID退出。完整pnpm test为56/56通过、0跳过（7.419秒）；该次覆盖T3与T4及两处可靠性测试helper修正的编译。默认解析worker尚无PDF/DOCX适配器，明确失败而不是产出假文本。Linux资源监测和复杂真实解析样本未执行；接下来按T5/T6验证。

## 2026-11-27 S2.1-T3 修正后专项复核与T4并行准备

终止会话同步修正后，首次fence专项仍失败：5项中2通过、3失败（含父测试），114.094秒；unknown-old用例报Worker ended before late-checkpoint，首Checkpoint前重启用例报Worker event timed out: claimed（原20秒）。该轮清单cleaned=true，未修改业务行为、期限或断言。再次诊断运行带父测试名称筛选，Node runner实际运行了全部5项，5通过、0跳过（35.710秒）；不能将它称为只跑一项，也不覆盖前次失败。第二轮完整集成已启动，旧Worker隔离与Checkpointer通过，消费者并发接管出现新失败，等待最终异常；Langfuse1/1通过。

首轮Docker Qdrant经归属核验后只读查询集合为空，createCollection超时符合L2；原生进程未运行，对照未执行，没有启停它。原API冷启动L1、首次Langfuse超时及两轮fence失败分别保留，不合并成同一种环境问题。

完整集成等待期间，准备仅依赖T1/T2的S2.1-T4，尚未标完成：yauzl3.4.0、@types/yauzl3.4.0精确安装及冻结安装通过；ZIP流式实际展开量/CRC/路径/链接/外部关系预检、隔离子进程及合成测试代码已写入。T4 typecheck通过；首次lint因仅类型用途的z导入失败，改为import type后lint通过。T4运行/恶意样本/资源边界尚未执行，PDF/DOCX适配器未实现，不提前发布路由或声称解析成功。T3/T4分别组织提交，阶段尚未合并或推送。

## 2026-11-27 S2.1-T3 首轮完整回归与故障定位补记

默认Docker完整test:integration：92项中87通过、5失败、0跳过，551.672秒；失败为Checkpoint fence子用例及父测试、Qdrant子用例及父测试、真实Langfuse。S2.1数据库5项在完整套件中全部通过（父3.243秒）；其余任务创建/消费者/Outbox/重试/对账/API均通过，测试输出确认本轮记录/队列/策略清理。

- fence失败是终止旧数据库会话后立即reconcile得到lock-held而非recovered。核对[PostgreSQL16官方说明](https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-ADMIN-SIGNAL)：pg_terminate_backend默认timeout=0只确认信号发送，不等待会话实际退出。最小修正仅修改测试terminateLock helper，使用3000ms有界等待并断言返回true，再执行原恢复断言；仍在原5000ms statement预算内，不改业务恢复、测试总体超时或原断言。该同步缺口不能归入L1/L2，待专项与全量复验。
- Qdrant堆栈明确失败于createCollection的原5秒限制，子用例8.068秒包含归属/清理；未返回CleanupPendingError，仍需只读核对集合残留后按L2记录。不调大限制、不操作原生实例。
- Langfuse为TimeoutError，原测试未提供具体fetch阶段；九服务均healthy后用同一专项、相同超时单独复验1/1通过（13.471秒）。没有改配置、测试、模型或依赖，不据单次通过宣称消除冷启动/负载风险；保留首轮失败，不将其误算L1。

## 2026-11-27 S2.1-T3 持久化模型与迁移，回归进行中（feature/s2.1-resume-evidence）

实现FileAsset、Resume、ResumeVersion、EvidenceBlock、ResumeUpload与repository；复合外键保护owner/版本/文件哈希，unique(resumeId,version)，触发器拒绝原地UPDATE；owner/key事务锁与同库事务保证上传并发幂等和回滚。没有给S1.4合成任务的版本UUID添加业务外键。ExtractedDocument仍按T7实现。

已执行：db:generate和db:validate通过；核验项目PostgreSQL容器/端口/卷后db:deploy成功、再次deploy无pending，db:status显示8条迁移全部已应用。新迁移未改历史表。Prisma关系显式NoAction以匹配SQL默认动作，调整后重新generate/validate通过。typecheck和lint通过。新增真实数据库专项5/5通过（9.502秒），包括T2回收命令真实引用检查，合成记录及本轮临时目录已精确清理。

失败记录：准备时Docker引擎未启动，启动Docker Desktop后首次docker inspect超时；第二次业务容器/卷归属检查成功。infra:up因PostgreSQL恢复期间unhealthy退出1；日志显示非正常关机后的fsync/自动恢复，一次ready后服务子进程退出码2并再次恢复，之后healthy且迁移/专项成功，未重置数据。observability:up两次因Web启动健康检查超时失败，之后Web实际健康200、Worker启动，最终九服务healthy。新集成测试曾因UUID模板字符串推断出现TS2322编译失败，改用Schema派生类型修复；基础测试最终52通过、1失败、0跳过（52.897秒），唯一失败为Child api did not start（8049.8ms），按L1保留。

完整pnpm run test:integration正在运行；目前已发现旧Worker隔离、Langfuse持久化与Qdrant用例失败，尚待结束输出具体原因，不认定全部属于L1/L2，不标任务完成。原生Qdrant未发现运行进程，未启动/停止，原生对照未执行。文档39个本地文件链接及git diff --check通过。尚未提交T3、合并阶段或推送；后续记录补充最终回归结果与处理。

## 2026-11-27 S2.1-T2 本地存储与精确暂存补偿（feature/s2.1-resume-evidence）

新增StoragePort及本地适配器：专用绝对根目录与项目/路径归属标记、服务器UUID键、流式大小上限与SHA-256、独占创建、fsync、WRITING/READY/COMMITTING/COMMITTED清单、提交及读取。检查路径祖先/真实路径、拒绝junction/symlink/文件硬链接；不承诺防御拥有根目录写权限的恶意本机管理员。

即时补偿只处理本次暂存操作，拒绝discard已提交文件；每个操作的独占目录锁覆盖提交、删除与回收引用检查，未知提交结果和崩溃遗留锁保留可核查状态，不盲删files区。新增storage:reclaim命令供操作系统定时调用：24小时、真实数据库无引用、归属核验后才删除受控暂存文件；缺表/DB故障失败关闭。T3尚未建表，真实命令成功路径待T3/T8联调；不宣称跨文件/数据库事务已完成。

检查：首次typecheck通过；首次lint发现no-useless-assignment失败，删除不必要的状态变量后修复。首轮基础测试51/51通过；补根目录标记、回收命令及两项故障测试后最终typecheck、零警告lint通过，pnpm test为53通过、0失败、0跳过（4.522秒）。6项真实临时目录专项覆盖持久读回、独立同内容文件、超限/空文件/源流异常/中止补偿、路径/junction拒绝、DB引用/故障、提交失败状态、非本项目目录和回收锁竞争。git diff --check通过。仅package scripts变化，没有依赖声明/锁解析变化。

未执行：真实DB回收命令成功路径（T3前缺少file_asset表）、突然断电耐久性、Linux验证、全量集成（T2测试使用真实临时目录和引用端口，未接服务）。准备T3时只读Compose查询失败：dockerDesktopLinuxEngine命名管道不存在，正在启动本机Docker并核查项目资源，不操作原生Qdrant。T1冷启动L1失败仍保留，T2成功不解除L1。

## 2026-11-27 S2.1-T1 文件、证据与处理契约（feature/s2.1-resume-evidence）

完成T1契约与设计产出；S2.1仍进行中，尚无上传/解析业务路由。开始时工作区干净，fetch后HEAD与origin/develop相同（左右差异0/0），未操作master。已阅读AGENTS、CONTRIBUTING、路线图§5/§6、最新进度与相关需求/架构/契约。

- 新增文件、版本响应、文本块、引用、ExtractedDocument及失败原因的严格Zod契约；UTF-16半开区间、NFC/换行顺序、块UUID/ordinal/哈希、owner/版本隔离规则见[文件与证据契约](resume-evidence.md)。PDF/DOCX位置字段仍暂定，待T5/T6样本实验。
- 明确同步上传201、幂等409、大小413、解析422；同owner/key绑定原始字节sha256。只定义Schema，未注册未实现路由或修改OpenAPI。R2及架构PARSE/上传链同步为上传时解析、分析时读已存产物、S2.4执行语义EXTRACT。
- 完成合成样本矩阵和资源限制实验方案的逐项人工式静态核对；尚未生成/运行解析文件样本，不把设计矩阵当质量实测。
- registry复核pdfjs-dist6.5.438、mammoth1.13.0、yauzl3.4.0，保存精简元数据及integrity，读取官方发布包README/package.json。Node fetch首次ECONNRESET，pnpm查询/curl下载成功；初次读取误用eslint.config.mjs失败，随后读取实际eslint.config.js。未安装新依赖、未修改锁文件。包文档说明及安全边界已写入依赖说明。

检查：typecheck通过；lint通过（零警告）；pnpm test共47项，46通过、1失败、0跳过，81.752秒。唯一失败为原process.test.ts有效配置API启动用例8238.8ms、Child api did not start，符合已接受L1的API冷启动8秒限制；其余用例及新增2项契约测试通过。没有调整超时、断言或以重复运行覆盖失败。6份文档50个本地文件链接有效；git diff --check通过。

未执行：集成测试、迁移、冻结安装、解析样本与资源边界、Linux验证；T1无服务/迁移/依赖安装变更，解析专项属于T4–T6。真实模型、人工标注、目标服务器与L1/L2解除继续按路线图延后，不使用占位结果。T2/T3可按依赖顺序继续；阶段未完成，未合并或推送。

## 2026-11-27 决策确认与develop集成分支流程

维护者一次确认全部待决策事项，并授权AI连续完成后续全部阶段，不逐阶段停下验收。只改文档。

- 决策：D6文本层PDF与DOCX、不做OCR；D11 pdfjs-dist、mammoth、yauzl；D1由AI起草Rubric v1，统一验收时维护者审核；D2经第三方中转站、OpenAI兼容接口，baseURL/Key/模型名由维护者在本地配置提供；D3阿里云百炼文本向量；D7采用文档候选值（六维等权、系数1/0.5/0/0、真实数据保留30天）；D9本地账号+服务端会话+CSRF，命令行创建账号；D10单机Docker Compose。维护者知悉中转站可接触发送的简历文本，路线图要求发送前移除联系方式。
- 维护者暂不提供API Key；人工标注与目标服务器上的任务留到统一验收。路线图新增“统一验收前延后的任务”表，列出每项照常完成与延后的部分；延后项不阻塞阶段合并，不得用假模型或假标注补齐。
- 分支流程：新建 `develop` 集成分支；阶段分支从 `develop` 创建，完成后 `--no-ff` 合并回 `develop` 并标“待验收”；AI可推送阶段分支与 `develop`，不得修改 `master`。全部完成后维护者统一验收 `develop` 再合并到 `master`。CONTRIBUTING同步修改。
- 检查失败处理：能隔离的失败记录后继续，后续任务依赖它时停止。
- 任务表随决策调整：S2.2-T6改为AI起草Rubric v1；S2.2-T8、S2.3-T7改为OpenAI兼容与百炼适配器，代码与本地HTTP桩测试照常完成、真实验证延后；S2.5-T7写入D7数值；S3.2-T1写入D9细节；D表与阶段总览标为已确定。
- 删除工作区中未跟踪的 docs/research/parser-dependencies-2026-11-26.json（此前Codex生成，维护者同意不保留）；其中的版本信息与D11确认一致，S2.1-T1实施时按当时registry重新复核。

## 2026-11-27 S2.2–S3.3 任务拆分与连续执行规则（分支 feature/s2.1-resume-evidence）

维护者要求把前后端后续开发任务一次拆分完，交由AI连续执行。只改文档，未修改代码、迁移、接口或依赖。

- 路线图§2的拆分规则改为：全部后续阶段已拆分，阶段开始时仍须对照当时代码与决策复核，调整需维护者确认。
- §5新增“执行顺序与停止条件”：前后端八个批次的顺序与进入条件；门禁规则（依赖D编号或维护者输入的任务未满足时跳过，阶段不能整体验收，不得以mock或占位数据标记完成）；必须停止的六类情况；每阶段到“待验收”后停止，维护者授权才可堆叠分支连续执行；检查命令简称。
- 新增S2.2（10项）、S2.3（9项）、S2.4（10项）、S2.5（8项）、S3.1（7项）、S3.2（7项）、S3.3（9项）任务表。设计取舍：JD抽取在HTTP请求内同步执行并只产出待确认建议；S2.2发布的真实索引任务待S2.3处理器执行；召回以RecallQuery契约为输入，由S2.4从ParsedResume构造；模型与embedding都拆为“端口+确定性假实现”（可在决策前开发和测试）与“真实适配器”（需D2/D3与维护者提供Key）；S3.1之前分析任务使用临时finalize，reportId为null，S3.1起要求报告提交；数据删除采用持久删除请求与对账式执行器，不新增任务类型。
- 需维护者输入的任务：S2.2-T6（D1）、S2.2-T8（D2）、S2.3-T7（D3）、S2.3-T8与S3.3-T1（人工标注）、S2.4-T9（真实模型与预算）、S2.5-T7与S3.2-T4（D7）、S3.2-T1（D9）、S3.3-T5/T7（D10）、S3.3-T8（目标服务器）。D表阻塞列改为指向具体任务。
- S3.1阶段验收要求补充“报告关联结构化简历”，与前端F2.4一致。

本轮检查见下文汇报；未执行typecheck、Lint、测试与构建（无可执行变更）。工作区中未跟踪的docs/research/parser-dependencies-2026-11-26.json不是本次产出，未修改、未纳入提交。

## 2026-11-26 S2.1 任务拆分修订（分支 feature/s2.1-resume-evidence）

维护者审阅拆分草案后确定方向，路线图S2.1拆分按此修订；D6、新增的D11与修订后的任务表仍待最终确认。只改文档，未安装依赖、修改代码/迁移/接口或处理真实简历。

- 文本解析在上传请求内同步完成，不新增第三类任务；成功201，失败413/422且不留业务记录，暂存文件即时补偿，遗留文件由T2的定期回收处理。
- 语义结构化执行移到S2.4的分析图EXTRACT节点；S2.1-T9改为ParsedResume契约与引用校验，不调用模型，S2.1不再依赖D2。阶段总览、阶段交付表与D2阻塞范围同步调整。
- 新增D11（PDF：pdfjs-dist，DOCX：mammoth，另加流式ZIP检查库），T1核对后请维护者确认，确认前不安装。曾评估MinerU本地与云端接入：本地版需新增Python服务、DOCX只走最低质量档、模型推理资源占用高；云端版需把简历交给第三方并改为异步解析。维护者决定不采用。
- 评审意见补入对应任务：T1位置字段暂定、待T5/T6样本实验定稿；上传Idempotency-Key与文件sha256绑定，本阶段每次上传创建新Resume；T4写明子进程资源限制方式及实测平台；样本补加密DOCX（OLE/CFB）、旧版.doc、.docm；30页仅适用于PDF，DOCX用文本量上限；每项检查补pnpm test。
- 需求R2分期与架构§4.1、§9的调整列为T1产出，本次未改。前端路线图F2.1/F2.4的验收调整另在前端仓库修改。

本轮检查：两个仓库git diff --check通过；后端路线图与进度共76个本地链接/锚点、前端两份文档共11个，均有效；任务编号T1–T10连续。未执行typecheck、Lint、测试与构建（无可执行变更）。前端修改在新分支feature/f2.1-scope-adjust。两个仓库均未提交、未推送。

## 2026-11-26 S2.1 启动准备与任务拆分草案（分支 feature/s2.1-resume-evidence）

维护者已确认S1.4验收完成，并要求进入S2.1。fetch核对远端master为`c728ef8`（PR #3），包含`01d72ae`验收记录及PR #2交付；本地master以fast-forward更新，再创建本阶段分支。S1.4已完成及L1/L2处理规则保持，原验收历史保留。

阅读现有工程约定、路线图、需求、文件/证据架构和契约，并核对API配置、合成任务契约及Prisma模型。路线图原先只有S2.1阶段交付项，没有任务拆分，D6仍为待决策；按AGENTS工作流程先补充S2.1-T1–T10草案，每项列明依赖、产出、验收和检查。阶段标为进行中，仅表示准备工作已启动，无业务功能交付。

发现依赖缺口：R2要求语义结构化，架构明确由LLM抽取，但D2尚未选择提供商/模型，原S2.1阻塞项仅列D6。草案建议先推进T1–T8文件/文本/证据/API，T9保留语义结构化及D2依赖，不移出本阶段、不以空字段替代；T10在全部交付后验收。D6建议采用文本层PDF和含文本DOCX，不含OCR；拆分、D6及上述实施顺序等待维护者确认。

本轮检查：git diff --check通过；两份文档75个本地链接/锚点有效；10个任务编号连续、任务表列数正确；历史progress正文逐字保留；分支基于已更新master。仅修改路线图与本条进度，未安装依赖、修改代码/迁移/接口、运行服务或处理真实简历。未执行typecheck、Lint、业务测试、构建和集成测试：仅为文档准备，无可执行变更，前轮运行结果不冒充本轮验证。未提交、未推送、未合并本阶段分支。

## 2026-11-26 S1.4 阶段验收：通过，附已知环境限制L2（分支 feature/s1.4-task-foundation）

验收人：维护者委托的审查AI；最终决定由维护者作出。对象为提交 `5b02616`（master `17d4002` 之后的11个提交），验收开始时工作区干净。验收期间只运行检查和阅读代码，未修改源码、测试、配置或依赖；本条及状态文档更新在维护者决定后提交。

环境：Windows，Node 24.22.3，pnpm 12.23.0；resume-studio项目九个容器保持运行；维护者自行启动的原生Qdrant在6333监听。

本次实际执行：

| 检查 | 结果 |
|---|---|
| `pnpm run typecheck`、`pnpm run lint` | 通过，零警告 |
| `pnpm test` | 45通过、0失败、0跳过，5.5秒 |
| `pnpm run openapi:check` | 通过，产物与运行时Schema一致 |
| `db:status`、`db:validate` | 7条迁移均已应用，Schema有效 |
| 远端CI | 通过GitHub API查询，5b02616的“Code and contracts”两次运行均success。分支此前已推送，T9–T10记录中的“未推送/远端CI未执行”自此更正 |
| 默认Docker `pnpm run test:integration` | 85通过、2失败、0跳过，545.6秒；T1–T8、Checkpoint、Langfuse全部通过。失败为Qdrant子用例 `createCollection` 的QdrantClientTimeoutError（子用例6313ms）及其父测试 |
| 原生 `pnpm run test:integration:native-qdrant` | 87通过、0失败、0跳过，542.0秒；原生集合创建2977.6ms |
| 回归后资源 | Docker与原生Qdrant集合均为0；RabbitMQ 4条正式队列ready/unacked均0、连接0；s15–s18运行manifest均cleaned=true；工作区干净 |
| 真实API进程冒烟 | TASK_API_ENABLED=true时随机UUID的GET/取消返回404，非法UUID、未知查询、非JSON及多余字段返回400；false时任务路由404；production、0.0.0.0及非法开关值以CONFIG_INVALID退出1；日志不含请求内容 |

逐项结论：

| 任务 | 结论 | 依据 |
|---|---|---|
| T1–T7 | 通过 | 本次两套全量中各专项均通过；代码复核取消/领取/对账均在执行锁与行锁内提交，fence条件更新拒绝旧token |
| T8 | 通过 | 查询/取消只使用IdentityPort的owner，越权与不存在同为404；stage/计数来自同一Repeatable Read快照；真实Worker清理期间对账返回lock-held，清理后才写CANCELLED；完成与取消经行锁串行，之后旧token的完成和产物写入被拒绝 |
| T9 | 通过 | 生成脚本先扩展Zod再动态导入编译后的同一contracts，API运行路径不加载生成工具；CI含openapi:check且远端通过，过期/缺失检测由本地负向测试证明 |
| T10 | 通过 | 文档描述与实际行为一致；状态记录的推送情况已由本条更正 |
| 完成定义第2条 | 未完全满足 | 默认Docker全量的Qdrant用例失败，原因见下 |

维护者决定：接受S1.4，阶段状态改为“已完成”，以已知环境限制L2记录剩余失败，并推送本条记录。

合并状态：fetch确认5b02616已由PR #2合并到远端master（合并提交736c8d5）。本条及状态文档在feature/s1.4-task-foundation上追加提交并推送；按CONTRIBUTING不直接提交master，需维护者另行合并。合并后按CONTRIBUTING清理已合并的本地分支。

已知环境限制 L2（本机Docker Qdrant集合创建超时）：

- 现象：默认Docker Qdrant的 `createCollection` 超过原5秒客户端限制，`infrastructure.test.ts` 的Qdrant子用例及其父测试失败。T7、T8及本次验收均复现；此前记录的服务端PUT实测为6.98–8.34秒并迟到返回200，精确清理后无残留。
- 判断依据：S1.4代码不使用Qdrant；同一套集成测试改用原生Qdrant后全部通过（本次创建2977.6ms）。项目与Docker数据位于机械硬盘（见[专项排查](research/failure-diagnosis-2026-11-25.md)）。尚未确认物理磁盘、VHD、文件系统同步等因素各自的影响，判断基于对照结果与失败模式，不是逐次证实的根因。L2与只针对API冷启动的L1分开记录。
- 不采取的处理：不调大请求或清理期限，不跳过或放宽CRUD/维数断言，不改用tmpfs、修改WAL/镜像或删除卷，不以原生对照的通过替代默认Docker结果。
- 重新处理的时机：部署到服务器，或本机迁移到SSD、更换满足条件的硬件后，在新环境按S3.3要求连续回归并记录默认Docker Qdrant的集合创建耗时；仍超时则作为配置或代码问题重新定位。已加入[S3.3验收要求](development-roadmap.md#5-后续阶段交付与验收)。
- 对后续开发的影响：本机默认Docker全量只有Qdrant集合创建超时及其父测试失败、集合无残留时，按L2记录，不视为新回归；其他用例失败按正常缺陷处理。涉及Qdrant的后续阶段（S2.3起）需另跑原生对照，或在满足条件的环境中验证。

保留的非阻塞观察：`@prisma/adapter-pg` 把Date参数格式化为不带偏移的UTC文本。`lease_until <= ${now}` 等与timestamptz的比较，以及 `complete()` 中的 `${claim.startedAt}::timestamp`，都依赖PostgreSQL会话时区为UTC。当前容器为Etc/UTC，结果正确，但没有配置固定会话时区，也没有测试断言elapsedMs。后续在涉及部署配置的任务中固定会话时区或记入部署约束。

未执行：重新安装依赖、新机冷安装、服务重启持久化实验、S1.3-T7.5式的连续多轮回归。两套集成测试写入的本轮合成数据已自动清理。

## 2026-11-26 S1.4-T10 文档交接与T8–T10联合回归（分支 feature/s1.4-task-foundation）

状态：T1–T10代码与文档产出已齐备，但默认Docker全量仍有Qdrant超时，未满足路线图“完整回归通过”的完成定义；S1.4保持“进行中”，不自行标为已完成或维护者验收通过。T8–T10按授权一起开发并分开提交，T8=8595adf、T9=8b023cd，T10为本条记录和共享文档收尾；任务编号/依赖/验收不改。未推送、未合并。

本项同步README、架构、测试和路线图交接索引，明确查询/取消的本地开发启用、无锁取消与持锁清理边界、未知旧进程停止证据、OpenAPI产物/CI范围和真实业务未实现项。API/接口契约/部署文档分别随T8/T9同步，依赖说明记录真实registry/官方发布包核验。前端仅只读查看现有规划，未修改其代码或路线图；接口文档与OpenAPI可作为维护者后续前端对接材料。

本批完整验证汇总（runner耗时不含构建，父测试计数在内；每次失败均保留）：

| 顺序/检查 | 实际结果 |
|---|---|
| 分支与基线 | feature/s1.4-task-foundation，从干净b25bfd8开始；AGENTS/CONTRIBUTING/路线图/契约/相关架构及现有实现已阅读，T1–T7保持 |
| 初期编译 | 第一批实现通过；后补SQL故障测试时Prisma扩展客户端与事务端口类型不兼容，构建失败。改用既有测试的Nest provider注入方式后通过，未忽略类型检查 |
| T8真实专项 | 14通过、0失败、0跳过，16.268秒（父10.264秒）；精确清理与连接池关闭通过 |
| T9首次生成 | 失败，静态ESM导入早于Zod扩展；改为先初始化扩展再动态导入同源Schema后生成和检查成功 |
| pnpm test第1次 | 44通过、1失败、0跳过，12.525秒；仅新增空数据库URL配置检查失败，new URL异常未归一化；OpenAPI负向检查和原API/Worker测试通过 |
| pnpm test第2次 | 45通过、0失败、0跳过，4.854秒；修复配置异常转换后通过，原8/10秒入口限制不变，没有以重跑覆盖首轮失败 |
| 依赖安装/冻结安装 | 精确安装生成工具成功，pnpm install --frozen-lockfile成功；仅新增开发生成包及其两项传递解析，运行依赖与既有版本不变 |
| 最终typecheck、Lint | 通过，零警告；构建后无其他功能代码变化 |
| db:status、db:validate | 通过，共7条历史迁移，无pending；本批无Schema/迁移改动，未执行reset或重复迁移 |
| OpenAPI生成/正式check/负向用例 | 同源产物生成成功，pnpm run openapi:check通过；临时过期/缺失文件检查均按预期退出1且不重写，结构/路由/状态和内部字段排除检查通过 |
| CI配置核对 | YAML可解析，openapi:check已注册；通过官方GitHub API核验Action提交与输入，固定40位SHA。仅本地配置验证，远端CI未执行 |
| 非法任务配置真实进程 | 退出1、CONFIG_INVALID、stdout为空且无测试值泄漏；模块hook确认未加载Nest/bootstrap |
| 默认Docker全量test:integration | 85通过、2失败、0跳过，474.248秒；T8父/子14项通过（父6.443秒），T7父/子5项通过（父25.876秒），其余任务/Checkpoint/Langfuse通过；仅Qdrant创建超时及父测试失败 |
| Docker失败核对 | 本轮s12_7bd08a65_d89d_4913_83d2_2951a4826fa1，服务端PUT=6.982165秒、迟到200，精确DELETE=0.415540秒；只读集合残留0，原5秒请求/15秒清理限制和CRUD/维数断言不变 |
| 原生Qdrant全量test:integration:native-qdrant | 87通过、0失败、0跳过，464.416秒；T8父/子14项通过（父8.120秒），T7父/子5项通过（父24.720秒），全部集成通过，原生集合创建1551.9ms |
| 最终资源核对 | T8三轮manifest均cleaned=true；T7累计六轮manifest均cleaned=true。精确Owner/NodeArtifact/合成目标/Checkpoint残留0，业务与Checkpoint池关闭；Docker及原生Qdrant集合均0、待清理manifest=0；RabbitMQ仅4条正式队列/1条策略，ready/unacked与AMQP连接均0，九个项目服务healthy |
| 文档、任务与提交检查 | 本批36个变更文件，9份Markdown中的157个本地链接/锚点有效；diff --check通过；T1–T10任务行逐字未改，原progress历史完整保留；凭证、data、dist、生成客户端未入库，前端未修改 |

原生Qdrant本轮createCollection实测1551.9ms；其整个Qdrant子测试5942.480ms还包括进程归属核验、CRUD和精确清理，不混称创建延迟。原生成功不能覆盖Docker超时，也不能据单次样本确认长期性能或存储层具体根因。Docker仍使用原Compose实例/卷/认证；原生仅为用户授权的显式测试目标，未更改应用默认连接。没有调整超时、WAL、镜像、资源限制、tmpfs或迁盘；该失败不属于仅针对API冷启动的L1。

未执行及原因：远端CI/推送/合并（本轮范围仅本地开发）；前端客户端生成和浏览器联调（前端实现不在本任务）；真实简历/JD/报告、任务创建HTTP、SSE、LLM/业务索引、生产认证与多owner调度、进程监督/多副本/长期负载、其他平台/新机冷安装、备份恢复及服务重启持久化（均非T8–T10范围）。没有新增S2任务或修改原阶段规划。

交接：任务API通过TASK_API_ENABLED=true并加载项目数据库显式开启，只支持development/test和loopback；未运行消费者/对账器时取消仅持久待处理。CANCELLED不证明未知旧进程实际退出，清理资源仍需停止证据。docs/openapi.json是同源生成产物，修改契约后需重新生成并提交；不手改产物。下一步先由维护者审阅S1.4及默认DockerQdrant遗留，再决定验收/环境处理；后续业务阶段仍按原路线图S2.1/S2.2及其阻塞决策推进，本轮没有提前启动。

## 2026-11-26 S1.4-T9 同源OpenAPI生成与过期检查（分支 feature/s1.4-task-foundation）

D8按维护者已确认的@asteasolutions/zod-to-openapi实施；T8已单独提交8595adf，本项继续单独提交，T10统一汇总阶段状态。未改任务规划，不安装第二套生成工具，不向API引入文档生成运行依赖。

- 重新查询npm registry并读取官方发布包README/package.json：9.1.0为当次latest，发布于2026-07-19，未deprecated，peer zod ^4.0.0与本仓库4.6.7相容；没有engines字段，本机Node24.22.3真实执行验证。官方raw GitHub README下载失败，改用已安装官方包内文档，不据失败请求声称取得资料。
- 精确devDependency及锁文件只新增生成包、openapi3-ts4.6.2、yaml2.9.1；运行依赖和既有开发版本不变，strict peer/engine检查保留。官方包文档支持Zod扩展/registry/OpenApiGeneratorV31；生成脚本只在独立进程初始化扩展并动态读取编译后的同一contracts。
- openapi:generate构建并写docs/openapi.json；openapi:check构建后比较确定性产物，缺失或过期返回非零且不重写。产物为OpenAPI3.1，仅health、任务查询、取消和共用错误，包含任务类型差异、nullable计数/重试/报告和严格结构，不生成规划路由。任意refine/事务状态机仍由运行时验证，文档明确其边界。
- 新.github/workflows/check.yml执行冻结安装、本地诊断配置/Prisma生成、typecheck/Lint/基础测试/openapi:check。通过GitHub官方API核验checkout7.0.1、setup-node7.1.0、pnpm/action-setup6.1.1对应提交及action.yml输入，全部固定SHA；YAML解析与命令存在检查通过。未推送，因此未运行远端CI。
- 更新API/契约/部署和依赖说明，生成产物作为前端后续对接输入。没有改前端代码/任务规划或对外发送消息。

| 检查 | 实际结果 |
|---|---|
| 精确安装 | pnpm add -D @asteasolutions/zod-to-openapi@9.1.0成功，无peer冲突；未升级运行依赖 |
| 冻结安装 | pnpm install --frozen-lockfile成功，锁文件无需重解；为本机已有依赖环境，不等于新机冷安装 |
| 首次生成 | 失败：zodSchema.openapi is not a function。ESM静态导入在extendZodWithOpenApi之前构造了Schema |
| 修复后生成/检查 | 改为先扩展再动态导入Schema，node scripts/openapi.mjs及--check均成功；API运行路径不加载扩展 |
| 过期/缺失负向验证 | 两种临时副本均退出1并报告OPENAPI_STALE，未覆盖副本或正式产物；确定性与真实路由/状态/内部字段排除测试通过 |
| 联合基础回归 | 首次44通过1失败（T8空URL校验，12.525秒），修复后45通过0失败（4.854秒）；OpenAPI两项两轮均通过，失败记录保留 |
| 类型检查、Lint | 通过，零警告 |
| 正式openapi:check命令 | pnpm run openapi:check成功（含构建），产物与运行时Schema一致 |
| CI本地配置验证 | YAML可解析，openapi:check已注册，所有Action为40位SHA；官方action.yml所需node-version/version输入存在，运行时node24 |
| 全量集成 | 同批Docker85通过2失败，新增任务/契约检查通过，已知Qdrant失败保留；原生对照结果见T10汇总 |

未执行/限制：远端GitHub Actions、新机/其他平台冷安装、完整依赖安全审计、前端生成客户端和浏览器联调。CI不启动真实服务，不能替代集成验收；OpenAPI不完整表达跨字段/状态机规则，不能当成生产认证交付。本地提交，不推送、不合并。

## 2026-11-26 S1.4-T8 任务查询与安全取消（分支 feature/s1.4-task-foundation）

维护者授权T8–T10一起开发，任务编号、范围、依赖与验收不改，按任务分开本地提交。T8从干净的b25bfd8继续，未丢弃既有T1–T7成果；实现与专项通过，联合全量的默认DockerQdrant仍失败，阶段不标记已完成。T9生成与T10汇总记录分别追加。

- 新task-api运行时Zod契约、TaskController/TaskQueryService/TaskQueryRepository及独立TaskApiModule。GET按可信IdentityPort限定owner，在同一Repeatable Read事务读取任务和最新事件，返回真实stage、已保存completed/planned（未知total=null）、累计attempt、retryAt、安全任务错误、reportId和cancelRequested；两类任务状态区分，JOB_INDEX无PARTIAL，不返回输入、owner、fence或图线程。
- POST取消要求application/json空对象，无查询参数；行锁事务只保存cancelRequested并返回202，非终态重复请求仍202。所有终态返回409 INVALID_STATE；越权与不存在都404。完成与请求取消竞争同一任务行锁；数据库错误安全500，不返回伪成功。
- 消费领取/对账在执行锁内完成取消：增加fence、清除租约/重试时间、结束attempt记账及RUNNING收据、写单调seq取消事件，不创建新attempt/dead消息或清空Outbox。运行中的处理器先在心跳/提交边界中止，实际清理收束后才由当前领取身份取消；未收束仍沿用T7未知停止规则。无锁取消优先于未来retryAt/租约期限，持锁时对账延后；终态及迟到旧token不能覆盖。原T6“取消暂时跳过”断言改为新取消行为，持锁/owner/行锁等断言保留。
- TASK_API_ENABLED默认为关闭，只在显式true时动态导入任务模块；启用仅允许development/test、loopback监听和既有本机项目业务数据库。配置错误仍在Nest加载前失败，根.env示例补开关；API只依赖PostgreSQL，消费者/图/观测不自动启动。生产身份/创建HTTP仍未交付。复用原数据库字段，无迁移或新Docker服务。
- 同步接口文档与契约；前端目录只读核对发现尚无src实现，api-integration.md已有INVALID_STATE及未知code兼容规则。本次为新增接口，无破坏性规划调整；未修改前端、未对外发消息，契约交接通过本分支API文档完成。

| 检查 | 实际结果 |
|---|---|
| 初期类型检查/构建 | 首批实现通过；补充故障测试后Prisma扩展客户端不满足TransactionDatabase回调类型，构建失败；改为现有测试的Nest provider注入方式后构建通过，未加类型断言或忽略检查 |
| T8专项真实HTTP/PostgreSQL/子进程 | 14通过、0失败、0跳过，16.268秒（父10.264秒）。覆盖两类查询/重复取消/重试取消/完成竞争、owner和请求校验、只读DB、真实SQL错误回滚、实际Worker清理期间持锁后CANCELLED/DONE；精确清理及池关闭通过 |
| 联合工作区pnpm test第1次 | 44通过、1失败、0跳过，12.525秒；新增任务配置用例失败，空URL在refine中触发new URL异常，未转换成ConfigValidationError。原API/Worker限制不变，OpenAPI检查通过 |
| 配置修复后pnpm test第2次 | 45通过、0失败、0跳过，4.854秒；URL解析异常安全转为校验失败，未放松端点/账号限制 |
| typecheck、Lint | 通过，零警告；本轮新旧API原8秒/10秒限制不变 |
| db:status、db:validate | 通过；7条历史迁移均已应用，Schema有效，本任务无新迁移，未重复执行无变化的部署 |
| 非法任务配置入口实际模块探测 | 缺失/非法DATABASE_URL时退出1、stdout为空、CONFIG_INVALID且不泄露测试值；module hook证明未加载Nest/bootstrap |
| 默认Docker完整test:integration | 85通过、2失败、0跳过，474.248秒；T8父/子14项全部通过（父6.443秒），T1–T7/Checkpoint/Langfuse均通过；失败仅Qdrant创建超时及父测试 |
| Docker失败/残留诊断 | 本轮s12_7bd08a65_d89d_4913_83d2_2951a4826fa1服务端PUT=6.982165秒（迟到200），精确DELETE=0.415540秒，集合残留0。保留原5秒限制，不把失败归入API冷启动L1 |
| 原生对照及最终联合检查 | 结果统一见随后T10批次汇总，不用替代实例结果覆盖Docker失败 |

未执行：真实业务报告/索引/模型、任务创建HTTP、SSE、生产认证、多主机/长期负载、取消后外部副作用撤回、资源删除、常驻进程监督及远端CI。CANCELLED表示业务写入被隔离，不证明任意未知旧进程已退出；没有消费者/对账器时202可能保持待处理。部署须统一更新消费者/对账器；回退保留flag/记录，旧T7代码不能自动完成新取消请求。没有修改服务、存储、超时或重置资源；未推送、未合并。

## 2026-11-26 S1.4-T7 Checkpoint与业务fence联合隔离（分支 feature/s1.4-task-foundation）

状态：T7实现及真实故障专项通过；默认Docker全量仍有Qdrant创建超时，S1.4保持“进行中”，未标记维护者验收通过。按维护者授权使用原生Qdrant另跑同一套完整集成，其结果与Docker分别记录。任务规划不改，T8–T10未实施；D8决定已单独保存为1a4ebe9，T7实现、对照工具与本记录按T7本地提交，未推送、未合并。

实现与范围：

- 在T6的session advisory lock基础上增加TaskAttempt.executionStoppedAt；实际处理器及其资源收束后才记录停止。中止后最多观察5秒，仍未结束则销毁锁连接，不提供虚假的停止证据。confirmWorkerExit只允许可信调用方绑定的子进程已实际退出；发送kill、锁丢失、心跳超时或AbortSignal均不能替代确认。
- 新领取时读取上一attempt：无法确认旧执行停止，则与租约/fence更新同事务递增graphGeneration并分配新activeGraphThreadId；确认停止才保留thread。新增SQL trigger约束图代次单调及thread一同变化。对账仍只恢复调度，不读取或复制官方Checkpoint表。
- 新NodeArtifact按owner/type/task、节点、冻结输入哈希、componentVersion/schemaVersion组成唯一operationKey；读写核验当前租约/fence/generation、期限/取消及适用的图身份，复用已提交合法产物。SyntheticIndexTarget仅作为合成目标，发布同时匹配执行权和jobVersionId/embeddingVersion/indexVersion；没有提前实现Job/JobVersion、报告或Qdrant业务索引。
- CheckpointTaskHandler使用官方StateGraph/PostgresSaver和sync持久化；有Checkpoint时验证用户状态投影并invoke(null)，缺失时使用冻结输入。两个顺序合成节点产生3和9，完成前核对业务产物，不能仅凭Checkpoint状态标成功。跟踪saver put/putWrites与产物操作，退出时拒绝新写入、等待在途操作和独立池关闭，再允许停止证据成立。
- ConsumerModule支持显式图处理器装配，新增tasks:consume:graph；原普通合成消费模式保留，API/空Worker没有自动装配图或对账器，无新Docker服务。新增迁移202611260004只管理业务表/约束，官方Checkpoint表继续由独立setup管理。
- T7故障测试真实暂停本轮旧Node子进程（Windows NtSuspendProcess/NtResumeProcess）、过期其租约、终止其实际PostgreSQL锁连接，待新子进程在新thread完成再恢复旧进程。官方saver实际迟到写入旧thread，新Checkpoint ID/状态保持不变；旧执行独立尝试的产物/终态写入被拒绝。另测确认退出后的同thread恢复/首Checkpoint缺失重启，以及两个实际索引子进程的新版本目标保护。
- 根据用户提供的D:\qdrant-x86_64-pc-windows-msvc，新增显式test:integration:native-qdrant对照入口与被忽略的本地配置；应用和默认测试仍使用原Docker约束。原生目标核对授权exe真实路径、6333监听PID/启动时间及文件大小/修改时间，清理前复核同一进程。清理manifest记录目标类别/地址和原生进程身份，避免误认成Docker资源；不含API Key。所有原5秒Qdrant请求、CRUD/维数断言和15秒清理对账均保留。
- 同步README、架构、部署、测试与路线图状态说明；未改任务编号/依赖/验收，未改依赖或锁文件。图使用原业务池3连接（其中1条执行锁）及独立Checkpoint池最多3连接，未在事务中等待外部服务。

逐次检查（测试耗时为runner报告，不含构建；父测试计入数量）：

| 检查 | 实际结果 |
|---|---|
| 前置与原生只读探测 | 从T6提交d21dc9f继续；读取AGENTS/CONTRIBUTING/路线图/架构及历史失败诊断。原九服务保持运行。原生exe路径符合用户授权，HTTP 6333、gRPC 6334，readyz返回200；版本1.20.2，commit=23065a0bf6857c3e5da45f6c8939cc746cc0580e，本次无需API Key |
| 原生基础设施专项第1次 | 0通过、1失败，21.406秒；Windows PowerShell归属脚本的Get-FileHash不可用，未进入集合创建；没有用测试跳过代替归属检查 |
| 原生基础设施专项第2次 | 4通过、0失败、0跳过，29.795秒（父17.801秒）；改为Node文件元数据+真实路径/进程身份核对后通过。Qdrant子用例9.606秒包含核验、CRUD及清理，不能称为集合创建延迟 |
| db:generate、PostgreSQL归属核对、首次db:deploy | 通过，应用202611260004；保留旧迁移、业务数据和独立Checkpoint表 |
| 初期编译/执行 | fixture额外execute实参和循环ReturnType定义导致编译失败；改为正确调用及明确Worker类型后通过。一次在编译未成功时尝试执行专项，因缺少编译文件未执行测试；不计为通过 |
| 初期Lint | 先后发现finally直接throw和AggregateError缺少cause；调整错误/收束流程并保留原错误cause，后续通过，未禁用规则 |
| T7真实故障专项第1次 | 2通过、3失败、0跳过，32.765秒（父27.849秒）；迟到saver写入未发生、同thread续跑失败，另两个子场景通过；本轮精确记录和thread均已清理 |
| T7真实故障专项第2次 | 5通过、0失败、0跳过，30.114秒（父28.732秒）；修复在途写入收束和用户状态投影后通过 |
| pnpm test第1次 | 42通过、0失败、0跳过，9.657秒；原API/Worker超时和断言保留，L1未复现 |
| 审阅补充及typecheck/Lint | 增加合成完成前两个业务产物校验；新版本索引执行改为真实子进程。类型检查和Lint通过；后面的两次全量覆盖这些修订 |
| 重复db:deploy、db:status、db:validate、schema diff | 无pending，共7条迁移已应用；validate通过，Prisma结构diff无差异。CHECK/trigger仍由实际集成断言验证，未以schema diff替代 |
| 默认Docker完整test:integration | 71通过、2失败、0跳过，490.382秒；失败仅为Qdrant创建超时及其父测试。T7父/子5项全部通过（父27.814秒），其余Checkpoint、Langfuse、T1–T6均通过 |
| Docker失败后的只读核对 | 本轮集合s12_1a049a64_bcf7_4530_9705_bf6ecba52cfd服务端PUT=8.335798秒、迟到返回200，随后精确DELETE=0.723453秒；集合总数及s12_*残留均0，待清理manifest=0 |
| 清理目标元数据补充 | 审阅发现原清理manifest默认指向Docker，新增target字段区分原生进程并保持旧manifest兼容；归属拒绝测试断言“不删除并保留正确实例证据”。默认全量运行于此元数据补充之前，后续基础测试及原生全量覆盖最终修改 |
| pnpm test第2次（最终代码） | 42通过、0失败、0跳过，5.290秒；含停止前等待执行收束和两种目标清理记录断言，未放宽任何原限制 |
| tasks:consume:graph装配/空会话 | 已确认正式队列为空后运行；真实Nest装配成功，60秒期限后received=0、acknowledged=0、reason=deadline，退出0。只证明命令装配/关闭，图执行证据来自真实子进程集成 |
| 原生Qdrant完整test:integration:native-qdrant | 73通过、0失败、0跳过，536.536秒；同一套集成文件全部通过，T7父/子5项通过（父34.338秒）。Qdrant创建4581.3ms；原断言、兼容性检查及超时均保留，原Docker认证配置未改 |
| 最终typecheck、Lint | 均通过，零警告；未新增依赖/关闭规则 |
| 默认目标与原生目标只读复核 | 默认分支仍是docker、http://127.0.0.1:56333并通过Compose归属核验；原生仍是授权目录进程，集合总数及s12_*残留均0 |
| 最终资源与文档检查 | 4轮T7 manifest均cleaned=true，精确Owner/NodeArtifact/合成索引目标/Checkpoint残留均0，双池关闭；Docker与原生集合均0、待清理manifest=0。RabbitMQ仅4条正式队列/1条策略，ready/unacked及连接均0，九服务healthy。26个变更文件及103个本地链接/锚点核对，diff检查通过；本地凭证、data、dist及生成客户端被忽略，任务表定义与依赖版本/锁文件未变 |

首轮T7失败的原因与修复：仅等待graph.invoke或pool.end不足以确认延迟saver操作已结束，abort后调用可能已返回而屏障中的put尚未真正进入数据库，过早关闭池会取消应验证的迟到写入。现实现显式跟踪在途saver/产物操作并收束，再形成停止证据；最终测试确实观察到旧thread的迟到Checkpoint。同thread续跑的另一失败是把LangGraph内部channel_values整体当成严格用户Schema校验，现只提取/验证用户状态，保留任务与输入身份检查，没有放松业务输出Schema。后续通过不覆盖这两次实际失败。

Qdrant对照结论：最终原生实例集合创建实测4581.3ms，处于原5秒限制内但余量有限；整段Qdrant子测试8378.965ms包含进程核验、CRUD和清理，二者不混用。Docker本轮创建8.336秒超时，原生本轮通过支持继续排查Docker/持久化路径差异，但单轮不能证明原生长期稳定，也不能确认物理磁盘、VHD、文件系统同步或其他I/O的具体占比。没有迁盘、修改WAL/镜像、关闭服务或改tmpfs；存储性能处理仍需独立安排。该失败不归入只适用于API冷启动的L1，不能以替代实例通过宣布默认Docker回归已修复。

未执行及遗留：T8查询/取消API、T9 OpenAPI安装与生成、T10阶段整体收尾；真实报告/JobVersion/索引/LLM、常驻进程监督、跨owner调度、多副本/长期负载、生产硬件/TLS/备份恢复、其他操作系统、服务重启持久化及新机冻结安装（依赖未变）。没有运行S1.3-T7.5规定的旧阶段连续验收批次，本轮按S1.4-T7及授权对照范围执行。停止未知时可能重做未提交图内工作，不能保证外部模型调用恰好一次；全链路图观测仍未接入。默认DockerQdrant超时仍是已知未解决问题；S1.4后续仍按原规划T8、T9、T10继续，当前不推送、不合并。

## 2026-11-26 S1.4-T9 前置决策D8确认（尚未实施T9）

维护者明确选择 `@asteasolutions/zod-to-openapi`，由现有Zod契约生成OpenAPI。仅记录工具决定，不安装依赖、不改接口行为；T9实施时再核对当时版本/engines/peers并编译验证。任务编号、范围、依赖和分任务提交安排保持原规划。本轮另外授权开始T7，并授权对照测试维护者自行启动的原生Qdrant（D:\qdrant-x86_64-pc-windows-msvc）；其结果单独记录，不覆盖既有Docker回归历史。

## 2026-11-26 S1.4-T6 定时对账与持锁执行保护（分支 feature/s1.4-task-foundation）

状态：S1.4保持“进行中”。从干净的T5提交4fb15a2继续T6；范围为任务/Outbox定时扫描、恢复调度与不抢占持锁执行，未开展T7图恢复。T6专项通过，全量回归仍有既有Qdrant失败；本任务与记录整理为本地提交，未推送、未合并。

实现：

- 新ReconciliationModule/Store/Service与 `tasks:reconcile once|watch`；默认每类10条候选、UUID游标分页回绕，扫描过期RUNNING和超过120秒未完成的QUEUED/RETRY_WAIT，不漏掉因锁阻塞前面任务而排在后面的任务。修复事务逐条短执行，之后再调用既有Outbox发布器；输出pending/due/failed和最老事件时间。
- 为T6“持锁不抢占”补齐最小消费执行锁：PostgresExecutionLock从原3连接池借专属session连接，键由固定命名空间及owner/type/task确定；消费者从拿锁到本次数据库处理结束保持它，对账使用同键transaction advisory lock再SKIP LOCKED锁任务。有效执行、行锁、取消、未来retryAt、终态和非本owner跳过；锁连接丢失Abort，不将带锁连接归还池。
- 过期无锁RUNNING事务结束旧attempt并累计elapsedMs，可靠结束旧代次RUNNING收据、递增generation/fence/recoveryCount，置QUEUED并同事务创建新恢复messageId Outbox与TaskEvent。保留taskId、冻结输入、所有预算及graph线程字段；晚到旧token被拒绝。并发对账只恢复一次，SQL失败全部回滚。
- 缺本代调度或已confirm但长期仍无执行的任务恢复调度；当前未发布或失败事件保留原T3退避/租约/预算，不重置，不靠创建新代次绕过failedAt。已有恢复消息仍待投递时，即使恢复次数达到上限也继续等待；真正再次需要恢复且recoveryCount达默认3次，或执行次数/总期限耗尽时复用T5 FAILED/dead事务。
- watch立即执行、完成后间隔10秒，轮次不重叠；单轮60秒期限和既有数据库/发布期限，连续3轮数据库/修复错误停止。单任务异常分类汇总为error，不输出原始SQL/输入；新候选仍可继续。命令固定开发owner，未接入跨owner调度或API/空Worker自动启动。
- 新迁移202611260003仅加recoveryCount非负列与扫描索引，未改旧迁移/Checkpoint库；无依赖或镜像变化。消费者fixture统一使用真实锁，纯单元测试使用明确标注的无锁测试端口。更新部署、测试、架构、README和路线图，注明不能混跑无锁旧消费者与新对账器。

逐次验证（test runner耗时不含构建）：

| 检查 | 实际结果 |
|---|---|
| 开始状态/前置 | feature/s1.4-task-foundation干净，HEAD=4fb15a2；九个项目服务healthy；阅读AGENTS/CONTRIBUTING/路线图和相关架构/实现 |
| db:generate及初期build | 通过，使用原Prisma与依赖；没有新增包 |
| PostgreSQL归属及首次db:deploy | 通过，新增T6迁移；未reset或删除资源 |
| 独立T6真实集成专项第1次 | 11通过、0失败、0跳过，40.014秒（父37.108秒）。含两类恢复+实际消费、并发对账、真实持锁子进程不抢占/强杀后恢复、锁连接终止、行锁/owner/取消隔离、原发布预算、缺投递/恢复上限、只读DB/SQL回滚；精确资源清理、池连接0 |
| 首轮Lint | 通过，零警告 |
| 审阅补充 | 修正恢复次数上限与尚待投递事件的顺序：本代仍pending时不提前FAILED，增加对应真实断言；不改既有限制 |
| pnpm test第1次 | 41通过、0失败、0跳过，12.388秒；原API/Worker启动/关闭与8秒限制保留，L1未复现 |
| typecheck、最终Lint | 通过，零警告 |
| 第2次db:deploy、db:status | 无pending，共6条迁移已应用 |
| db:validate、schema diff | 通过，无结构差异 |
| tasks:reconcile once | 真实Nest装配成功，开发owner扫描为空，publications=[idle]、pending/due/failed=0，退出0 |
| tasks:reconcile watch | 真实子进程连续2轮扫描，收到私有IPC shutdown后按与SIGINT/SIGTERM共用的stop路径退出0，无stderr；不等于Linux信号实测 |
| 初步文档/变更检查 | 26文件、51个本地链接目标有效，git diff --check通过；依赖/锁文件无变化 |
| 完整test:integration | 66通过、2失败、0跳过，471.452秒；T6父/子11项全部通过（父49.756秒），T1–T5、Checkpoint、Langfuse均通过；仅Qdrant创建超时及父测试失败 |
| 收尾元数据修正及独立T6专项第2次 | 对账终结但没有原投递/收据时，不新建伪消费收据，dead.originalMessageId=null；新增断言。修正后build通过，T6 11通过、0失败、0跳过，41.913秒（父41.207秒），精确资源清理/池关闭通过；完整回归是在该元数据修正前开始，修正后只针对受影响的T6及基础/静态检查复验 |
| pnpm test第2次（最终代码） | 41通过、0失败、0跳过，12.827秒；原API/Worker断言及限制不变 |
| 最终typecheck、Lint | 通过，零警告 |
| 最终资源核对 | 三轮T6 manifest均cleaned=true；RabbitMQ只保留4条正式队列和1条正式策略，ready/unacked均0，AMQP连接0；Qdrant s12_*残留0 |
| 最终文件检查 | 28个修改/新增文件、97个本地链接目标有效，diff检查通过；凭证、data、dist及生成客户端均被忽略，依赖/锁文件未变 |

边界与观察：首轮专项通过后审阅发现pending恢复事件达到恢复次数上限不应提前失败，已修正并纳入最终完整回归；这是本批实现边界调整，不是放宽验收。T6只恢复调度，未读取Checkpoint或推测SUCCEEDED；持锁子进程试验是合成执行，不把它当成T7旧图/线程/saver迟到写入验证。session锁占用原池一条连接，当前每个consumer命令最多一个活动任务，增加进程内并发前须重新核算池容量。

完整回归仍有既有Qdrant集合创建超时：本轮 `s12_91ef2918_a7ac_48d2_a7fc_d61b1b584ddc` 服务端PUT耗时5.436763秒，超出未改的5秒客户端限制；随后精确DELETE成功（0.070312秒），只读核对s12_*残留0。Langfuse本轮通过。未修改Qdrant/API/观测超时，未关闭服务或改tmpfs；存储性能处理仍需单独安排，不能用T6专项通过覆盖全量失败。

未执行/限制：T7 session锁与LangGraph/Checkpoint联合恢复及新thread切换、T8任务取消/查询API、T9 OpenAPI、真实报告/索引/LLM、跨owner授权、后台进程监督、多副本容错、长期负载/生产硬件、容器重启及新机冻结安装（依赖无变化）。锁断开无法证明任意旧图已停止，T6不提供图恢复保证；未自动重置failed Outbox，不新增人工恢复接口。现有API/空Worker入口仍未自动装配对账器，需要显式watch命令。未推送、未合并。

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
