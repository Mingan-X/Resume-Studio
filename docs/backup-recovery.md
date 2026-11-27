# 备份、隔离恢复与回滚

S3.3-T5交付本地隔离演练与操作步骤；目标服务器恢复、RPO/RTO与正式数据规模仍待统一验收。单机Compose不提供节点高可用，备份成功也不能代替恢复核验。备份、原文件、账号哈希、RabbitMQ定义和本地配置都视为敏感材料，只放受限离线目录/加密备份介质，不提交仓库或原始日志。

## 一致性与备份集合

先关闭入口的新建/修改能力，停止API、消费者、发布器、对账器和生命周期进程并核对实际退出；租约超时不等于物理停止。记录Git SHA、锁文件hash、镜像digest、32条基线迁移及后续迁移状态、规则/语料/模型/embedding版本和精确Compose项目/服务/卷/网络归属。未确认停止、删除中或存在未知外部写入时保留现场，不能把它视为一致备份点。

依次备份业务库resume_studio_s12_test、Checkpoint库resume_studio_checkpoint、完整STORAGE_ROOT（含storage-owner.json、files、staging与manifest）、RabbitMQ definitions、本地凭证/模型配置和部署证书。业务与Checkpoint分别使用同版本PostgreSQL的`pg_dump -Fc --serializable-deferrable`，保存每件SHA-256及开始/结束时间；生产备份须流式写文件，禁止把密码放命令行。管理员凭证只从受限环境/密钥文件读取。另保存角色与授权恢复方案；`--no-owner --no-acl`的演练归档不含原角色权限，不得直接作为完整生产权限恢复证明。

RabbitMQ definitions只含用户/密码哈希、权限、vhost、策略和拓扑，不含队列消息。业务状态及Outbox仍以PostgreSQL为真源；恢复后先检查未发布事件、已发布但未执行任务、消费收据、重试/总预算和终态，再由原有对账补发。不能清空收据、fence、generation或预算来“恢复”任务。未确认旧执行停止时保持现有线程隔离规则。

Langfuse是可丢失观测，业务库仍保留resourceTrace删除意图；恢复旧备份可能复活已删除数据，恢复前必须核对备份时间后的删除/保留操作并重新执行相应屏障，未核实前不开放用户入口。正式观测存储的备份与保留也需维护者在目标环境制定；本演练不宣称覆盖ClickHouse/MinIO完整灾难恢复。

## 本地隔离演练

先构建，然后显式执行`pnpm run backup:drill`。命令只复用已验证来源容器的相同镜像ID，创建带本次UUID项目/服务/运行标签的临时PostgreSQL和RabbitMQ容器；network=none，不映射端口，不挂载现有卷，数据位于tmpfs。两个目标串行启动/核对/移除，避免并行占用机械盘资源。源实例保持运行，不恢复到源实例，不修改其配置。

演练增加一个本轮owner的合成关系数据、一个官方Checkpointer合成图（41→42）和一份合成文件。完整导出业务/Checkpoint库，恢复到隔离目标后逐表核对行数及规范JSON行hash；源库备份前后指纹必须一致。业务库和Checkpoint库均包含完整现有Schema，原规则与迁移不删改。文件备份后恢复到新空目录，通过LocalStorage生成新目录归属标记并复制files/staging，读回文件核对SHA-256；原marker随备份保留，新路径映射仅适用于本轮受控合成文件恢复，不授权随意改写已有存储标记。

RabbitMQ定义导出到本次精确/tmp路径后复制到忽略目录，复核源实例归属后只删除此临时文件；隔离目标import后再次export，逐条核对来源定义。空目标自带默认定义可额外存在，目标始终无网络，不把这些默认账号开放为部署配置。演练归档缓冲上限64MiB、单Docker命令60秒、目标就绪120秒，超限明确失败；不是大规模生产备份工具。

manifest和归档保留在data/s33-restore/<runId>。清理先核对目标的UUID标签、无网络及仅tmpfs挂载，再移除本轮容器；源业务只删除本轮owner，Checkpoint只删除本轮thread。失败保留阶段与manifest，不自动删除备份或整个目录。禁止对其他项目或未记录容器执行清理。

## 目标环境恢复顺序

1. 在新隔离实例上核验镜像与资源归属；准备受限账号、独立Checkpoint角色和schema，使用与备份匹配的版本，关闭所有业务写进程。恢复先演练到新实例，禁止直接覆盖正在服务的数据库。
2. 验证归档SHA-256，再恢复业务库与Checkpoint库；按既有provision/setup边界恢复角色授权，核对跨库拒绝、Checkpoint运行账号不能DDL及所有迁移/规则hash。官方setup必须由独立setup账号显式执行，不能由Worker自动迁移。
3. 恢复原文件与完整manifest，核对每个FileAsset的storageKey/size/sha256；使用原受限STORAGE_ROOT绝对路径及对应归属标记。更换路径需要单独审查映射和存储初始化，不能简单删除标记重建。
4. 恢复RabbitMQ定义，核对quorum、confirm/mandatory/return、DLX策略及权限。保留任务/Outbox/收据状态，按真实停止证据运行对账；未知旧执行保持隔离，不把历史未完成任务批量标成功。
5. Qdrant视为可重建索引：从已恢复PostgreSQL的发布JobVersion/要求/语料及精确版本读取，按[岗位索引重建与alias流程](job-index.md)创建新目标，使用维护者确认的真实百炼配置。先验证全部目标READY、维数/内容hash/owner和召回，再切alias；失败保留旧目标，不伪造embedding，不删除原集合解除阻塞。真实embedding重建仍按原授权延后。
6. 核对数据保留与删除意图，启动就绪探针、API、真实Worker、发布/对账及生命周期监督，执行带会话/CSRF的冒烟与故障恢复；目标环境3次基础/2次完整回归通过后才申请解除L1/L2。

## 发布失败回滚

关闭入口和新任务，停止并确认新进程退出，保存新版本数据及诊断；切回已验证且与当前迁移兼容的应用镜像。迁移默认前向兼容，保留新表、文件、消息和历史产物。涉及生命周期登记的版本不能回退到未登记线程/trace的旧代码继续公开服务。数据库回滚应恢复到另一个已核验实例再验收切换，不执行reset/down -v或删除配置；上线后新写入与删除意图必须逐项对账，不能用旧备份覆盖丢失。

官方操作依据：PostgreSQL 16 SQL dump/pg_dump/pg_restore手册、RabbitMQ backup/definitions手册、Docker容器与网络文档。镜像和当前工具的实际行为、每轮失败/通过及未执行项见[进度](progress.md)。
