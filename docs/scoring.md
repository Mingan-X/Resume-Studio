# 确定性评分与排名

S2.5实施中，当前检查与实现状态见[进度](progress.md)。本阶段只计算冻结的岗位要求和逐项判断，模型不参与总分、阈值、资格、排序或调权重算。

## 政策与输入

ScoringPolicy按owner/version存储，内容经Zod及SHA-256验证，首次导入后禁止UPDATE；同版本不同内容拒绝，修改须新版本。政策包含六维权重、冻结岗位的要求相对权重策略、verdict整数基点系数、unknown/未完成数值语义、硬门槛政策及舍入策略。正式默认政策单独发布，不将测试fixture当默认配置。

权重契约要求六维完整唯一、有限非负且总和大于0；要求ID不得重复。对具体岗位评分时还须匹配全部要求ID，并检查参与计算的维度内权重和大于0。输入不能静默补漏、忽略未知ID或负数。0权重只影响贡献，不免除判断或硬门槛。

精确算术把JSON Number的十进制序列化值转为BigInt有理数（包括科学计数法），约分后计算；中间不按浮点或locale舍入。输出保留规范分子/分母字符串，最终显示half-up两位小数，排序使用分数×10^6的整数。有效岗位范围0–100，排序整数不超过100000000。没有新依赖，不修改既有岗位输入允许的十进制权重范围。

2026-11-27维护者补充确认：硬要求partial为pending待核实；候选还有FAILED/BUDGET/PENDING未完成要求时暂不进入Top10，列为pending（已经存在明确硬要求unmet时仍ineligible）；首次评分使用ScoringPolicy的六维权重，默认等权，要求相对权重来自已发布岗位。岗位原dimensionWeights保留在原快照中，但不作为首次评分的维度权重来源。调权重算显式传入完整权重，不覆盖政策或原岗位快照。

## 计算与资格

对有要求且权重大于0的维度先归一化W，再在维度内部归一化P，a_i=(W_d/ΣW)×(P_i/ΣP)。0维度直接贡献0，不访问零分母。分数是100×Σ(a_i×verdict系数)，覆盖率是已知判断的a_i之和×100；upperBound在分数上加unknown和未完成要求的可能贡献。未知判断与未完成要求分开计数并保留原执行状态，未完成不伪造judgment。例P=2/1/1、met/partial/unknown得到62.5、75%、87.5。

未完成要求当前数值贡献0但保留权重分母和上界；其候选为pending，不能通过只算已完成项抬高得分。已知的unmet参与coverage，unknown不参与。没有要求时total/coverage/upperBound为null、ineligible；非空要求且所有参与维度为0是非法权重。每项贡献显示值的和可能因分别舍入与总分相差0.01，审计以未舍入有理数为准。

硬门槛独立于权重：任意硬要求unmet→ineligible；否则硬要求partial/unknown或任意未完成要求→pending；其余有有效要求者eligible。软要求unmet不会自动升级硬淘汰。所有候选都保留分数，按分数六位精度整数降序、jobVersionId字典升序稳定排列，仅eligible选最多10项；不足时明确候选少、ineligible/pending原因，不补数据。

## 冻结、图与恢复

新分析创建须已有当前owner的scoringVersion，校验内容hash后写入快照scoringPolicyHash和复合外键；同key重放仍先读取旧任务。旧S2.4任务没有该hash，保持原graph组件身份及10节点恢复路径，不被迁移为新政策。新任务执行12节点图，在MATCH后SCORE→RANK→JOIN；两步只有普通代码和数据库操作，不调用模型。

ScoreSet保存全部候选的policy、policyHash、judgmentSetHash、精确贡献、weightsSnapshot、覆盖率/上界/资格，原任务只允许一份基础ScoreSet。RankingSnapshot按scoreSet唯一保存完整顺序与Top10。两者不可UPDATE，恢复时相同输入复用；读写核对当前任务fence/租约/graph/取消与总deadline。最终汇总须引用对应评分/排名产物并核对匹配判断hash，才能提交任务终态。HTTP仍仅创建/查询任务，分数/重算HTTP属于S3.1。

## 重算与默认政策

RecomputeService通过可信IdentityPort获取owner，使用原ScoreSet、原MatchPlan及冻结CandidateSet。只允许SUCCEEDED/PARTIAL任务；未知候选、缺失/重复要求或不合法权重拒绝。未指定变更的岗位沿用原ScoreSet已保存权重，显式变更岗位必须完整提供六维及全部要求权重。新的ScoreSet关联sourceScoreSetId，排名一起事务提交，同来源同输入重复返回相同结果，原结果/判断/候选不变；服务不依赖模型端口。

正式默认scoring-v1按D7显式导入，不自动替任意owner补规则：

```powershell
pnpm run scoring:import-default 00000000-0000-4000-8000-000000000001
```

命令先核验本项目PostgreSQL归属，既有owner/version同内容幂等、不同内容拒绝。版本包含六维等权、系数10000/5000/0/0基点、以上pending规则以及half-up两位显示/六位排序。修改政策使用新版本，不原地更新v1。

新增迁移保留旧任务；回退时停用新创建/新评分消费者并保留数据，旧版本不能执行带scoringPolicyHash的新任务。清理测试数据时先删排名，再按source关系从叶子删派生评分，最后删任务/政策；不得删除开发owner正式规则或外部项目资源。
