# 依赖与兼容性

版本与接入记录覆盖2026-11-23至2026-11-25。当前声明以[package.json](../package.json)、解析及补丁哈希以[pnpm-lock.yaml](../pnpm-lock.yaml)为准；本文区分已接入组合与未来候选。T6仅核对本地声明和既有验证记录，不把旧registry快照称为本次在线版本查询。

[registry元数据快照](research/dependency-metadata-2026-11-23.json)保存36个候选包的Node engines及peer字段、66项直接范围检查结果。范围检查不代表完整传递依赖、安全审计或运行验收；快照包含当时考虑过的未安装组件。

## 1. 当前工程依赖

| 组件 | 精确版本 | 验证/限制 |
|---|---|---|
| Node.js / pnpm | Node24.22.3；pnpm12.x，实测12.23.0 | Node由engines/.node-version固定；pnpm采用兼容范围，见[当前策略](deployment.md#包管理器版本策略)；其他12.x及Corepack自动选择未验证 |
| Nest common/core/platform-express/testing | 12.6.0 | ESM与实际DI/HTTP测试通过；CLI/schematics未安装 |
| TypeScript / @types/node | 6.0.3 / 24.10.0 | NodeNext、严格类型检查及装饰器元数据通过 |
| ESLint / typescript-eslint / @eslint/js | 10.15.0 / 8.73.0 / 10.0.1 | flat config；当前TS落在parser支持区间 |
| rxjs / reflect-metadata | 7.8.2 / 0.2.2 | 满足Nest peer |
| Zod | 4.6.7 | 环境配置、HTTP和诊断消息边界 |
| Prisma CLI/client/adapter-pg | 7.10.1 | 三包同版；生成、迁移、CRUD与回滚验证通过 |
| pg / @types/pg | 8.23.1 / 8.23.1 | 与Prisma adapter共用兼容Pool类型；外部池在关闭时显式end |
| amqplib | 2.4.1 | 自带类型声明，不安装旧@types/amqplib；真实broker确认/重投测试 |
| Qdrant JS | 1.20.0 | Node>=22，与服务端1.20.2同minor；实际向量CRUD验证 |
| LangChain core / LangGraph | 1.5.1 / 1.7.5 | 合成StateGraph已运行；core有仅声明补丁，未接入提供商模型 |
| Checkpoint / PostgreSQL saver | 1.2.3 / 1.1.4 | 官方setup、独立账号/池、合成子进程恢复已验证 |
| @standard-schema/spec | 1.1.0 | 显式补足Nest声明引用，兼容LangGraph所用协议 |
| @langfuse/core、otel、tracing、langchain | 均6.1.1 | 本地服务4.84.0，合成callback/手工span关联与脱敏读回已验证 |
| @opentelemetry/api | 1.9.0 | 满足SDK2.x的 `<1.10` peer范围 |
| @opentelemetry/core、resources、sdk-trace-base、sdk-trace-node | 均2.12.1 | 显式provider，不启用自动instrumentation或业务进程注册 |
| @opentelemetry/exporter-trace-otlp-http、otlp-exporter-base、otlp-transformer | 均0.223.2 | 前两包满足Langfuse peer；实际发送采用官方JSON序列化与有界fetch适配器 |

测试使用Node自带node:test和node:assert，无Vitest/Jest转换链。Prisma CLI带入Studio/dev等上游传递依赖，不代表本项目启动这些组件或改用其他数据库。pnpm-workspace.yaml仅精确允许prisma与@prisma/engines安装脚本，不全局放开脚本策略。

## S1.3-T1 接入记录（2026-11-25）

新增并固定 LangGraph 1.7.5、core 1.5.1、checkpoint 1.2.3、checkpoint-postgres 1.1.4。接入前重新查询npm registry的latest、engines、peer及发布时间；core已从旧候选1.5.0更新到1.5.1。LangGraph的core范围为^1.3.4，Postgres适配器要求core ^1.1.44及checkpoint ^1.2.0；当前Node 24.22.3和Zod 4.6.7满足声明范围。checkpoint直接声明用于满足严格peer安装和固定官方协议版本，不自建持久化实现。

另显式声明@standard-schema/spec 1.1.0：NestJS 12.6.0的context-utils.d.ts引用它但包清单未声明；全新安装揭示了这一类型依赖。它同时是LangGraph使用的标准Schema协议，成本仅为类型包。

真实编译发现上游声明与exactOptionalPropertyTypes不兼容，使用pnpm patchedDependencies维护两份仅声明文件补丁：

- core 1.5.1：AIMessageFields.usage_metadata与实现类的一致性，Zod V3兼容接口的可选description允许undefined。
- 传递依赖langsmith 0.14.0：BaseRun/RunUpdate.events与RunTree/Tracer声明的一致性。

补丁文件位于[core补丁](../patches/@langchain__core@1.5.1.patch)与[langsmith补丁](../patches/langsmith@0.14.0.patch)，由[pnpm-workspace.yaml](../pnpm-workspace.yaml)的patchedDependencies引用，哈希写入锁文件，已随S1.3任务本地提交。补丁不修改上游JS运行逻辑，不开启skipLibCheck，不关闭exactOptionalPropertyTypes，不忽略peer。升级时必须复核并在上游修复后移除补丁。LangSmith仅为上游传递依赖，观测合成图显式关闭其tracing，未配置其云服务。

依赖与锁文件经冻结安装、编译核验；完整测试结果见[进度](progress.md)。此处的真实验证优先于下方2026-11-23保留的候选表，Langfuse接入记录见下节，模型适配器仍未接入。

## S1.3-T4/T5 观测接入（2026-11-25）

重新核对npm registry后固定@langfuse/core、otel、tracing、langchain 6.1.1；OTel api 1.9.0、core/resources/sdk-trace-base/sdk-trace-node 2.12.1、exporter-trace-otlp-http/otlp-exporter-base/otlp-transformer 0.223.2。API 1.10.0不满足2.x SDK的<1.10 peer，未升级。@langfuse/langchain的core ^1.0.0兼容现有1.5.1；Node24满足>=22。严格peer和冻结安装保持开启。

用途：官方Langfuse CallbackHandler和SpanProcessor负责语义映射，OTel NodeTracerProvider管理上下文；直接使用官方JsonTraceSerializer输出OTLP。默认SDK传输包含重试且未暴露所需的统一容量预算，因此采用本项目小型有界exporter：单次fetch、请求/响应上限、排队期限、丢失计数；没有自研trace协议或Agent运行时。代价是该适配器需要故障测试并随SDK升级复核。Langfuse SDK默认媒体功能与日志被显式关闭，避免绕过脱敏导出路径。

服务采用官方v4.84.0 Compose结构的最小观测组件：web/worker同版4.84.0，ClickHouse26.3.62.3、Redis7-alpine、MinIO和现有兼容PostgreSQL16镜像（仅复用镜像，新实例/卷独立）。所有镜像固定拉取所得digest并设置pull_policy: never，实际引用在[观测Compose](../infra/compose.observability.yaml)。官方模板来源固定到v4.84.0标签；未启动AI Gateway或模型服务。健康接口返回4.84.0，SDK导出的合成span通过v2 observations接口读回验证。

资源限制：本机Docker总内存约5.8GiB，验证仅为合成诊断，不代表官方建议规模或生产容量。首次数据库迁移超出初始等待窗口后完成，未删卷；HOSTNAME显式0.0.0.0，宿主机只绑定127.0.0.1，worker等待web健康。

## 2. 容器基线

| 服务 | 镜像版本 | digest |
|---|---|---|
| PostgreSQL 16.15 | pgvector/pgvector:pg16 | sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a |
| RabbitMQ 4.4.0 | rabbitmq:4.4.0-management | sha256:753099a19b577c322117f793f864b3129cbba96d40317221a69d73976e3c843c |
| Qdrant 1.20.2 | qdrant/qdrant:v1.20.2 | sha256:d277592721d2e3b73f9b797b53cf05e6a5bb2134f6d13fdbda4ca51782afbcac |

观测组的镜像身份直接以[compose.observability.yaml](../infra/compose.observability.yaml)为唯一清单，避免复制digest漂移。Langfuse PostgreSQL复用上表镜像但使用独立容器/账号/卷；Redis7-alpine与MinIO的tag不表示固定补丁版本，实际身份由digest固定。旧卷的显式映射和保留原标签规则见[部署文档](deployment.md#s13-本地-langfuse-与独立启停)。

验证环境为Docker29.9.3、Compose5.7.0、linux/amd64容器。镜像可复用，实例/网络/数据卷按项目隔离。Compose固定digest并pull_policy: never，冷启动环境需要先准备镜像。PostgreSQL镜像中附带的pgvector未用于替代Qdrant。

服务健康、数据库迁移重复部署和读写、AMQP往返、Qdrant请求及容器重启持久化已有验证记录，详见[测试文档](testing.md)。单节点quorum队列不等于多节点高可用，当前本机HTTP配置不等于生产TLS验证。

## 3. 兼容约束与待接入候选

| 约束 | 证据 | 处理 |
|---|---|---|
| Node运行时下限 | Nest核心engines>=20，但新版Qdrant/Langfuse/PDF.js等需要22+；Nest CLI的schematics门槛高于core | 当前24.22.3满足已查需求；不只看core的engines |
| TS与Lint工具链 | 核验时TS latest7.0.2超出typescript-eslint8.73.0的>=4.8.4且<6.1.0范围；Nest schematics12要求TS6 | 固定TS6.0.3，禁止强制忽略peer冲突 |
| Prisma版本组 | 核验时CLI latest指向8.0.0-rc.35，而client/adapter稳定组为7.10.1 | 三包固定7.10.1，使用7.x API，不混入8 RC文档接口 |
| Prisma7接线 | 官方要求driver adapter和prisma.config；pg池没有默认连接超时 | PrismaPg显式接入pg池、上限与超时；生成目录明确指定 |
| pg类型一致性 | adapter解析的@types/pg8.23.1比8.16.0多出ClientBase方法，外部Pool类型不一致 | 显式对齐8.23.1，不用any或关闭严格检查 |
| Langfuse与OTel | Langfuse6.1.1要求core/trace-base2.x和exporter低于0.300；OTel最新线为3.x/0.301 | 已接入兼容2.x线并完成合成验证，详见T4/T5记录 |
| Langfuse服务端 | JS SDK6使用v4 API，要求服务端>=4.59.0 | 已部署4.84.0并验证SDK6.1.1；v3升级仍需单独安排 |
| Checkpointer边界 | 首次checkpoint尚未提交时可能EmptyInputError，复用thread_id不等于恢复 | 另存Task输入和幂等产物；按官方API续跑 |

仍未接入的候选如下。版本来自2026-11-23/24的研究，不是当前最新版本承诺；正式接入时重新核验。完整历史候选保留在registry元数据快照，已接入组件以第1节及S1.3记录为准。

| 用途 | 已核验候选 | 限制 |
|---|---|---|
| LangChain高层包 | langchain1.6.7 | 当前只需已安装的core，不为候选清单额外安装 |
| OpenTelemetry NodeSDK | sdk-node0.223.2 | 当前使用已安装的sdk-trace-node 2.12.1，不需要自动探测/自动instrumentation |
| 模型适配器 | @langchain/openai1.8.5 | Node>=22、core^1.5.0；包兼容不代表选择了提供商或验证了兼容端点行为 |
| PDF解析 | pdfjs-dist6.5.438 | Node>=22.13；文本提取、双栏阅读顺序与容器原生依赖需样本验证 |
| DOCX解析 | mammoth1.13.0 | 只取文字，不直接展示未经净化HTML；表格与证据定位需验证 |
| OpenAPI生成（决策D8） | @asteasolutions/zod-to-openapi（工具已确认，安装版本待T9复核） | 2026-11-26维护者确认使用该工具；历史2026-11-24候选9.1.0/peer `zod ^4.0.0`不是本次已验证版本。T9重新核对并安装/编译；当前尚未安装 |

Rubric、LLM服务商/具体模型、Embedding模型与维数仍待确定。不能因候选包存在而生成凭证或声称模型API已可用。

Langfuse自托管包含web/worker、PostgreSQL、ClickHouse、Redis及对象存储，官方建议至少4核/16GiB；可能有可选gateway。其内部BullMQ/Redis属于上游观测平台，不作为业务队列。部署方式于2026-11-25确定为本地独立自托管；附属镜像tag/digest和实际接线已在S1.3-T4完成，采用同项目profile与独立数据/网络。

## 4. 验证范围与限制

已核验的Node/peer范围、精确包安装、编译、Lint、真实HTTP和基础设施请求见[测试文档](testing.md)，每次实际运行结论见[开发进度](progress.md)。接入时查询的发布时间不等于安全审计结论，也不表示本次T6重新检查了上游维护状态。

完整回归结论统一见[开发进度](progress.md)。本机Qdrant创建曾超过现有5秒限制，历史通过不代表环境问题已解决；T7不升级依赖或放宽超时，重点修复入口和清理行为。

保留的运行边界：Prisma CLI使用显式导出的prisma/build/index.js；Qdrant超时可能伴随服务端已创建资源，清理必须依据本轮唯一名称；SDK可能提示本地非HTTPS或后台版本探测超时，未关闭兼容性检查。不得通过放宽断言隐藏错误。

尚未完成完整依赖安全审计、其他平台冷安装、生产TLS/权限、多节点故障、业务Outbox/幂等、真实业务工作流恢复和真实模型评测。新组件接入前复核官方版本与最小运行实验，不以旧元数据快照替代当前验证。

## 5. 官方来源

- [Node发行索引](https://nodejs.org/dist/index.json)：版本、发布日期与LTS标识。
- [Nest v12迁移指南](https://docs.nestjs.com/migration-guide)：Node/CLI门槛、ESM、TypeScript与默认测试工具。
- [npm registry](https://registry.npmjs.org/)：精确查询URL及engines/peers保存于本目录的JSON证据。
- [Prisma系统要求](https://www.prisma.io/docs/orm/reference/system-requirements)、[Prisma7升级指南](https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/upgrading-to-prisma-7)：注意通用文档可能转向Prisma8，实际开发跟随7.x API。
- [LangGraph Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)、[Postgres持久化示例](https://docs.langchain.com/oss/javascript/langgraph/add-memory)：续跑、首次setup、durability边界。
- [RabbitMQ版本](https://www.rabbitmq.com/release-information)、[confirms](https://www.rabbitmq.com/docs/confirms)、[consumer timeout](https://www.rabbitmq.com/docs/consumers)、[DLX](https://www.rabbitmq.com/docs/dlx)、[quorum queues](https://www.rabbitmq.com/docs/quorum-queues)。
- [amqplib官方API](https://amqp-node.github.io/amqplib/channel_api.html)：publish返回值、confirm与manual ACK。
- [PostgreSQL生命周期](https://www.postgresql.org/support/versioning/)、[Qdrant官方release](https://github.com/qdrant/qdrant/releases/tag/v1.20.2)。
- [Langfuse SDK与兼容性](https://langfuse.com/docs/observability/sdk/typescript/overview)、[LangChain集成](https://langfuse.com/docs/integrations/langchain/tracing)、[Docker Compose](https://langfuse.com/self-hosting/deployment/docker-compose)、[官方Compose源码v4.84.0](https://github.com/langfuse/langfuse/blob/v4.84.0/docker-compose.yml)、[4.84.0发布](https://github.com/langfuse/langfuse/releases/tag/v4.84.0)。
- [PDF.js官方仓库](https://github.com/mozilla/pdf.js)、[Mammoth官方仓库](https://github.com/mwilliamson/mammoth.js)：解析能力与安全边界；未运行样本。
