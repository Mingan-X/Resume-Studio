# Resume Studio Backend

面向求职者的简历分析与岗位匹配项目的后端。目标是从简历中提取可定位的证据，生成六维能力画像，并结合岗位要求给出可解释的匹配结果与推荐。

前端位于独立仓库 [Resume-Studio-Frontend](https://github.com/Mingan-X/Resume-Studio-Frontend)。本地建议把两个仓库放在同一父目录下：

```text
Resume-Studio/
  Resume-Studio-Backend/    # 本仓库：API、Worker、数据与任务基础设施，接口契约真源
  Resume-Studio-Frontend/   # Vue 3 前端
```

## 当前状态

**已完成 S1.1、S1.2、S1.3；S1.4 进行中，已实现开发身份、任务模型、合成任务创建/发布/消费、重试/隔离区及T6定时对账。简历上传、画像、岗位管理、召回、匹配和报告尚未实现。** 阶段状态见[开发计划](docs/development-roadmap.md)，验证记录见[开发进度](docs/progress.md)。

S1.3 附已知环境限制L1：本机项目与Docker数据位于机械硬盘，构建后首次运行 `pnpm test` 时API启动用例可能超过8秒而失败，重跑通过。该限制在部署服务器或硬件满足条件后重新验证，判断依据与处理规则见[开发进度](docs/progress.md)。

已有能力：

- NestJS API 与独立 Worker 入口；Worker 当前为空进程，不消费业务任务。
- Zod 配置校验、健康检查、统一 HTTP 错误、服务端 requestId 和 JSON 日志。
- PostgreSQL/Prisma 诊断表与迁移、连接池与事务验证。
- 可替换的开发单用户身份；独立 AnalysisTask/JobIndexTask 及共享任务记录模型；冻结输入与 Outbox 同事务写入、按所有者及任务类型隔离的请求幂等。TasksModule 仅显式注册到合成测试上下文，尚未接入 HTTP/Worker。
- Outbox短事务租约领取、confirm/mandatory/return检查、有限次数和总期限内的延迟重发；显式命令配置业务quorum队列/DLX并执行有界发布批次。
- `tasks:consume analysis` / `tasks:consume job-index`手动ACK消费；持久收据、执行租约/心跳和fence保护合成完成记录，数据库故障不ACK。当前是显式有界会话，未接入常驻Worker、真实业务图或Checkpoint联合隔离。
- 可恢复失败在事务中安排延迟重试；次数/时间/调用预算跨尝试累计，耗尽或永久失败写FAILED与dead Outbox。非法消息同事务保存脱敏隔离记录和dead事件后才ACK。
- `tasks:reconcile once|watch`扫描过期租约和长期未完成任务，检查执行锁后事务安排恢复，并调用既有Outbox发布器；保留发布失败预算，不抢占持锁执行，不操作Checkpoint。
- RabbitMQ publisher confirm、mandatory return、手动 ACK、重投和重复消息集成测试。
- Qdrant 合成向量 CRUD、维数校验与基础设施持久化验证工具。
- 官方 PostgreSQL Checkpointer：独立数据库/schema、运行与初始化账号、受控 setup；合成子进程强制终止后的续跑与首 Checkpoint 缺失恢复测试。
- Docker Compose统一在resume-studio项目下管理；Langfuse使用observability profile、专属网络和数据卷，业务与观测可分别启停。
- 观测span白名单脱敏、有界导出队列及失败计数；本地Langfuse不可用时合成业务图仍成功。

## 目标流程

PDF/DOCX 文本解析 → 六维画像 → 结构化技能关键词与 Dense Vector 召回 → RRF 融合 → LLM 逐项判断 → 确定性评分 → 最多 Top 10 推荐与持久化报告。

六维包括技术深度、工程能力、业务理解、项目影响力、协作沟通和成长性。模型负责语义判断，普通代码负责计算与排序；证据不足标记为 unknown。

## 技术栈

| 用途 | 当前已接入 | 规划接入 |
|---|---|---|
| 服务与校验 | Node.js 24.22.3、TypeScript 6.0.3、NestJS 12.6.0、Zod 4.6.7 | OpenAPI生成（决策D8） |
| 数据与消息 | PostgreSQL 16.15、Prisma 7.10.1、RabbitMQ 4.4.0、Qdrant 1.20.2；合成任务、事务Outbox、发布/消费/重试、隔离区与对账 | Checkpoint联合隔离 |
| AI 工作流与观测 | LangGraph 1.7.5、LangChain core 1.5.1、PostgreSQL Checkpointer 1.1.4、Langfuse SDK 6.1.1/本地服务4.84.0、OTel 2.x（合成图验证） | 业务工作流、模型适配 |
| 工程工具 | pnpm 12.x、ESLint、Node test runner、Docker Compose | — |

具体依赖以 package.json 和 pnpm-lock.yaml 为准；候选组合及兼容性边界见[依赖说明](docs/dependency-compatibility.md)。

## 本地运行

准备 Node.js 24.22.3 和 pnpm 12.x（策略见[包管理器版本策略](docs/deployment.md#包管理器版本策略)）。在仓库根目录执行（PowerShell）：

```powershell
pnpm install --frozen-lockfile
pnpm run infra:init
pnpm run db:generate
if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
pnpm run build
pnpm run start:api
```

访问 [健康检查](http://127.0.0.1:3000/health)。另开终端运行 `pnpm run start:worker`；前台 Ctrl+C 关闭。

这条最小启动路径无需启动数据库或消息队列：infra:init 只生成本地配置，db:generate 只生成 Prisma 客户端。健康检查仅表示 API 可响应，不表示外部依赖就绪。完整基础设施启动见[本地部署](docs/deployment.md)；当前 Compose 只用于本地开发。

## 检查与测试

```powershell
pnpm run typecheck
pnpm run lint
pnpm test
# 完成基础设施、Checkpoint初始化及本地Langfuse部署后执行：
pnpm run test:integration
```

覆盖范围与限制见[测试文档](docs/testing.md)。真实集成测试不以服务不可用为理由自动跳过。

业务三服务使用 `pnpm run infra:up` / `pnpm run infra:stop`，Langfuse六服务使用 `pnpm run observability:up` / `pnpm run observability:stop`。两组属于同一Compose项目，各自使用明确的服务列表；初始化、凭证位置和卷迁移说明见[部署文档](docs/deployment.md#s13-本地-langfuse-与独立启停)。

## 文档

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 工程约定，AI 与人工开发都必须遵守 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 分支、提交与验收流程 |
| [开发计划](docs/development-roadmap.md) | 阶段、任务拆分、验收标准、待决策事项 |
| [开发进度](docs/progress.md) | 已完成工作与验证记录 |
| [业务需求](docs/requirements.md) | 目标行为与验收 |
| [技术架构](docs/architecture.md) / [选型 ADR](docs/decisions/0001-tech-stack.md) | 模块、工作流、一致性与评分设计 |
| [接口契约规范](docs/api-contract.md) | 前后端共同遵守的接口约定 |
| [HTTP API](docs/api.md) | 已实现的接口 |
| [本地部署](docs/deployment.md) | 环境、镜像、初始化与联调 |
| [测试与验证](docs/testing.md) | 测试命令、覆盖与边界 |
| [依赖说明](docs/dependency-compatibility.md) | 版本与兼容约束 |
| [第三方设计参考](docs/reference-research.md) | Elpis 源码研究 |

## 来源与许可

业务设计参考 [Elpis](https://github.com/fsiaonma/elpis) 与 [Elpis Demo](https://github.com/fsiaonma/elpis-demo) 中的模块拆分、rubric 和证据化评分思想。项目不依赖 Elpis，也不复制其运行时或整套 rubric；静态源码分析的固定提交与边界保留在参考文档中。

各依赖遵循其自身许可证。本仓库尚未选定项目许可证，公开可见不代表授予额外使用许可。
