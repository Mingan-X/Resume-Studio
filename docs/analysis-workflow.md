# S2.4 分析图与语义产物

当前实现包含S2.5评分与S3.1报告：带scoringPolicyHash的任务在MATCH后执行SCORE→RANK，JOIN等待画像和排名；新reportVersion=1任务通过SAVE与消费完成事务提交报告。历史快照保持对应原图/幂等身份。政策、资格与重算见[评分说明](scoring.md)，报告/SSE见[报告说明](reports.md)。本文的语义处理说明继续适用，临时FINALIZE只用于历史任务。

当前提供真实分析输入、业务图、语义抽取、六维画像、冻结召回、逐项匹配、确定性评分排名和报告终态。执行模型和embedding经明确配置的端口注入；本地工程验证只使用测试注入的确定性模型/向量，不证明真实模型质量。真实调用T9及正式Rubric审核按[路线图](development-roadmap.md)统一验收延后。

## 图、恢复与产物

主图为LOAD→PARSE→EXTRACT→VALIDATE，随后PROFILE与RECALL并行；召回经SNAP→MATCH→SCORE→RANK后与PROFILE在JOIN汇合，SAVE保存汇总意图。消费完成处理器同事务提交报告、任务终态、attempt结束和DONE收据；只有可靠提交后才允许ACK。历史无reportVersion输入仍使用临时FINALIZE且reportId可为null。

LOAD核对冻结corpus/Rubric/hash和已配置版本，PARSE读取授权简历版本的已存ExtractedDocument，不重新解析文件。GraphState只保存任务/input hash与节点产物ID或安全失败状态；官方PostgreSQL Checkpointer使用durability=sync，不把连接、Buffer、原始异常或原文件塞入图状态。

NodeArtifact的operationKey覆盖owner、taskType/taskId、node、branchKey、inputHash、component/schema/prompt/model版本；不含attempt、fence和thread代次。当前主图节点branchKey=root；岗位/要求分支通过MatchPlan及逐项业务键隔离。所有读写需活fence、租约、generation、graphThread、graphGeneration、取消/总deadline及完整输入快照一致。真实节点产物禁止原地更新。

恢复沿用S1.4：已确认旧进程及其写入停止才可复用原thread；未确认时新建thread，从冻结输入及已提交产物恢复。节点先查数据库产物，Checkpoint完成后再次核对每个业务产物；不能仅凭Checkpoint宣称任务成功。模型和Checkpoint调用不在业务事务内等待。已开始的有界写入和saver连接排空后才标记执行停止；外部模型不承诺恰好一次。

## EXTRACT 与日期

抽取输入只来自授权版本文本块，先等长遮盖联系方式，保留UTF-16引用区间。prompt将简历内指令视为数据；Schema拒绝未知字段/分数，每个条目sourceRefs经S2.1逐字/owner/版本/区间校验，还需与遮盖后的文本一致。缺失字段为null/空数组。最多一次受控修复，失败不保存抽取结果。

ResumeExtraction按owner/resumeVersion/prompt/model/schema唯一并保存输入/输出hash，可跨任务复用，不按taskId重复抽取。跨任务采用会话advisory lock，竞争失败交给既有有界任务重试；不持有数据库事务等待模型。缓存命中仍验证当前任务执行权和证据。新prompt或模型配置须使用新版本，不能同版本更换实现。

日期计算使用冻结asOfDate。只有年份的日期不补月份；明确“仍在职”且无结束日期才使用asOfDate。重叠任职区间合并，起止月采用半开月区间，knownMonths是按已知年月区间计算的月份值，不表示精确到日的任职时长；反向、未来、冲突或缺月日期计入incompleteIntervals。EXTRACT保留原结构化日期，按任务计算归一化结果，避免不同asOfDate污染共享缓存。

## PROFILE

画像子图先调用模型判断，再校验并按完整Rubric等级映射分数。六维必须完整且唯一；assessed必须有等级、合法featureIds、同维度/等级的rubricRefs和逐字证据，unknown的level和计算分数均为null。模型不能直接给score；分值由已冻结Rubric映射。ProfileAssessment绑定任务、extraction、rubric版本/hash和输入hash，不用于替代岗位逐项verdict。

