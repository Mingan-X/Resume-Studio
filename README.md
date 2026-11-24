# Resume Studio

面向求职者的简历分析与岗位匹配项目。目标是从简历中提取可定位的证据，生成六维能力画像，并结合岗位要求给出可解释的匹配结果与推荐。

**当前可运行范围是后端工程基础和基础设施诊断。** 简历上传、画像、岗位管理、召回、匹配和报告功能尚未实现；当前没有可使用的产品前端。

## 当前能力

- NestJS API 与独立 Worker 入口；Worker 当前为空进程，不消费业务任务。
- Zod 配置校验、健康检查、统一 HTTP 错误、服务端 requestId 和 JSON 日志。
- PostgreSQL/Prisma 诊断表与迁移、连接池与事务验证。
- RabbitMQ publisher confirm、mandatory return、手动 ACK、重投和重复消息集成测试。
- Qdrant 合成向量 CRUD、维数校验与基础设施持久化验证工具。
- 独立的 Docker Compose 项目、网络和数据卷；复用本地镜像，不连接其他项目实例。

## 规划功能

PDF/DOCX 文本解析 → 六维画像 → 结构化技能关键词与 Dense Vector 召回 → RRF 融合 → LLM 逐项判断 → 确定性评分 → 最多 Top 10 推荐与持久化报告。

六维包括技术深度、工程能力、业务理解、项目影响力、协作沟通和成长性。模型负责语义判断，普通代码负责计算与排序；证据不足应标记为 unknown。上述流程是目标设计，并非当前接口能力。

## 技术栈

| 用途 | 当前已接入 | 规划接入 |
|---|---|---|
| 服务与校验 | Node.js 24.22.3、TypeScript 6.0.3、NestJS 12.6.0、Zod 4.6.7 | — |
| 数据与消息 | PostgreSQL 16.15、Prisma 7.10.1、RabbitMQ 4.4.0、Qdrant 1.20.2 | 事务 Outbox、业务任务消费者 |
| AI 工作流与观测 | — | LangGraph.js、LangChain.js、PostgreSQL Checkpointer、Langfuse |
| 工程工具 | pnpm 12.23.0、ESLint、Node test runner、Docker Compose | — |

具体依赖以 package.json 和 pnpm-lock.yaml 为准；未来候选组合及兼容性边界见[依赖说明](docs/dependency-compatibility.md)。

## 架构概览

当前 API 与 Worker 共享配置和日志模块；基础设施适配器由独立诊断上下文使用，尚未接入业务请求。目标架构采用模块化单体和 API/Worker 双进程，通过 RabbitMQ 解耦长任务；业务状态、工作流 Checkpoint 和报告各自持久化。详见[架构设计](docs/architecture.md)。

## 本地运行

准备 Node.js 24.22.3 和 pnpm 12.23.0，在仓库根目录执行（PowerShell）：

```powershell
pnpm install --frozen-lockfile
pnpm run infra:init
pnpm run db:generate
if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
pnpm run build
pnpm run start:api
```

访问 [健康检查](http://127.0.0.1:3000/health)。另开终端运行 `pnpm run start:worker`；前台 Ctrl+C 关闭。

这条最小启动路径无需启动数据库或消息队列。infra:init 只生成本地配置，db:generate 只生成 Prisma 客户端，不连接数据库。健康检查仅表示 API 可响应，不承诺外部依赖就绪。

完整基础设施启动、专属端口、镜像要求和凭证管理见[本地部署](docs/deployment.md)。当前 Compose 为本地开发配置，不是生产部署方案。

## 检查与测试

```powershell
pnpm run typecheck
pnpm run lint
pnpm test
# 完成本地部署及迁移后执行：
pnpm run test:integration
```

测试覆盖范围与限制见[测试文档](docs/testing.md)。真实集成测试使用隔离数据，不以服务不可用为理由自动跳过。

## 文档

- [HTTP API](docs/api.md)
- [本地部署与配置](docs/deployment.md)
- [技术架构](docs/architecture.md)与[选型 ADR](docs/decisions/0001-tech-stack.md)
- [业务需求](docs/requirements.md)与[开发计划](docs/development-roadmap.md)
- [测试与验证](docs/testing.md)
- [开发与分支规范](CONTRIBUTING.md)
- [第三方设计参考](docs/reference-research.md)

## 来源与许可

业务设计参考 [Elpis](https://github.com/fsiaonma/elpis) 与 [Elpis Demo](https://github.com/fsiaonma/elpis-demo) 中的模块拆分、rubric 和证据化评分思想。项目不依赖 Elpis，也不复制其运行时或整套 rubric；静态源码分析的固定提交与边界保留在参考文档中。

各依赖遵循其自身许可证。本仓库尚未选定项目许可证，公开可见不代表授予额外使用许可。
