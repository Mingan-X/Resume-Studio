# 本地部署

本配置用于本地开发与隔离集成测试，不是生产部署方案。API/Worker 在主机运行，PostgreSQL、RabbitMQ 与 Qdrant 由 Compose 项目 `resume-studio` 管理。

## 环境与镜像

Node.js **24.22.3**、兼容现有锁文件的 **pnpm 12.x**；Docker Desktop Linux 引擎或等效 Docker 环境，支持 Compose。当前验证平台为 Windows 主机与 linux/amd64 容器；其他平台尚未验证。pnpm 12.23.0仅是2026-11-24实际测试使用的版本。

### 包管理器版本策略

`package.json` 的 `engines.pnpm` 为 `>=12 <13`，不强制固定补丁版本；移除原先精确指定12.23.0的 `packageManager` 字段，避免项目声明要求工具自动选用该精确版本。Node版本、依赖声明、脚本与严格peer校验策略不变。开发者自行准备范围内且支持当前锁文件格式及配置的pnpm；不声明所有12.x都已验证。

依赖解析以提交的 `pnpm-lock.yaml` 为准，安装继续使用 `--frozen-lockfile`。现有锁文件是多段YAML：应用依赖段之外，还保留先前生成的 `packageManagerDependencies` 中pnpm12.23.0快照。该快照按原样保留，不作为强制补丁版本政策。

2026-11-24已在仓库外空目录验证：复制当前package.json（无packageManager、engines.pnpm为`>=12 <13`）、锁文件、.npmrc和pnpm-workspace.yaml，使用Node24.22.3及现有pnpm12.23.0执行 `pnpm install --frozen-lockfile --store-dir <独立store目录> --state-dir <独立state目录> --reporter append-only`。使用独立node_modules/store/cache/state/config/temp及空的用户/全局npmrc，保留项目严格校验与Prisma脚本许可；未复制本地凭证，也未使用当前项目依赖目录。安装退出码0，342个包安装完成，19个直接依赖版本均匹配清单；安装后的清单、两份配置及锁文件与复制前逐字节一致。没有使用非冻结安装或跳过安装脚本。

该结果仅确认上述pnpm12.23.0、Node与Windows环境的冻结安装。没有验证其他pnpm12.x、Corepack自动选择或业务运行；不能保证其他工具对包管理器快照的处理相同。若出现元数据不匹配或工具版本选择问题，记录实际版本及错误并提交维护审查，不用非冻结安装、忽略校验或改锁文件绕过。网络下载速度警告不影响本次安装成功，但不构成性能保证。

依赖说明和元数据快照中的精确pnpm版本仅作为旧基线验证记录；本节与package.json定义当前策略。除明确批准的锁文件维护外，不修改依赖解析结果。

| 服务 | 镜像 | 主机端口 | 项目数据卷 |
|---|---|---|---|
| PostgreSQL 16.15 | pgvector/pgvector:pg16 | 127.0.0.1:55432 | resume-studio_postgres_data |
| RabbitMQ 4.4.0 | rabbitmq:4.4.0-management | 127.0.0.1:55672、55673 | resume-studio_rabbitmq_data |
| Qdrant 1.20.2 | qdrant/qdrant:v1.20.2 | 127.0.0.1:56333 | resume-studio_qdrant_data |

[compose.yaml](../infra/compose.yaml) 固定每个镜像的 digest，使用 `pull_policy: never`。已有相同镜像可直接复用；首次在新机器部署时先核对并获取其中声明的精确镜像。不要改接其他项目的容器或挂载其数据卷。PostgreSQL 镜像含 pgvector，但项目仍使用 Qdrant，不依赖该扩展。

### 首次获取与核对镜像

`pull_policy: never` 不会下载缺失镜像。先从Compose的每个 `image:` 逐字复制包含tag和digest的完整引用，再显式获取并检查；例如PostgreSQL当前引用为：

```powershell
docker pull 'pgvector/pgvector:pg16@sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a'
docker image inspect 'pgvector/pgvector:pg16@sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a' --format '{{json .RepoDigests}} {{.Os}}/{{.Architecture}}'
```

RabbitMQ与Qdrant按Compose中各自的完整引用执行同样操作。确认RepoDigests包含声明的仓库digest，镜像平台匹配运行环境；已验证平台为linux/amd64。只有tag相同或下载了latest不足以证明身份一致。若digest不存在或平台不符，停止并核实，不自行改tag/digest、覆盖服务或删除卷。以上是首次部署操作说明，本次文档修订未执行拉取。

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
- 初始化脚本的归属校验不自动覆盖所有清理入口；现有持久化cleanup仅使用连接范围和manifest定位资源，尚无独立Compose标签核验。执行前须核对目标实例与manifest归属，后续补强要求见[测试边界](testing.md#数据隔离与已知边界)。
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

这些是当前诊断实现的配置，不是业务任务的生产级吞吐或时延保证。基础设施配置还要求 `DATABASE_URL`、`RABBITMQ_URL`、`QDRANT_URL`、`QDRANT_API_KEY` 和 `INFRA_TEST_SCOPE`；由infra/.env提供，不向日志打印。未来任务级重试、总执行期限和连接恢复仍是待实现能力。

## 停止与数据保留

`pnpm run infra:stop` 停止本项目容器并保留卷；`pnpm run infra:up` 可重新启动。禁止删除数据卷、数据库、账号或本地凭证来处理连接问题。丢失 `infra/.env` 后重新生成随机密码不会修改已存在的服务账号，应先安排明确的凭证恢复流程。

目前凭证通过本地环境文件注入；Qdrant SDK对HTTP+API Key可能提示非HTTPS连接。仅绑定本机的开发配置不等于生产TLS或完善的权限方案。生产部署前还需认证、TLS、备份恢复、秘密管理、容量与高可用评估。

## 验证

执行 `pnpm run test:integration` 验证真实服务；不能以缺少服务为由跳过。完整覆盖及已有证据见[测试文档](testing.md)。持久化重启实验会写入合成数据并重启本项目容器，需单独安排执行，不作为常规文档检查的一部分。
