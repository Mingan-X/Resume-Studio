# 岗位索引执行

S2.3-T4实现中；检查及失败记录以[进度](progress.md)为准。测试使用真实PostgreSQL、RabbitMQ和Qdrant以及显式合成embedding，只验证工程一致性，不代表百炼向量质量或正式索引可用。

## 标识与归属

`jd-chunks-v1`按1000个UTF-16 code unit分块，不截断代理对；块保留原正文起止偏移与内容哈希。原JD证据块不变。chunk ID绑定岗位版本、分块版本、偏移和hash；point ID绑定jobVersionId、chunkId、embeddingVersion，重投不产生新point。

collection名包含embeddingVersion、dimensions与完整配置哈希片段，配置同时含owner、indexVersion、provenance、chunker/component版本。collection metadata保存完整配置；每次写入/切换/删除核对配置和Cosine维数，不能仅按名称前缀判断归属。变更维数/模型/索引配置创建新collection，调用方必须给新版本，不复用旧配置身份。payload只保存版本、owner/private与各层hash，不保存JD正文或联系方式。

初始化与破坏性操作额外调用实例归属校验：正式适配器使用本项目Docker项目/服务/端口/卷标签，原生对照使用用户手动运行的进程身份、路径和二进制指纹。清理只针对本轮精确spec，不扫描前缀批量删除。结果未知时保留manifest并有界对账，不能删卷/数据库解决失败。

## 执行与恢复

JobIndexHandler显式选择kind=job-index，校验owner、发布正文/要求hash与版本配置；每批最多8块，发送前由EmbeddingExecutor脱敏。每次embedding尝试通过TaskExecutionStore.reserveUsage持fence记账，恢复不重置预算。外部调用不在数据库事务内，所有请求受单次期限与原任务总deadline约束。Qdrant无适配器内重试；429、5xx、网络不可用、超时映射已有安全TaskFailure，由持久任务重试/退避及最大尝试限制控制。

Qdrant成功upsert后，completeJobIndex在同一数据库事务内核对task租约/fence/generation/cancel、当前目标task/embedding/index、发布内容，再写READY、幂等索引产物、任务SUCCEEDED、TaskEvent、attempt结束与DONE收据。中途SQL错误全部回滚；Qdrant点已写时重放幂等upsert。旧目标或旧fence不能提交新目标READY。数据库不可写或执行收束未知不ACK；消息终态重投复用现有收据，不再次调用embedding。

默认合成消费者和默认对账器保持原行为，真实索引通过createJobIndexDelivery显式装配；仅测试可以allowSynthetic，正式装配拒绝合成端口。runtime提供显式job-index能力的对账入口。真实百炼配置/消费CLI由T7接入，不在T4提供假向量生产兜底。

## 补建与切换

```powershell
pnpm run build
# .env内JOB_INDEX_TARGET_FILE指向不入库的正式目标JSON
pnpm run index:backfill <ownerUuid> <corpusVersion> <runUuid>
pnpm run index:alias <ownerUuid> <corpusVersion> <collectionSpecJson路径>
```

补建只遍历指定冻结corpus，逐版本复用同目标任务或同事务新建任务/目标/Outbox并置PENDING。runUuid派生稳定幂等键，中断后沿用原run；新建任务时绑定请求，同键不同请求拒绝。已有目标相同的no-op返回尚未单独持久保存run键，旧no-op run隔离仍是审查遗留；不能宣称所有旧run均无法覆盖后来的目标。命令有10分钟总调度期限，每个数据库操作仍沿用原预算，不自动重试失败任务或重置预算。

切换前核对corpus成员全部仍发布、内容hash一致、当前目标SUCCEEDED/READY且索引产物匹配collection完整spec；随后核对目标集合和既有alias集合的metadata，再原子删除旧alias/创建新alias。真实命令只接受bailian配置。旧任务使用固定collection名，不跟随alias切换；alias只是管理指针，召回仍必须按冻结版本解析集合与回查PostgreSQL。别名切换不删除旧集合，删除有alias引用的集合被拒绝。

新Qdrant适配器使用安装的官方1.20客户端Schema对应REST并核对服务端1.20版本，原VectorService/SDK兼容检查未改。原因：SDK有限timeout middleware会覆盖调用方signal；原生fetch可合并任务取消/总期限/单次5秒并禁止重定向，响应上限4MiB。未引入额外依赖。

验证入口：[分块/标识测试](../test/job-index.test.ts)、[HTTP故障边界](../test/index-vector.test.ts)、[真实索引链路](../test/integration/job-index.test.ts)。不以mock或合成向量替代真实embedding、人工标注和最终部署验收。
