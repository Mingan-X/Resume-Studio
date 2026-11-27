# 报告、历史与进度接口

S3.1提供不可变报告、查询/重算revision、分析选择列表与持久TaskEvent SSE。验证记录见[进度](progress.md)；公开认证属于S3.2，当前仍通过TASK_API_ENABLED仅本地development/test启用，owner来自服务端IdentityPort，客户端不能指定。

## 快照与提交窗口

新创建分析冻结reportVersion=1。图的JOIN后SAVE产生可恢复的汇总引用，消费完成适配器在同一业务事务内核对fence/租约/图代次、构建完整报告、写入任务reportId/终态/完成事件/attempt结束/DONE收据；提交后才返回ACK许可。Checkpoint结束不等于报告提交；事务失败则报告/终态/收据一起回滚，恢复重放SAVE引用并复用语义/评分产物。报告唯一operationKey绑定owner/task/reportVersion，重复投递不会新增报告。

AnalysisReport存完整内部输入快照和经Schema验证的内容/hash；基础revision=1、rootReportId=id，派生revision关联sourceReportId/rootReportId。禁止UPDATE。响应只返回安全版本概要、已保存报告内容，不返回ownerId、预算、数据库输入快照、存储路径、fence或图线程。原S2.4/S2.5任务缺reportVersion，保留原FINALIZE/组件身份和历史reportId=null；不伪造旧报告。

SUCCEEDED/PARTIAL新任务须已提交报告；FAILED保留诊断产物但没有成功报告。内容包含：输入版本、ExtractedDocument原文块与位置、ParsedResume及来源、Profile判断与映射分、冻结候选/岗位快照、全部计划执行行（含FAILED/BUDGET/PENDING）、全部候选评分及权重/精确贡献、排名/待核实/不符合、短缺原因、候选/要求覆盖计数、板块安全错误码与警告。未知语义和未完成执行保持区分，前端不计算分数或归一化权重。引用中的HTML始终是普通字符串，渲染须使用纯文本。

## 报告HTTP

| 方法与路径 | 请求与结果 |
|---|---|
| GET /api/v1/reports | limit默认20/最大100、opaque cursor；createdAt/id降序，概要与nextCursor |
| GET /api/v1/reports/:reportId | 无查询字段；完整ReportResponse，越权/缺失404 |
| GET /api/v1/reports/:reportId/revisions | 同一task的全部revision，游标分页，来源关系可见 |
| POST /api/v1/reports/:reportId/recompute | application/json、UUID Idempotency-Key；正文`weights:[{jobVersionId,weights:{dimensionWeights,requirementWeights}}]`，201新报告或幂等重放 |

重算只使用源报告关联ScoreSet/MatchPlan/CandidateSet，不调用模型；完整输入Hash不变。新ScoreSet、排名、报告revision和幂等绑定同事务写入，原报告不修改，任务reportId继续指向基础报告。不同key是明确的新revision请求；同owner/key同正文返回同一report，不同source/正文409。无可用scoreSet的部分报告409；错误权重400 VALIDATION_ERROR携带details.fields，动态原文不回显。非法权重/事务失败不得留下报告绑定或部分新产物。

## 选择与分析历史

| 路径 | 返回 |
|---|---|
| GET /api/v1/analyses | 真实analysis列表，limit/cursor，输入安全概要/状态/reportId |
| GET /api/v1/analyses/:taskId | 分析概要与既有TaskResponse |
| GET /api/v1/analyses/options | limit、resumeCursor、corpusCursor分别分页；只列已持久解析成功版本及当前owner冻结corpus；configuration仅含所用版本，无配置时null |

简历选项提供resumeId/resumeVersionId/version/fileHash；正文证据仍由既有版本详情接口提供。corpus选项提供version/hash/jobCount，使用既有owner/version身份，不自动选latest。cursor以时间和稳定ID（corpus为version）定位，同时间记录不会跳过。创建正文不新增owner或策略字段。

## SSE

`GET /api/v1/tasks/:taskId/events`，无查询字段，允许`Last-Event-ID`为0或合法已读seq；越界/格式错误400，越权404。200 content-type=text/event-stream，`event: task`、`id: <seq>`、`data: <TaskEvent JSON>`；每次从数据库读取最多100条、严格seq升序，续读只取大于已读seq。后端不依赖进程内EventEmitter，可读取Worker提交的事件；断线只结束传输，不请求任务取消。

初始retry=2000ms；空闲15秒发送comment心跳。每个API进程每owner最多5连接、全进程100；超额429，已分配额度在断线/错误/终态释放。单连接300秒到期，客户端可补读重连；客户端背压最多等待5秒后断开，不无限缓冲。任务终态且已发送最后事件时结束；携带最终seq重连返回204停止重试。进度计数按真实阶段展示，不提供匀速估算百分比。这里连接上限是每进程，不宣称多进程全局限额。

## 前端契约核对

来源为Resume-Studio-Frontend固定提交a8aea7c3704716e2432736e62d376e7b8642b24b的development-roadmap F2.3–F2.5和api-integration说明。只读核对、不修改前端。F2.3选择/版本信息由analyses/options提供；F2.4结构化简历、画像、推荐/待核实、差距/证据和PARTIAL计数全部来自ReportResponse；F2.5重算/revision/分页及SSE均有接口与同源OpenAPI。真实模型报告联调按原延后表，不把假模型HTTP测试当生产质量保证。

## 运维与测试

先部署新迁移、generate/build再部署API/Worker。历史任务输入不变，旧图分支保留；回退时暂停新任务及报告消费，保留所有表/数据/配置。清理测试或未来删除链路须先删ReportRecomputeRequest，再按来源关系由叶到根删报告，不能删除开发owner的正式规则。

report-contracts覆盖非法cursor/Last-Event-ID和连接额度释放；analysis-runtime中的report-api-check通过真实HTTP/数据库验证并发幂等重算、owner隔离、分页、重启读回、SSE补读/实时持久事件/连接限制/断线不取消。完成事务故障注入断言报告为0、恢复后为1；已提交重投仍为1。各次结果、失败与未执行项以progress为准。
