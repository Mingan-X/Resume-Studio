# S3.3故障注入

显式运行`pnpm run test:faults`，按文件串行执行以下矩阵。该命令会重启本项目RabbitMQ一次，普通`test:integration`不包含主动重启fixture。先确认没有其他API/Worker/发布/对账/清理进程执行，保留本地凭证和全部原卷。重启fixture还会拒绝非终态任务、待发布Outbox、已有队列消息或consumer；不能为通过预检清空这些资源。

| 架构§6.3窗口 | 注入与断言入口 |
|---|---|
| Task事务提交前 | integration/tasks：真实Outbox INSERT前后故障，任务/消息同时回滚，相同幂等键重试 |
| 提交后publish前 | integration/outbox、reconciliation：未发布事件领取补发，持久发布预算不重置 |
| broker接受后published前 | integration/outbox：丢confirm、确认后强杀，重复messageId与收据去重 |
| Worker收到后首Checkpoint前 | integration/checkpoint、checkpoint-fence：实际强杀并等待退出，冻结输入重入 |
| 模型返回后产物提交前 | integration/analysis-extraction：模型端口返回后注入保存失败，真实库无产物；再次执行调用数和持久预算均为2，后续命中缓存不调用模型 |
| 产物已提交Checkpoint未提交 | integration/checkpoint-fence、analysis-graph：saver屏障、实际暂停/终止/恢复、幂等产物复用及旧thread隔离 |
| 仅一个分支成功 | integration/analysis-runtime：PROFILE失败而MATCH成功保留PARTIAL；最终提交失败重入复用已提交产物，不制造完整成功 |
| 报告提交后ACK前 | integration/consumer：实际强杀、broker重投与仅一次完成；analysis-runtime：终态重复投递不重建真实报告/不重复模型调用。两项组合验证，不声称对真实模型进程完成整条强杀实验 |
| Checkpoint结束Task终态缺失 | integration/analysis-runtime：完成事务故障回滚后从已完成图恢复finalize，报告/收据/终态一致 |
| PostgreSQL不可用 | integration/consumer：已核验实例经测试专有TCP代理断连，实际消费者0 ACK、消息重投；恢复连接后同输入一次完成。reconciliation补充丢锁连接后的中止/不ACK |
| Qdrant不可用 | integration/recall：真实读后断开专有TCP代理，默认报VECTOR_UNAVAILABLE；显式keyword降级只有关键词来源，恢复后读回同结果 |
| Langfuse不可用 | observability：真实HTTP断连、无响应、503、部分拒绝，图继续且丢失计数增加；不重启共享观测服务，不声称该项等同服务端磁盘故障 |
| 取消/删除 | integration/analysis-graph、analysis-runtime：取消/fence拒绝迟到写入；完整生命周期故障由默认test:integration覆盖 |
| broker重启 | integration/broker-restart.fixture：confirm后的持久quorum消息先投递不ACK，重启同一容器、验证同一messageId redelivered后ACK |

新TCP代理仅连接已验证的本项目端点，不改变系统防火墙或原服务配置。broker重启前后核验Compose项目/服务、精确端口、卷和网络标签/成员；只删除本轮UUID队列，manifest保存在data/s33-faults。失败时保留manifest与原失败记录，不能删除卷或把故障断言改成成功。

既有测试的归属检查范围见[测试边界](testing.md#数据隔离与已知边界)；本次网络校验用于显式broker实验，不宣称全仓旧工具已自动补齐。模型均为明确的工程fixture，重复调用不等于真实收费实测。PostgreSQL SocketTimeout、L1/L2和目标服务器回归继续保留。每轮命令结果以[进度](progress.md)为准。
