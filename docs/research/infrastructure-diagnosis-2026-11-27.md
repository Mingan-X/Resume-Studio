# S2.2 阻塞故障专项排查

2026-11-27，关联S2.2-T4/T10。维护者明确授权专项排查；在现有阶段分支执行，不改变验收窗口、服务配置或技术方向。本文记录诊断证据，不代表S2.2或整体路线图完成。

## 结论及证据强度

当前证据支持**共享持久化路径存在严重、间歇性的I/O停顿**，足以解释多个数据库、队列和管理请求同时超过现有预算。没有发现需要更换RabbitMQ、修改业务Outbox或扩大190秒死信窗口的证据。具体物理磁盘、Windows分页、Docker VHD同步与其他I/O负载的各自占比仍未分离。

对于最后一次死信失败，可以确认broker在180秒后发现了恢复的路由；不能仅据这条日志断言目标quorum已持久化、已发确认或客户端已收到。历史测试没有记录这些中间时刻，所以**不能把历史未收到消息精确归因到某一行代码，也不能宣称已证明消息丢失**。

## 当前状态与历史故障

- 已核验本项目RabbitMQ/PostgreSQL的Compose项目、服务、loopback端口与卷标签；九服务running/healthy。RabbitMQ无本地/集群告警，正式4条队列ready/unacked均0；容器restartCount=0、OOMKilled=false。healthy只证明探针可响应。
- 故障批次的PostgreSQL日志在北京时间2026-11-27 04:58–05:00记录一次checkpoint：write=11.393秒、sync=121.783秒、total=134.878秒，85个同步文件中最长60.436秒。随后出现statement timeout。同一时段RabbitMQ记录CLI节点net tick遗漏及客户端10秒心跳丢失。这是实际运行停顿证据，不以磁盘型号推测替代。
- 最后失败的精确队列（runId `b6f9b6ed-caef-4375-b4f1-eda51be31808`）在北京时间05:22:48.126记录无死信路由，05:25:48.127重新发现路由，间隔180.001秒；测试随后未收到消息，约05:26:20开始精确删除本轮队列。日志只说“将尝试转发”，不证明已完成目标队列确认。
- 当前Docker虚拟机I/O pressure的full avg60约26%–27%，后续avg10达30.72%；同期memory pressure为0。Windows物理盘队列长度抽样约123，不能把该计数器的PercentDiskTime大于100直接当作利用率。没有关闭其他应用、杀进程或停观测服务来取得通过。
- E/D/F同属ST1000LM035 SATA HDD，C为NVMe；项目、pnpm依赖与Docker VHD共享E盘。VHD文件23,693,623,296字节（约22.1 GiB），C可用约3.3 GiB，不能直接容纳迁移。D盘不是独立快盘。
- 两组各6次4KiB追加+fsync的低负载探针：C盘1.15–4.13ms，E盘16.41–77.84ms。临时目录为本轮创建并精确清理；小样本不能代表分位性能或单独证明VHD内部根因。

## RabbitMQ行为与独立实验

读取运行broker得到`dead_letter_worker_publisher_confirm_timeout={ok,180000}`，与既有配置一致。通过GitHub contents API读取官方v4.4.0的[rabbit_fifo_dlx_worker.erl](https://github.com/rabbitmq/rabbitmq-server/blob/v4.4.0/deps/rabbit/src/rabbit_fifo_dlx_worker.erl)，返回blob SHA `b79a3154fdca46423055c445aacbcb7cc6edf71e`。`forward`把无路由消息保存在pending；`maybe_set_timer`启动180秒定时器；`redeliver_messages`在定时器触发后重查路由。恢复binding本身不是立即投递承诺，重试之后还需要目标队列确认。raw GitHub下载两次连接重置，API下载成功，失败没有隐去。

独立实验使用本轮UUID命名、事前确认不存在的4条quorum队列、2个exchange与精确policy，沿用正式at-least-once/reject-publish策略。合成消息确认后拒收，断开死信binding约300ms再恢复；保持原190秒接收窗口，未改broker设置。

| 事件 | 相对进程启动 | 核对 |
|---|---|---|
| publisher confirm | 11.660秒 | 合成消息已被broker接受 |
| reject已发送并完成后续RPC | 11.737秒 | 客户端侧时间，不代替broker处理完成 |
| 恢复binding | 12.104秒 | bind RPC完成 |
| broker重新发现路由 | 拒绝日志后180.001秒 | 与配置/官方源码一致 |
| 收到死信 | 192.140秒 | 恢复binding后180.036秒；messageId一致，x-death.reason=rejected |
| 精确清理完成 | 196.698秒 | manifest.cleaned=true |

期间队列只读观察显示源队列messages=1而ready/unacked=0、目标队列0，符合等待死信确认状态；321次get轮询最长RPC为2.176秒，Node事件循环最大延迟569ms。最终接收成功说明当前能够恢复投递，不能替代历史失败或完整阶段回归。

诊断自身的失败：首轮在管理HTTP观察处超过5秒，业务实验尚未开始即退出并清理。第二轮将可选观察失败记录为observationError，业务AMQP窗口保持不变；管理HTTP后续返回错误，使用独立rabbitmqctl只读快照补充，不把观察错误算业务成功。两轮清单都保留在忽略目录。

## 处置建议与边界

原Outbox专项（未改代码、原190秒receive/300秒父期限）随后执行10/10通过、0跳过，总耗时255.624秒，其中DLX子用例181.686秒。

原完整`pnpm run test:integration`随后119/119通过、0失败/跳过，总耗时595.408秒；Outbox DLX子项183.303秒，Docker Qdrant集合创建4265.6ms（原5000ms限制）。这轮完整回归支持解除当前“最近回归未通过”的连续开发阻塞；不证明环境长期稳定，也不解除需目标环境多轮回归的L1/L2。没有用诊断脚本替代正式验收。

回归后再次核验归属并只读检查：只剩4条正式队列，ready/unacked均0；正式policy与原已知孤立policy保持原状；两个诊断清单cleaned=true，Qdrant集合0，数据库仅原开发owner，Job/Rubric/Resume/FileAsset/DiagnosticRecord均0。各套测试报告本轮精确清理完成。历史失败保留，最终基础检查见[开发进度](../progress.md)。

1. 优先准备容量足够的SSD/NVMe或目标机器，再按备份、归属核对、受控迁移、数据核验、原命令复验的顺序迁移项目/依赖和Docker数据。按当前VHD大小计算，需容纳现有约22.1 GiB并预留增长及迁移空间；现有C盘不满足。不要把数据移到同盘D分区当作解决方案。
2. 迁移前可减少同一机械盘上的并行构建/安装/测试负载，测试按既有串行命令执行；这只能减少干扰，不能保证满足5秒数据库/发布或190秒DLX要求。单独测试通过不解除阶段完整回归门禁。
3. 继续保留现有publisher/SQL/解析/进程期限和失败断言，不改WAL/fsync、不使用tmpfs代替持久化、不降级quorum、不把这些故障扩充为L1/L2。
4. 遗留孤立policy `s12.t3.d175a1d5332d41dbac3eae8965643b7c.tasks.reliability.v1` 的pattern只匹配自己的精确UUID，不匹配本轮或正式队列，不构成本轮路由冲突证据。其创建归属不足，继续保留；本轮仅清理本轮清单中的资源。

本次未迁盘、删除卷/数据库/配置、启停原生Qdrant、调整内存/磁盘配置或修改生产逻辑。原始broker/系统计时、源码副本、合成实验脚本与精确清单在本机忽略目录`data/infra-diagnosis-20261127/`；不提交原始运行日志或凭证。
