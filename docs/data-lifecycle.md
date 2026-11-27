# 数据保留与删除（S3.2-T4/T5）

政策来自维护者确认：账号的简历版本上传满30天后清理原文件、解析/语义产物、关联分析/报告/评分与全部已登记Checkpoint及trace；岗位语料保留。主动删除全部业务数据同时删除自建JD/语料/向量和自定义规则，账号及登录能力保留。开发固定主体和基础设施隔离主体没有账号，不在自动到期扫描中；它们不能通过公开接口请求删除。

## 接口

仅AUTH_ENABLED启用。POST `/api/v1/data-deletions`要求JSON空对象、UUID Idempotency-Key、有效会话、CSRF及Origin，202返回删除请求；相同key或同owner已有活动的全部删除请求返回原请求。GET `/api/v1/data-deletions/:requestId`只允许本人查询，越权404。响应含id/scope/resumeVersionId/status/reason/createdAt/completedAt/completedSteps/totalSteps，不含路径、owner、线程或trace ID。202表示已登记，只有DONE表示已完成。

状态WAITING等待安全停止/历史清单核实，RUNNING按步骤清理，DONE保存最小状态回执。reason可能为ACTIVE_EXECUTION、INCOMPLETE_HISTORY、STORAGE_UNAVAILABLE、RETRY_LIMIT。删除过程中业务写请求409 DATA_DELETION_PENDING；登录与查询仍可用。数据库触发器与同owner共享/独占事务锁覆盖并发写入窗口，不能靠绕过HTTP恢复写入。原任务写入、终态、fence和取消规则保持。

## 执行与恢复

执行命令为`pnpm run data:cleanup once`或`pnpm run data:cleanup watch`，需要现有infra/checkpoint/observability配置及绝对STORAGE_ROOT。watch每轮结束后等60秒，不重叠，连续3次循环异常退出。程序是显式受监督进程，API不会自行启动定时清理；部署监督见后续S3.3。

每轮最多扫描20条到期简历及20个请求，按checkedAt轮转防止未完成请求饿死后续数据。每次请求执行60秒总期限、最多100个外部步骤，每步骤累计最多5次尝试；失败后持久保存retryAt并带jitter，普通存储退避最多60秒，trace等待以5分钟为上限。没有嵌套自动重试，超过尝试上限保留RETRY_LIMIT供运维核验；进程重启不会清零。已开始的SQL仍受原5秒语句/事务上限约束。

全部删除先提交禁止新写入的屏障，再持久取消非终态分析/索引任务，由原对账器安全终结；到期删除不取消活动分析，只等待。即使任务CANCELLED、租约过期或锁已释放，只要任一attempt缺executionStoppedAt仍不删。上传/建议请求登记ResourceOperation，完成且文件补偿可确认后才标停止；索引创建/upsert/alias外部写入也登记操作，丢失响应保留不确定状态以防迟到重建。进程崩溃或补偿不明会保留等待，不能用时间推测已停止。

所有外部删除在数据库事务之外执行，按owner执行锁防止并行删除。先保存精确步骤，再删除外部资源，最后同事务删除业务引用并标DONE。崩溃发生在外部删除后/步骤落库前时重试同一资源；业务数据库引用保持到所有步骤完成。完成后删除步骤中的内部资源标识，只保留数量/时间及幂等回执。

## 存储边界

- 文件：核对项目storage-owner marker、目录祖先、UUID、无软/硬链接、sha256/size后删除对应payload和匹配暂存manifest；有其他简历版本引用时保留共享文件。拒绝未知文件或不匹配hash。
- Checkpoint：触发器在任务创建与每次切换thread时登记所有线程；逐thread使用官方PostgresSaver.deleteThread并读回确认。迁移前已执行任务或曾切换图的历史标为清单不完整，不能声称凭当前thread就已删干净。
- Qdrant：核对本项目实例和集合完整metadata（owner/版本/维数/来源），只删除该owner的私有索引集合和唯一对应alias；未知metadata/alias冲突保留失败，不按名称前缀批删。删除全部才处理岗位向量，到期简历不删岗位索引。
- Langfuse：业务span在导出前持久登记owner/task/trace关系，登记失败丢弃该span导出而不影响业务；结束时有界flush。删除前核验专属Compose及project，先确认trace曾可读，再提交DELETE，并通过observations读回为空确认。首次尚不可见不视为已删除；没有成功送达/无法查询的登记保留等待，不把异步接受等同完成。

未确认的历史执行停止、旧线程清单、trace未可读或存储暂不可用均有明确待处理状态。注册机制之前已存在的账号也标为历史不完整，防止遗漏没有analysis attempt的旧JD建议trace。不会因为维护者接受SocketTimeout为开发已知问题而跳过这些检查。当前单机实现依赖所有API/Worker/清理进程部署同一版本；部署前停下旧版本进程，保留其停止证据，再启用执行器。

## 验证范围

`lifecycle.test`使用真实PostgreSQL/文件/官方Checkpoint/Qdrant验证过期边界、账号保留、活动/未知停止等待、历史清单、不完整删除重入及跨owner隔离；`analysis-runtime`复用完整合成业务产物验证报告revision/评分/排名的删除顺序；`session-identity`验证真实会话删除接口、CSRF/越权/重复请求和写入屏障。`lifecycle-trace`独立验证真实Langfuse异步删除。实际运行结果以[进度](progress.md)为准，不将fixture声明成真实模型质量验证。
