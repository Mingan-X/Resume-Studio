# JD与Rubric契约

S2.2-T1只定义领域契约和合成执行隔离；持久化、发布与HTTP由后续任务接入。本页不代表岗位接口已经可用。

六维ID按需求§2顺序为 `technical_depth`（技术深度）、`engineering`（工程能力）、`business_understanding`（业务理解）、`project_impact`（项目影响力）、`collaboration`（协作沟通）、`growth`（成长性）。契约来源为 [jobs.ts](../src/contracts/jobs.ts) 与 [rubric.ts](../src/contracts/rubric.ts)。

JD正文采用 `text-v1`：CRLF/CR转LF，然后NFC；不裁剪正文、折叠空格或移除换行。`jd-text-v1`将完整正文保存为一个TEXT块（paragraph=0），最多200,000个UTF-16 code unit。块ID由版本ID、chunker版本及归一化正文确定；正文修改产生新块身份。正文SHA-256为UTF-8编码的归一化文本哈希。后续向量分块独立于此证据块，不改写引用身份。引用使用S2.1的UTF-16半开区间及逐字quote校验，拒绝截断代理对、跨owner、版本、来源或块；sourceType必须为JD。

要求stableId在版本内唯一，新版本复制时保留stableId，sourceRef改绑新版本并重新校验。threshold显式为null或operator/value/unit，不从描述静默推断。priority为非负整数，weight为显式有限非负数；0权重不移除判断或硬门槛。草稿允许空要求；发布至少一条要求、硬门槛和权重均已确认。六维权重必须完整且唯一；参与计算的维度总权重>0，每个有效维度的要求权重之和>0，累加溢出也拒绝。不对缺项补默认值。六维等权是D7的正式策略，服务创建草稿时将显式写入版本。

Rubric必须完整包含六维及各自L1–L5，featureId全版本唯一。每级有行为、证据门槛及映射分值。SYNTHETIC/TEST_ONLY不能作为正式版本；正式v1由T6起草，AI_DRAFT/PENDING_REVIEW标记保留到维护者审核。版本内容哈希与不可变存储在T2/T5实现。

索引快照用kind区分synthetic与job-index，真实快照保留owner、岗位版本、正文/要求哈希、embedding/index/chunker/component版本及预算。S2.3真实处理器接入前，消费者在领取尝试前返回deferred并关闭会话，不ACK、不增加attempt或预算；对账器不对这种等待生成恢复任务。取消及终态/旧代消息仍按既有持久收据规则处理。合成执行、产物写入、索引目标发布及完成入口均拒绝真实快照。真实索引尚未执行，不标READY；共享队列遇待执行真实任务会结束该消费会话，避免无界热重投。
