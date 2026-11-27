# 冻结候选集合

S2.3-T6按[路线图](development-roadmap.md)实现内部CandidateRepository，检查结果以[进度](progress.md)为准；尚未接入S2.4真实分析图，不新增HTTP接口。

CandidateSet以AnalysisTask唯一关联，content包含owner/task、脱敏RecallQuery、corpusVersion/hash、完整indexSpec、召回参数与降级原因、候选顺序和各路来源rank；内容按规范JSON哈希验证。Candidate逐行保留相同候选，数据库约束unique(setId,jobVersionId)和unique(setId,rank)，owner/task/corpus/jobVersion均有复合外键。

freeze要求当前analysis执行claim，在事务内锁任务并校验RUNNING、generation、fence、lease、cancel、graph线程/代次和deadline。读取冻结corpus并核对hash，锁候选发布版本防止并发删除，通过后同事务写BUILDING集合、候选行、FROZEN标记。提交前再核对期限；没有外部模型/向量调用，也不重置任务预算。部分SQL失败回滚整个集合。

数据库触发器只允许BUILDING→FROZEN且内容不变，冻结时核对候选行与JSON快照完全一致。FROZEN集合不能UPDATE，成员不能追加、修改或单独删除；删除集合时才级联删除成员。删除服务在S3.2实现，不能把数据库提供DELETE当作已交付生命周期政策。应用回退可保留新增表，不需要删数据库/卷。

相同task与内容重放返回同一setId，内容不同拒绝；过期fence或取消不能写入/重放提交。load按owner/task返回已冻结内容并逐项校验哈希和行快照，供图恢复复用而不重新召回。空候选也可冻结，不能补假岗位。同一owner可以用新AnalysisTask重新召回；旧集合不会随新岗位或字典版本变化。

本阶段测试使用已有合成AnalysisTask建立真实数据库租约/fence，验证存储与隔离，不冒充业务分析图已完成。真实输入的resume/corpus/model版本绑定由S2.4创建服务与SNAP接线进一步约束。测试入口：[数据库冻结与故障边界](../test/integration/candidates.test.ts)。
