# S3.3-T4本地任务创建测量

2026-11-28运行`pnpm run performance:tasks`，入口为[专用测量脚本](../test/integration/task-performance.fixture.ts)。真实production装配、账号登录后的Cookie/CSRF、HTTP和PostgreSQL；冻结一份合成简历和一个已发布JD，每次使用不同幂等键。并发1，5次预热后测50次；不启动任务消费者、不调用模型/embedding，登录与应用启动不计入创建时延。脚本保存逐请求状态/耗时，并核对56个分析与56条分析Outbox（含初始种子和预热）同库存在。

| 项目 | 实测 |
|---|---|
| 环境 | 本机Windows、Node24.22.3、本项目Docker PostgreSQL与原有机械盘数据卷 |
| 正式样本 | 50，HTTP202与响应Schema全部通过，失败0 |
| 最小 / p50 | 27.27ms / 38.60ms |
| p95 / 最大 | 49.81ms / 105.15ms |
| 均值 | 38.76ms |
| 分位数 | nearest rank：升序第ceil(n×p)项，不插值 |
| 真实分析耗时、token、费用 | 未测，待真实模型/embedding Key及统一验收；没有以0冒充 |

记录位于本机data/s33-performance/c8bfbcd1-6dd6-4f40-85ba-42a50e418edb/report.json，日志data/s33-t4-performance.log；manifest的cleaned=true，账号/会话、精确owner的简历/JD/任务/Outbox已清理，未发布测试消息或创建向量。清理前后核验项目实例及网络，若检测到Worker尝试则拒绝删除并保留清单。

该样本只说明这次本地创建路径；同输入、单账号、顺序访问、预热及loopback HTTP都限制了代表性。未测TLS、并发用户、长期负载、真实岗位规模或端到端分析预算，不构成p95<1秒的生产保证，不解除SocketTimeout或L1/L2。
