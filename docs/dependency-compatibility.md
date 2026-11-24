# 依赖与兼容性

版本核验日期：2026-11-23至2026-11-24。当前安装结果以package.json与pnpm-lock.yaml为准；本文区分已验证组合与未来候选，不默认安装所有latest。

[registry元数据快照](research/dependency-metadata-2026-11-23.json)保存36个候选包的Node engines及peer字段、66项直接范围检查结果。范围检查不代表完整传递依赖、安全审计或运行验收；快照包含当时考虑过的未安装组件。

## 1. 当前工程依赖

| 组件 | 精确版本 | 验证/限制 |
|---|---|---|
| Node.js / pnpm | Node24.22.3；pnpm12.x，实测12.23.0 | Node由engines/.node-version固定；pnpm采用兼容范围并移除精确packageManager声明，见[当前策略](deployment.md#包管理器版本策略)。2026-11-24在仓库外独立目录验证新元数据的冻结安装通过，原锁文件与副本均未改变；其他12.x及Corepack自动选择仍未验证 |
| Nest common/core/platform-express/testing | 12.6.0 | ESM与实际DI/HTTP测试通过；CLI/schematics未安装 |
| TypeScript / @types/node | 6.0.3 / 24.10.0 | NodeNext、严格类型检查及装饰器元数据通过 |
| ESLint / typescript-eslint / @eslint/js | 10.15.0 / 8.73.0 / 10.0.1 | flat config；当前TS落在parser支持区间 |
| rxjs / reflect-metadata | 7.8.2 / 0.2.2 | 满足Nest peer |
| Zod | 4.6.7 | 环境配置、HTTP和诊断消息边界 |
| Prisma CLI/client/adapter-pg | 7.10.1 | 三包同版；生成、迁移、CRUD与回滚验证通过 |
| pg / @types/pg | 8.23.1 / 8.23.1 | 与Prisma adapter共用兼容Pool类型；外部池在关闭时显式end |
| amqplib | 2.4.1 | 自带类型声明，不安装旧@types/amqplib；真实broker确认/重投测试 |
| Qdrant JS | 1.20.0 | Node>=22，与服务端1.20.2同minor；实际向量CRUD验证 |

测试使用Node自带node:test和node:assert，无Vitest/Jest转换链。Prisma CLI带入Studio/dev等上游传递依赖，不代表本项目启动这些组件或改用其他数据库。pnpm-workspace.yaml仅精确允许prisma与@prisma/engines安装脚本，不全局放开脚本策略。

## 2. 容器基线

| 服务 | 镜像版本 | digest |
|---|---|---|
| PostgreSQL 16.15 | pgvector/pgvector:pg16 | sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a |
| RabbitMQ 4.4.0 | rabbitmq:4.4.0-management | sha256:753099a19b577c322117f793f864b3129cbba96d40317221a69d73976e3c843c |
| Qdrant 1.20.2 | qdrant/qdrant:v1.20.2 | sha256:d277592721d2e3b73f9b797b53cf05e6a5bb2134f6d13fdbda4ca51782afbcac |

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
| Langfuse与OTel | Langfuse6.1.1要求core/trace-base2.x和exporter低于0.300；OTel最新线为3.x/0.301 | 待接入时选兼容2.x线并真实验证，不盲升所有latest |
| Langfuse服务端 | JS SDK6使用v4 API，要求服务端>=4.59.0 | 云端确认版本或自托管候选4.84.0；v3需保留适配SDK或安排升级 |
| Checkpointer边界 | 首次checkpoint尚未提交时可能EmptyInputError，复用thread_id不等于恢复 | 另存Task输入和幂等产物；按官方API续跑 |

未来候选（均未接入）：

| 用途 | 已核验候选 | 限制 |
|---|---|---|
| LangChain | core1.5.0、langchain1.6.7 | 直接peer范围满足；提供商适配未选择 |
| LangGraph | 1.7.5 | core^1.3.4、Zod3.25/4.2+；使用原生图API |
| Checkpoint | checkpoint1.2.3、checkpoint-postgres1.1.4 | 初始化setup、独立表/池和崩溃恢复仍待测试 |
| Langfuse SDK | tracing/otel/langchain6.1.1 | Node>=22，需匹配服务端及OTel |
| OpenTelemetry | api1.9.0、sdk-node0.223.2、core/trace-base2.12.1、exporter0.223.2 | API必须<1.10满足该2.x线；trace-base有版本弃用/迁移变化，接入前复核 |
| 模型适配器 | @langchain/openai1.8.5 | Node>=22、core^1.5.0；包兼容不代表选择了提供商或验证了兼容端点行为 |
| PDF解析 | pdfjs-dist6.5.438 | Node>=22.13；文本提取、双栏阅读顺序与容器原生依赖需样本验证 |
| DOCX解析 | mammoth1.13.0 | 只取文字，不直接展示未经净化HTML；表格与证据定位需验证 |

Rubric、LLM服务商/具体模型、Embedding模型与维数仍待确定。不能因候选包存在而生成凭证或声称模型API已可用。

Langfuse自托管包含web/worker、PostgreSQL、ClickHouse、Redis及对象存储，官方建议至少4核/16GiB；可能有可选gateway。其内部BullMQ/Redis属于上游观测平台，不作为业务队列。部署方式、附属镜像tag/digest和数据区域仍待决策。

## 4. 验证范围与限制

已核验的Node/peer范围、精确包安装、编译、Lint、真实HTTP和基础设施请求见[测试文档](testing.md)。近期官方发布记录支持这些组件仍有维护活动，但不等于安全审计结论。

保留的运行边界：Prisma CLI使用显式导出的prisma/build/index.js；Qdrant超时可能伴随服务端已创建资源，清理必须依据本轮唯一名称；SDK可能提示本地非HTTPS或后台版本探测超时，未关闭兼容性检查。不得通过放宽断言隐藏错误。

尚未完成完整依赖安全审计、其他平台冷安装、生产TLS/权限、多节点故障、业务Outbox/幂等、工作流恢复和真实模型评测。新组件接入前复核官方版本与最小运行实验，不以旧元数据快照替代当前验证。

## 5. 官方来源

- [Node发行索引](https://nodejs.org/dist/index.json)：版本、发布日期与LTS标识。
- [Nest v12迁移指南](https://docs.nestjs.com/migration-guide)：Node/CLI门槛、ESM、TypeScript与默认测试工具。
- [npm registry](https://registry.npmjs.org/)：精确查询URL及engines/peers保存于本目录的JSON证据。
- [Prisma系统要求](https://www.prisma.io/docs/orm/reference/system-requirements)、[Prisma7升级指南](https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/upgrading-to-prisma-7)：注意通用文档可能转向Prisma8，实际开发跟随7.x API。
- [LangGraph Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)、[Postgres持久化示例](https://docs.langchain.com/oss/javascript/langgraph/add-memory)：续跑、首次setup、durability边界。
- [RabbitMQ版本](https://www.rabbitmq.com/release-information)、[confirms](https://www.rabbitmq.com/docs/confirms)、[consumer timeout](https://www.rabbitmq.com/docs/consumers)、[DLX](https://www.rabbitmq.com/docs/dlx)、[quorum queues](https://www.rabbitmq.com/docs/quorum-queues)。
- [amqplib官方API](https://amqp-node.github.io/amqplib/channel_api.html)：publish返回值、confirm与manual ACK。
- [PostgreSQL生命周期](https://www.postgresql.org/support/versioning/)、[Qdrant官方release](https://github.com/qdrant/qdrant/releases/tag/v1.20.2)。
- [Langfuse SDK与兼容性](https://langfuse.com/docs/observability/sdk/typescript/overview)、[LangChain集成](https://langfuse.com/docs/integrations/langchain/tracing)、[Docker Compose](https://langfuse.com/self-hosting/deployment/docker-compose)、[官方Compose源码](https://github.com/langfuse/langfuse/blob/main/docker-compose.yml)、[4.84.0发布](https://github.com/langfuse/langfuse/releases/tag/v4.84.0)。
- [PDF.js官方仓库](https://github.com/mozilla/pdf.js)、[Mammoth官方仓库](https://github.com/mwilliamson/mammoth.js)：解析能力与安全边界；未运行样本。
