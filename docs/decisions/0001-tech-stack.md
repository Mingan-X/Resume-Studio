# ADR-0001：技术栈、模块边界与可靠执行

- 日期：2026-11-23
- 审查状态更新：2026-11-24
- 状态：架构方向已确定；工程基础与基础设施诊断已验证，简历业务尚未实现。
- 范围：第一版Resume Studio后端与任务基础设施。

## 背景

项目需要构建可维护的Agent应用：PDF/DOCX简历解析、六维画像、JD结构化、岗位召回与匹配、确定性评分、Top10和可恢复报告。Elpis Demo提供可参考业务，但与其设计文档存在实现差异，且依赖Elpis、多语言MCP和内存运行状态，不适合作为本项目运行基础。

## 决策

1. 采用以下技术栈：Node.js/TypeScript、NestJS、LangGraph.js、LangChain.js、RabbitMQ、PostgreSQL/Prisma、Qdrant、PostgreSQL Checkpointer、Langfuse、Zod、Docker Compose。
2. 一个代码库的API与Worker两个入口，业务模块共享；不拆业务微服务，不依赖Elpis，不使用Python后端，不自研Agent Runtime。
3. 固定步骤由LangGraph显式图组织；LLM只做语义提取和有证据的判断。第一版不需要Supervisor，MCP延后。
4. Task与Outbox同事务提交；amqplib负责confirm、mandatory、manual ACK。至少一次消息加数据库幂等，不承诺外部LLM调用exactly once。
5. 业务任务表/产物与官方PostgresSaver分别承担用户状态/报告和图恢复；通过operationKey、fence、执行锁、对账和必要时恢复thread隔离处理不同事务边界。
6. PostgreSQL为真源，Qdrant为可重建派生索引；rubric与JD、模型和评分配置都版本化。图不直接传递自由格式Agent对话作为业务合同。
7. ScoringModule为纯TS函数；missing evidence为unknown，不套用参考项目默认L2、JD文本充当证据或按最新全局简历兜底。
8. 拟采用Node24.22.3、Nest12.6、TS6.0.3、Prisma7.10.1、LangGraph1.7.5/core1.5、Zod4.6.7、Langfuse6.1.1/OTel2.x组合。其余精确包与服务版本见兼容性文档，不在此复制第二份完整清单。
9. 本地复用兼容镜像，容器、网络和数据卷按项目独立。Compose仅管理resume-studio项目，不操作其他项目实例；镜像固定digest并禁止自动拉取。

## 后续待确认事项

- 六维 Rubric 各维度的 L1–L5 标准、证据门槛及评分映射；现有示例数值不视为已批准规则。
- LLM 服务商与具体模型，包括结构化输出能力、数据区域和调用预算。
- Embedding 模型及其版本、向量维数和索引配置。

具体配置仍需确认，完整列表见[开发计划](../development-roadmap.md#6-待决策事项)。

## 方案比较

| 方案 | 结论与原因 |
|---|---|
| 复用Elpis框架或复制其运行层 | 不选，项目不依赖Elpis；Nest/LangGraph已覆盖需求 |
| 全自由Supervisor组织解析/召回/评分 | 首版不选，顺序已知，额外模型调用增加费用与不确定性；图边更可测 |
| 每项技术做独立微服务或多语言MCP | 不选，没有规模/团队边界依据，增加部署与故障面 |
| HTTP请求内跑完分析 | 不选，时间长、客户端断开和进程崩溃难恢复 |
| 内存fire-and-forget任务 | 不选，不能保证重启后继续，也无法可靠展示历史报告 |
| BullMQ代替RabbitMQ | 不选，违反确定方向；无需为此引入业务Redis依赖 |
| 事务提交后直接publish | 不选，存在提交成功而消息未发出的丢任务窗口 |
| 分布式两阶段提交/XA | 不选，成本与组件适配不适合本项目；Outbox+幂等已满足可恢复异步需求 |
| 自己实现Checkpoint/运行时 | 不选，采用官方PostgresSaver；只写必要的业务任务协调逻辑 |
| 模型直接给综合分 | 不选，无法可靠审计或确定性调权 |
| 所有依赖都装latest | 不选，已查到Prisma RC、TS工具链、OTel主版本冲突 |
| Langfuse自托管或cloud | 待用户决定，权衡基础设施负担、trace出网和数据控制 |

## 后果

收益：业务与框架解耦、有限模型自治、评分可复现、任务可恢复、调试可关联、模块能分别测试。

代价：需要Outbox表、任务状态机、去重、租约与故障注入；Qdrant和Postgres存在最终一致性；Checkpointer不能自动包住业务事务；模型在“返回后尚未落库”窗口仍可能重复调用。这些机制按业务依赖顺序实现，并分别验证故障边界。

当前依赖及适配器的运行验证见[兼容性说明](../dependency-compatibility.md)与[测试文档](../testing.md)。工作流与观测组件仍为候选，发生兼容冲突时记录证据和最小调整，不私自更换技术方向。

## 重新评估触发条件

- 可测量的吞吐/隔离需求超过单Worker进程能力。
- 新需求确实需要动态研究和工具选择，才讨论Supervisor/MCP。
- SDK官方支持新的TS/OTel/Prisma主版本且通过本项目故障恢复验收。
- 多机器部署需要对象存储和高可用基础设施。

## 证据

[参考项目研究](../reference-research.md)、[版本兼容性](../dependency-compatibility.md)、[完整架构](../architecture.md)、[开发验收路线](../development-roadmap.md)。