## 召回、MATCH 与预算

RecallQuery由经验证ParsedResume的技能、职责和项目描述生成并脱敏，不读取其他简历或推断城市。只使用冻结corpus和recall/index配置；CandidateSet提交时再次核对真实输入绑定。恢复命中已有候选时只校验执行权并复用，不重新召回。索引未READY或向量失败按原S2.3显式策略失败/降级，降级写入汇总，不伪装正常全量召回。

MatchPlan冻结候选顺序、岗位完整要求、extractionId及全部要求的唯一身份。先按候选顺序、要求priority降序及stableId升序分配最多400条唯一要求；每条要求都保留行，超额为BUDGET，不冒充unknown。分配随计划持久化，重试/恢复不重置。每个已完成判断由(owner,plan,jobVersion,requirementId)约束，PENDING只能一次迁移到DONE/FAILED；终态判断不可更改。

岗位采用LangGraph Send分支，最多并发3；每批最多10条要求。模型输出必须准确覆盖本批所有ID，拒绝重复、未知、缺项、分数或伪造/跨版本证据；批次整体校验后事务保存，不静默删坏条目。分支模型失败保存显式失败要求，数据库/执行权错误不得被部分失败策略吞掉。网络重试、修复和恢复共享[模型预算](analysis-model.md)中的累计预留账本。

明确指标的任职阈值单位支持employment_months/employment_years，使用冻结日期和去重任职月份，由代码执行gte/lte/eq；仅写years/months等无法区分“总任职”与“某技能年限”的单位返回unknown，不猜测业务含义。其他未支持数值指标也保留unknown解释，不交给模型计算。无显式threshold的要求走语义判断；日期未知与证据缺失不能变成unmet。后续新增指标必须按路线图/业务决策明确语义。

## 汇总与进度

AnalysisSummary不是最终报告。SUCCEEDED要求画像可用、召回成功、所有计划要求完成且无显式降级；unknown属于有效判断，零候选允许空结果。PARTIAL要求至少一个板块可用，同时保留失败、截断、pending或降级信息；两个板块都不可用为FAILED。解析/输入失败直接经任务失败路径处理。汇总保存planned/completed/failed/truncated/pending及对应产物ID，五项计数相等校验，不补虚构判断。

TaskEvent记录实际阶段与计数，seq由任务行锁分配；MATCH可记录已完成岗位/候选岗位数，最终记录要求计划/完成/失败数。阶段不同，计数单位可能不同，不能当估算百分比。旧generation/fence事件无法覆盖新执行。SSE与最终报告接口已由S3.1接入，详见[报告说明](reports.md)。

## 本地执行与验证

API配置见[分析输入](analysis-input.md)。Worker需要绝对ANALYSIS_MODEL_CONFIG_FILE（connection/execution同JD模型字段）、JOB_EMBEDDING_CONFIG_FILE及现有业务/Checkpoint配置；真实Key不入库。Worker先校验模式、开发身份和配置再加载运行模块，不自行配置Checkpointer表。固定开发身份禁止production。

```powershell
pnpm run tasks:consume:analysis
pnpm run analysis:reconcile reconcile-once
pnpm run analysis:reconcile reconcile-watch
```

消费命令一次处理最多1条、会话总窗口600秒；Worker同时运行1个分析，岗位分支并发3。未匹配embedding/model版本的任务保留待执行，不花attempt预算。命令需由本地维护者显式运行；不启动付费调用，不把假模型注册为默认实现。

单元验证见analysis-extraction、analysis-model、analysis-graph、profile-matching及analysis-runtime-cli。真实数据库抽取共享缓存、图子进程崩溃/线程切换、真实Qdrant工程链路和临时终态见integration/analysis-extraction、analysis-graph、analysis-runtime。恢复子进程中的节点是显式fixture，不声明真实模型恢复已验证；完整链路也仅是工程假模型验证。测试只清理manifest精确owner/thread/集合，先核验本项目资源归属。逐次结果及未执行项见[进度](progress.md)。
