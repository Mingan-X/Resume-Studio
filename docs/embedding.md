# Embedding调用边界

S2.3-T3提供EmbeddingPort与EmbeddingExecutor；当前只有测试目录中的确定性合成实现，不在API、Worker或CLI注册。百炼适配器、正式索引和真实质量验证仍待S2.3后续任务；本文件不代表真实embedding可用。

端口显式声明embeddingVersion、dimensions、provenance；返回与输入条数一致、维数一致的有限数值数组和可空usage。维数或格式不符立即失败，不自动修复或换模型。调用前采用既有联系方式遮盖逻辑，保留岗位/技能文本并遮盖常见邮箱、电话、URL和联系方式标签；不承诺识别任意隐写个人信息。

配置由embeddingPolicySchema校验，包括单次/总期限、maxAttempts（含首次调用）、指数退避基值/上限与jitter、并发、token/费用预留及总预算。每次尝试先在同一预算中预留；UTF-8字节与封装开销不得超过inputTokenReservation。超出usage预留或币种不一致立即失败。未报告usage或有失败调用时，整个调用usage保持unknown/null，不用0表示免费。

TIMEOUT、RATE_LIMITED、UPSTREAM_5XX、UNAVAILABLE可按剩余尝试重试；非法输出与预算错误不重试。所有重试、预算持久预留与退避都在同一总期限内；外层任务可以传入更早的deadline。reserve接口供后续持当前任务fence的持久记账使用，T3本身只实现调用内账本，不声称重启后的跨调用预算已持久化。

超时/取消后未确认结束的transport或reserve Promise保留并发槽，直到实际settle才释放；不能在旧调用尚未结束时开启重试。调用结束清理计时器与监听器，错误只包含安全码。供应商适配器必须关闭内部自动重试，避免绕过这里的预算。

测试入口：[故障测试](../test/embedding-executor.test.ts)、[仅测试合成端口](../test/support/synthetic-embedding.ts)。覆盖联系方式、可复现测试向量、重试预留、未知usage、维数/条数/非有限值、费用与币种、超长输入、总期限、挂起reserve、未结束transport与并发槽。运行结果及未执行项见[进度](progress.md)；真实百炼、索引重建、人工Recall@K不得使用合成向量替代。
