# Embedding调用边界

S2.3-T3提供EmbeddingPort与EmbeddingExecutor；确定性合成实现只在测试目录注册。T7百炼适配器与显式消费CLI正在验证，真实调用、正式embedding索引和质量验证按路线图延后；本文件不代表真实embedding服务已验证可用。

端口显式声明embeddingVersion、dimensions、provenance；返回与输入条数一致、维数一致的有限数值数组和可空usage。维数或格式不符立即失败，不自动修复或换模型。调用前采用既有联系方式遮盖逻辑，保留岗位/技能文本并遮盖常见邮箱、电话、URL和联系方式标签；不承诺识别任意隐写个人信息。

配置由embeddingPolicySchema校验，包括单次/总期限、maxAttempts（含首次调用）、指数退避基值/上限与jitter、并发、token/费用预留及总预算。每次尝试先在同一预算中预留；UTF-8字节与封装开销不得超过inputTokenReservation。超出usage预留或币种不一致立即失败。未报告usage或有失败调用时，整个调用usage保持unknown/null，不用0表示免费。

TIMEOUT、RATE_LIMITED、UPSTREAM_5XX、UNAVAILABLE可按剩余尝试重试；非法输出与预算错误不重试。所有重试、预算持久预留与退避都在同一总期限内；外层任务可以传入更早的deadline。reserve接口供后续持当前任务fence的持久记账使用，T3本身只实现调用内账本，不声称重启后的跨调用预算已持久化。

超时/取消后未确认结束的transport或reserve Promise保留并发槽，直到实际settle才释放；不能在旧调用尚未结束时开启重试。调用结束清理计时器与监听器，错误只包含安全码。供应商适配器必须关闭内部自动重试，避免绕过这里的预算。

测试入口：[故障测试](../test/embedding-executor.test.ts)、[仅测试合成端口](../test/support/synthetic-embedding.ts)。覆盖联系方式、可复现测试向量、重试预留、未知usage、维数/条数/非有限值、费用与币种、超长输入、总期限、挂起reserve、未结束transport与并发槽。运行结果及未执行项见[进度](progress.md)；真实百炼、索引重建、人工Recall@K不得使用合成向量替代。

## 百炼适配器与运行配置

按[官方核对记录](research/bailian-embedding-2026-11-27.md)实现text-embedding-v4的OpenAI兼容HTTP接口，不增加SDK依赖。显式dimensions支持64/128/256/512/768/1024/1536/2048；单次最多10条，UTF-8字节保守上限8192/条。请求float，按文档校验float或base64 float32 little-endian响应，严格检查条数、index唯一连续、模型名、维数与有限值。base64格式/长度非法拒绝。usage来自供应商且费用为null，不用免费额度估算实际成本。

endpoint只允许本次官方文档的HTTPS工作空间域`{workspace}.{region}.maas.aliyuncs.com/compatible-mode/v1/embeddings`，地域/工作空间由维护者配置，无默认区域或Key。禁止URL凭证/query/hash/重定向；响应最多2MiB。仅测试显式allowLocalTestEndpoint允许loopback HTTP，不在真实CLI启用。429/5xx等通过安全码交EmbeddingExecutor处理，适配器不另加重试。发送前再次移除常见联系方式，原始响应/Key不写日志。

忽略的本地JSON文件结构为`{connection:{embeddingVersion,model,dimensions,endpoint,apiKey,currency},execution:{...embeddingPolicySchema}}`。connection/execution币种必须相同，JOB_EMBEDDING_CONFIG_FILE要求绝对路径且文件不超过64KiB。原JOB_INDEX_TARGET_FILE的embeddingVersion必须与适配器一致，chunker/component为jd-chunks-v1/job-index-v1；没有真实配置时命令明确失败，不提供合成兜底。

```powershell
pnpm run build
# .env配置APP_ENV=development及JOB_EMBEDDING_CONFIG_FILE，正式目标另由JOB_INDEX_TARGET_FILE提供
pnpm run tasks:consume:index
pnpm run index:reconcile reconcile-once
pnpm run index:reconcile reconcile-watch
```

消费会话最多10条消息/10分钟、prefetch=1，沿用手动ACK、Outbox、隔离区和持久预算；watch沿用既有对账间隔与连续失败上限。固定开发身份不允许production。任务冻结的embeddingVersion未配置时，领取前deferred、对账handler-unavailable，不增加attempt/恢复预算，也不把旧任务交给新模型执行。多embedding版本须使用对应本地配置与版本化集合；本命令不自动删除旧任务或清空队列。

测试入口：[本地HTTP桩](../test/bailian-embedding.test.ts)，无真实Key或付费调用。真实文本向量重建及中文技能相关性仍待统一验收。
