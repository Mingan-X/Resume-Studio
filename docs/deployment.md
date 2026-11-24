# 本地部署

本配置用于本地开发与隔离集成测试，不是生产部署方案。API/Worker 在主机运行，PostgreSQL、RabbitMQ 与 Qdrant 由 Compose 项目 `resume-studio` 管理。

## 环境与镜像

Node.js **24.22.3**、pnpm **12.23.0**；Docker Desktop Linux 引擎或等效 Docker 环境，支持 Compose。当前验证平台为 Windows 主机与 linux/amd64 容器；其他平台尚未验证。

| 服务 | 镜像 | 主机端口 | 项目数据卷 |
|---|---|---|---|
| PostgreSQL 16.15 | pgvector/pgvector:pg16 | 127.0.0.1:55432 | resume-studio_postgres_data |
| RabbitMQ 4.4.0 | rabbitmq:4.4.0-management | 127.0.0.1:55672、55673 | resume-studio_rabbitmq_data |
| Qdrant 1.20.2 | qdrant/qdrant:v1.20.2 | 127.0.0.1:56333 | resume-studio_qdrant_data |

[compose.yaml](../infra/compose.yaml) 固定每个镜像的 digest，使用 `pull_policy: never`。已有相同镜像可直接复用；首次在新机器部署时先核对并获取其中声明的精确镜像。不要改接其他项目的容器或挂载其数据卷。PostgreSQL 镜像含 pgvector，但项目仍使用 Qdrant，不依赖该扩展。

## 初始化

在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm run infra:init
pnpm run infra:config
pnpm run infra:up
pnpm run infra:provision
pnpm run db:generate
pnpm run db:validate
pnpm run db:deploy
pnpm run db:status
```

- `infra:init` 生成 `infra/.env`，已有文件不覆盖。PostgreSQL 管理员、测试账号与 RabbitMQ/Qdrant 使用随机凭证，不打印密码，不修改根目录 `.env`。
- `infra:config` 仅验证配置，不输出展开后的凭证；不要把未脱敏的 `docker compose config` 输出上传到仓库或工单。
- `infra:up` 只启动本项目三个服务并等待健康检查。
- `infra:provision` 不接受容器名参数，仅解析本项目 Compose 服务并检查项目标签。建立非管理员诊断账号/数据库，配置 vhost 前缀权限，不轮换已有密码。
- `db:generate` 生成 `src/generated/prisma`，不连接数据库。生成目录不提交；首次构建前必须执行。
- `db:deploy` 使用现有迁移创建诊断表，重复执行不会重复建表。不要使用重置数据库命令替代迁移。

## API 与 Worker

```powershell
if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
pnpm run build
pnpm run start:api
# 另一个终端：
pnpm run start:worker
```

| 配置 | API | Worker | 说明 |
|---|---|---|---|
| APP_ENV | 必需 | 必需 | development / test / production |
| HTTP_PORT | 必需 | 不使用 | 十进制整数，1–65535 |
| HTTP_HOST | 默认127.0.0.1 | 不使用 | 支持127.0.0.1、0.0.0.0、::1；本地使用loopback |

启动脚本用 Node 的 env-file 读取 `.env`；缺少必需配置或值非法时退出码为1，只输出字段名。`/health` 是 liveness；API与空Worker当前不自动连接诊断服务。Worker用可清理定时器保持存活，尚无业务消费者。

Ctrl+C触发应用关闭；关闭超过5秒退出失败。脚本/容器停止不应被当成持久化数据删除。

## 诊断资源约定

为兼容现有配置和已应用迁移，保留以下固定标识，不能仅为改名而重建数据库：

| 类型 | 固定标识 |
|---|---|
| 数据库 | resume_studio_s12_test |
| PostgreSQL / RabbitMQ测试账号 | resume_studio_test |
| RabbitMQ vhost / INFRA_TEST_SCOPE | resume-studio-s12-test |
| 诊断表 | s12_diagnostic_record |
| RabbitMQ资源前缀 | s12. |
| Qdrant测试collection前缀 | s12_ |
| 持久化验证manifest | data/s12-persistence.json |

诊断配置只接受本机地址、上述账号/数据库/vhost和专属端口55432/55672/56333；每轮临时资源附UUID。数据库池最大3连接，连接获取超时3秒、SQL超时5秒；Qdrant调用超时5秒，发布确认超时5秒。

## 停止与数据保留

`pnpm run infra:stop` 停止本项目容器并保留卷；`pnpm run infra:up` 可重新启动。禁止删除数据卷、数据库、账号或本地凭证来处理连接问题。丢失 `infra/.env` 后重新生成随机密码不会修改已存在的服务账号，应先安排明确的凭证恢复流程。

目前凭证通过本地环境文件注入；Qdrant SDK对HTTP+API Key可能提示非HTTPS连接。仅绑定本机的开发配置不等于生产TLS或完善的权限方案。生产部署前还需认证、TLS、备份恢复、秘密管理、容量与高可用评估。

## 验证

执行 `pnpm run test:integration` 验证真实服务；不能以缺少服务为由跳过。完整覆盖及已有证据见[测试文档](testing.md)。持久化重启实验会写入合成数据并重启本项目容器，需单独安排执行，不作为常规文档检查的一部分。
