# JD与Rubric契约

S2.2已实现岗位/要求/Rubric持久化、确认发布、JD建议及本地HTTP，阶段回归结果见[进度](progress.md)。真实模型与embedding验证延后，不将HTTP桩或固定样例当作真实服务验证。

六维ID按需求§2顺序为 `technical_depth`（技术深度）、`engineering`（工程能力）、`business_understanding`（业务理解）、`project_impact`（项目影响力）、`collaboration`（协作沟通）、`growth`（成长性）。契约来源为 [jobs.ts](../src/contracts/jobs.ts) 与 [rubric.ts](../src/contracts/rubric.ts)。

JD正文采用 `text-v1`：CRLF/CR转LF，然后NFC；不裁剪正文、折叠空格或移除换行。`jd-text-v1`将完整正文保存为一个TEXT块（paragraph=0），最多200,000个UTF-16 code unit。块ID由版本ID、chunker版本及归一化正文确定；正文修改产生新块身份。正文SHA-256为UTF-8编码的归一化文本哈希。后续向量分块独立于此证据块，不改写引用身份。引用使用S2.1的UTF-16半开区间及逐字quote校验，拒绝截断代理对、跨owner、版本、来源或块；sourceType必须为JD。

要求stableId在版本内唯一，新版本复制时保留stableId，sourceRef改绑新版本并重新校验。threshold显式为null或operator/value/unit，不从描述静默推断。priority为非负整数，weight为显式有限非负数；0权重不移除判断或硬门槛。草稿允许空要求；发布至少一条要求、硬门槛和权重均已确认。六维权重必须完整且唯一；参与计算的维度总权重>0，每个有效维度的要求权重之和>0，累加溢出也拒绝。不对缺项补默认值。六维等权是D7的正式策略，服务创建草稿时将显式写入版本。

Rubric必须完整包含六维及各自L1–L5，featureId全版本唯一。每级有行为、证据门槛及映射分值。SYNTHETIC/TEST_ONLY不能作为正式版本；正式v1由T6起草，AI_DRAFT/PENDING_REVIEW标记保留到维护者审核。版本内容哈希与不可变存储在T2/T5实现。

索引快照用kind区分synthetic与job-index，真实快照保留owner、岗位版本、正文/要求哈希、embedding/index/chunker/component版本及预算。S2.3真实处理器接入前，消费者在领取尝试前返回deferred并关闭会话，不ACK、不增加attempt或预算；对账器不对这种等待生成恢复任务。取消及终态/旧代消息仍按既有持久收据规则处理。合成执行、产物写入、索引目标发布及完成入口均拒绝真实快照。真实索引尚未执行，不标READY；共享队列遇待执行真实任务会结束该消费会话，避免无界热重投。

T2迁移新增Job/JobVersion/JobRequirement/RubricVersion，岗位与Rubric按owner读取；JD文档及要求JSON读取时经同源Schema、引用和哈希校验。要求保存独立行，以jobVersionId/stableId唯一标识，ordinal保存明确顺序。版本身份不可变，PUBLISHED版本只允许变更indexStatus；要求INSERT/UPDATE/DELETE都先锁所属版本，已发布则拒绝，父版本整体删除可级联清理要求（生命周期权限与执行器由S3.2实现）。Rubric内容禁止原地UPDATE，修订必须新version。

T3草稿服务从可信IdentityPort获取owner，创建时显式保存D7的六维等权；不创建索引任务。正文/元数据/要求增删改/权重编辑都在版本锁内完成并重置确认标记。编辑已发布版本先锁岗位分配新的连续版本号，复制正文和stableId，将来源重绑到新版本相同文本的准确区间，再执行本次修改；历史版本不变。正文编辑仅允许引用原区间逐字仍成立的要求，绝不猜测新位置；改变已引用文字或使区间位移时返回JD_EDIT_INVALIDATES_REQUIREMENTS并回滚，用户须先明确删除或替换相关要求。HTTP错误映射与路由已由T9接入，详见[HTTP API](api.md)。

真实索引关联使用可空real_job_version_id与owner复合外键，并以CHECK绑定kind和原job_version_id；synthetic必须为空，job-index必须匹配。INSERT还核对版本已发布及JD正文哈希，旧合成UUID不追加外键。发布事务见T4说明。迁移仅增加表/列并扩展检查，不删除既有数据；回滚应用需保留迁移和已发布内容，修正数据结构采用后续前向迁移，不通过drop表/库或重写已应用迁移回滚。

T4发布服务要求显式确认硬门槛和权重，再次校验要求及有效权重；未配置当前索引目标返回JOB_INDEX_TARGET_UNAVAILABLE，不伪造目标。一次事务完成PUBLISHED/内容哈希、真实JobIndexTask、JobIndexTarget和job.index.requested.v1 Outbox；任一写入失败全部回滚。owner/key与publish-job-v1/versionId绑定，同请求返回原versionId/taskId，不同版本409；重放继续使用首次冻结的目标，不随配置变化重建任务。岗位正文及要求哈希在输入快照中独立保存。

当前目标表受owner/版本/任务复合外键及目标匹配触发器约束。索引READY提交必须持有当前fence/lease并命中该版本的当前task/embedding/index目标；新版本或同版本切换目标后，旧执行不能标记新目标。默认消费者只具备synthetic能力，S2.3才装配真实处理器；T4专项显式领取真实任务仅验证数据库fence，不代表完成向量索引。HTTP确认/发布接口已由T9接入；真实索引执行仍待S2.3。

T5提供 `pnpm run rubric:import <owner UUID> <JSON文件路径>` 与 `pnpm run rubric:load <owner UUID> <version>`，先运行build并使用项目infra/.env。命令核对本项目PostgreSQL归属，不创建owner；正式导入拒绝SYNTHETIC。文件上限1MiB，错误只返回安全code。版本与内容哈希幂等绑定，同内容重放不再插入，内容不一致必须用新版本。RubricService加载时先校验整个版本完整性，再按维度返回全部五级，不依赖Qdrant检索；测试须显式allowSynthetic且不会注册任何默认版本。当前owner范围是开发身份与后续会话身份的同一边界。

T6的rubric-v1已导入开发owner，六维30级逐项读回及重复导入验证通过；内容仍为AI_DRAFT/PENDING_REVIEW，审核不在导入时伪造完成。

T7的ModelPort使用LangChain消息与Zod结构化输出，ModelExecutor统一管理单次/总期限、最大尝试与重试、分类指数退避+jitter、token/费用预留及并发；一次格式/引用修复也消耗同一预算。UTF-8字节上界检查约束输入，可信usage超出预留即失败；缺usage或失败调用不能把费用填0。取消未实际结束的调用保留并发槽，不允许重试与旧调用重叠；持久预算reserve接口供S2.4接入任务fence，当前JD请求使用本地预算，不声称重启后跨请求预算已持久化。

JD建议只读取可信owner的草稿版本，在数据库读取事务结束后调用模型，不保存建议或改变确认状态。提示明确正文中的命令仅是数据，输出不能包含总分；返回inputHash/promptVersion/modelConfigVersion/schemaVersion供后续确认核查。每条引用须逐字匹配授权正文和发送的脱敏正文；联系方式等长遮盖以保留UTF-16偏移，覆盖常见邮箱/电话/URL/标签字段，不承诺识别任意隐写个人信息。失败只暴露ModelFailure安全码。观测使用既有白名单ObservabilityService的extract span，不记录模型输入/原始异常；无真实模型配置时明确UNAVAILABLE，测试假模型不装配到生产入口。
