# S3.2-T3所有权审计

审计范围为当前HTTP、业务repository与显式Worker；不表示未来路由已验证。会话到owner的可信边界见[账号说明](auth.md)，请求不接受owner字段，越权与不存在统一404。账号/me只投影账号id/username，健康检查无需登录。

| 入口/资源 | owner约束 | 行为与故障测试 |
|---|---|---|
| resumes POST/list/version | SessionIdentity；owner/id或owner/idempotencyKey查询；复合FK绑定file/version/block | session-identity真实登录上传/list/foreign404；resume-api及resume-storage覆盖同key跨owner、伪造query、原文证据/文件关系与补偿 |
| jobs create/list/latest/version | 同时查owner/job/version；返回剥离owner | session-identity并发账号列表与伪造header/body；job-api覆盖读写 |
| jobs edit/confirm/publish/suggestions | 先authorized检查owner/job/version；事务行锁与复合FK；suggest授权后才调用模型 | session-identity与job-api逐路由foreign404；publication覆盖owner、版本、Outbox原子性 |
| analyses create | 事务检查owner/resumeVersion/corpus/rubric/policy；冻结owner进入输入 | analysis-creation跨owner/未解析/配置与回滚；tasks覆盖未登记owner及复合FK |
| analyses list/detail/options | 每个主查询限定owner；语料和简历独立分页 | report-api-check的foreign detail404与列表空；session-identity未登录401；analysis-runtime执行该HTTP专项 |
| tasks GET/cancel | 按owner/taskType/taskId查询并锁定取消 | task-api两类任务、foreign404与取消竞态；session-identity真实账号foreign取消不改变标志 |
| tasks SSE | Guard建立连接检查会话；事件限定owner/type/id | report-api-check补读/foreign404；session-identity真实账号foreign404与未登录401 |
| reports list/detail/revisions/recompute | 先查owner/report，原判断、任务、来源ScoreSet均校验owner；幂等含owner | report-api-check foreign404/列表空、重算拒绝、并发原报告不变；scoring-recompute领域越权 |
| 画像、提取、计划、逐要求、候选、评分 | claim中的owner/task/fence/generation；引用来源和冻结输入再校验 | profile/extraction/matching/candidate/scoring与analysis-runtime真实数据库边界 |
| 共享真实消费者 | 持久Outbox的messageId与dispatch获得owner，任务行/输入快照复核；信封无owner | service-identity真实账号并发、消息伪造、无映射拒绝、生产开发身份/禁用账号拒绝；consumer/checkpoint-fence/retry覆盖fence/重复/故障 |
| 发布/对账/管理员导入 | 本地进程配置或CLI owner，经Schema及账号/资源检查；无HTTP任意owner入口 | service-identity配置边界；outbox/reconciliation/rubric/corpus；部署监督待S3.3 |

内部例外：ResumeRepository.isReferenced是GC全局引用检查；持久消息路由首次按eventId读取是服务端分派；归属诊断读取本项目实例。它们不作为私有资源HTTP接口。无法信任的信封只保存最小hash/安全元数据，落专属基础设施owner。

权限测试先验证合法请求通过，再核对跨owner拒绝；无效Schema仍400，未登录401、CSRF/Origin拒绝403不混同资源404。旧专项通过overrideProvider注入已知owner，与真实登录专项共同覆盖边界，不代表浏览器HTTPS部署验证。执行结果按日期记录在[进度](progress.md)。

生命周期：删除请求只取会话owner且要求账号存在；query按owner/id，越权404。到期扫描JOIN账号，固定开发/基础设施主体不参与；DB共享/独占owner锁及触发器阻断新业务写入。执行器逐任务核对终态/停止证据，外部删除核对文件hash、线程清单、向量metadata与Langfuse专属project。跨owner保留、账号保留、待核实不删除及故障重入由lifecycle/session-identity/analysis-runtime专项覆盖；真实trace另有lifecycle-trace。
