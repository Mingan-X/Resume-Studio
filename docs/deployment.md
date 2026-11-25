# 本地部署

本配置用于本地开发与隔离集成测试，不是生产部署方案。API/Worker在主机运行；Compose项目 `resume-studio` 管理业务三服务及可选Langfuse六服务。基础配置可单独使用，观测配置作为同项目overlay加载。

## 环境与镜像

Node.js **24.22.3**、兼容现有锁文件的 **pnpm 12.x**；Docker Desktop Linux 引擎或等效 Docker 环境，支持 Compose。当前验证平台为 Windows 主机与 linux/amd64 容器；其他平台尚未验证。

### 包管理器版本策略

- `package.json` 的 `engines.pnpm` 为 `>=12 <13`，不固定补丁版本，也不声明 `packageManager` 字段。已实际验证的版本是12.23.0（记录见[开发进度](progress.md)），其他12.x未验证。
- 依赖解析以提交的 `pnpm-lock.yaml` 为准，安装一律使用 `--frozen-lockfile`。锁文件中 `packageManagerDependencies` 段的pnpm 12.23.0快照按原样保留，不代表强制版本。
- 遇到元数据不匹配或工具版本选择问题时，记录实际版本和错误并提交维护审查；不用非冻结安装、忽略校验或手改锁文件绕过。
- 除明确批准的锁文件维护外，不修改依赖解析结果。

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

RabbitMQ与Qdrant按Compose中各自的完整引用执行同样操作。确认RepoDigests包含声明的仓库digest，镜像平台匹配运行环境；已验证平台为linux/amd64。只有tag相同或下载了latest不足以证明身份一致。若digest不存在或平台不符，停止并核实，不自行改tag/digest、覆盖服务或删除卷。

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

## S1.3 诊断组件初始化

### S1.3 Checkpointer 初始化（独立于业务进程）

在基础设施启动、`infra:provision` 与 `db:deploy` 完成后执行：

```powershell
pnpm run checkpoint:init
pnpm run build
pnpm run checkpoint:provision
pnpm run checkpoint:setup
```

`checkpoint:init` 只创建被忽略的 `infra/.env.checkpoint`，不覆盖已有文件或轮换密码。
`checkpoint:provision` 核对本项目PostgreSQL容器标签、运行状态、端口绑定、数据卷及卷标签，然后建立独立数据库 `resume_studio_checkpoint`、schema `langgraph` 和两个专用角色。数据库仍由本项目管理员持有；`resume_studio_checkpoint_setup` 持有schema并执行官方初始化，`resume_studio_checkpoint` 只有CONNECT、schema USAGE、三张状态表的读写及迁移版本表只读权限。不会把这些表加入Prisma迁移。

为隔离现有诊断业务库，provision撤销 `resume_studio_s12_test` 的PUBLIC CONNECT，保留其所有者 `resume_studio_test` 的连接权限；Checkpoint数据库也不允许业务账号连接。既有数据、诊断表、业务账号密码和迁移保持不变。新建角色/数据库带项目归属注释；同名但无归属标识的资源将被拒绝接管。

`checkpoint:setup` 只在显式命令或集成测试中调用官方 `PostgresSaver.setup()`，使用专用session advisory lock串行化初始化；API与Worker不执行DDL，也未接入该模块。生产升级期间仍须安排受控迁移，不把本地setup当作无停机升级方案。

| 配置 | 约束 |
|---|---|
| CHECKPOINT_DATABASE_URL | 本机55432端口、独立Checkpoint数据库、运行账号；不接受URL查询参数覆盖连接选项 |
| CHECKPOINT_SETUP_URL | 同库的setup账号，仅初始化时加载，不传给合成运行子进程 |
| CHECKPOINT_SCHEMA | 固定 `langgraph`，防止schema名称进入上游SQL时产生注入 |
| CHECKPOINT_POOL_MAX | 1–3，默认生成3 |

业务诊断池上限3，Checkpoint运行池上限3，单个同时持有两类池的进程最多6条连接；setup使用2条独立连接（锁+迁移）。多进程、测试父/子进程与运维连接都须另计入PostgreSQL总预算。池获取超时3秒、SQL超时5秒；关闭显式释放外部pg池。

D4于2026-11-25确定采用本地自托管Langfuse，T4/T5的实际部署及验证见下节。

### S1.3 本地 Langfuse 与独立启停

Langfuse与业务基础设施归在同一个Compose项目 **resume-studio**。`compose.observability.yaml`是叠加配置，六个服务均使用 `langfuse-*` 名称、`observability` profile及专属 `resume-studio_observability` 网络。业务三服务保持原default网络。Langfuse的PostgreSQL、Redis、ClickHouse及MinIO分别使用自己的账号和卷，不连接业务PostgreSQL、Checkpoint数据库或RabbitMQ。

```powershell
pnpm run observability:init
# 首次部署且本机缺少镜像时，显式拉取固定digest：
pnpm run observability:pull
pnpm run observability:config
pnpm run observability:up
pnpm run observability:status
pnpm run observability:stop
```

访问 `http://127.0.0.1:53000`。登录邮箱和随机密码位于被忽略的 `infra/.env.observability` 中的 `LANGFUSE_INIT_USER_EMAIL` / `LANGFUSE_INIT_USER_PASSWORD`，工具不打印秘密。首次初始化同时创建本地组织及 `resume-studio-diagnostics` 项目/API key；后续启动不轮换凭证。Web与MinIO API仅绑定127.0.0.1的53000/59090端口，其他服务没有主机端口；遥测、AI Gateway和实验功能关闭，未配置模型或云观测账号。

`infra:up/stop`明确指定postgres/rabbitmq/qdrant；`observability:up/stop`明确指定六个langfuse服务。profile负责选择，服务列表负责限制启停范围。不要用整个项目的 `down` 代替分组停止，也不要加 `--remove-orphans` 或删除数据卷。Web健康后才启动Langfuse Worker，避免新库迁移期间缺表。首次安装的上游数据库迁移可能超过240秒等待窗口；记录失败、核实迁移进度后再次运行up，不重置数据库。

观测脚本在操作前核对容器、网络和卷的Compose归属；全新环境由up显式创建五个专属卷，随后以external方式挂载，停止/重建容器不会删除这些卷。`pull`和`status`不创建卷。

2026-11-25合并部署时，保留了首次创建的五个 `resume-studio-observability_*` 卷，并在本机配置中用 `LANGFUSE_POSTGRES_DATA_VOLUME`、`LANGFUSE_REDIS_DATA_VOLUME`、`LANGFUSE_CLICKHOUSE_DATA_VOLUME`、`LANGFUSE_CLICKHOUSE_LOGS_VOLUME`、`LANGFUSE_MINIO_DATA_VOLUME`显式映射。旧卷名称/标签只表示来源，当前所有容器均属于resume-studio；归属检查逐项验证原标签和挂载位置，而非按名称前缀放行。新机器默认使用 `resume-studio_langfuse_*`。不要删除这些映射来修复启动问题，否则可能连到空卷。迁移保留原凭证，验证了旧trace可读后才移除旧容器与空网络；未删除任何卷。回滚所需的原Compose与资源快照保留在本机忽略目录 `data/observability-project-migration/`，回滚前必须停止新实例，禁止两个数据库进程同时挂载同一卷。

| 应用观测配置 | 含义 |
|---|---|
| OBSERVABILITY_ENABLED | 缺省false；显式启用时其余连接字段必须合法 |
| LANGFUSE_BASE_URL | 本阶段只接受 `http://127.0.0.1:53000` |
| LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY | 本地诊断项目凭证，禁止日志输出 |
| OBSERVABILITY_MAX_QUEUE_SIZE | 8–512，生成默认128；活动与等待导出的span共用容量 |
| OBSERVABILITY_EXPORT_TIMEOUT_MS | 100–5000毫秒，默认2000；每批一次HTTP尝试，包含响应读取 |

ObservabilityModule按需注册一个进程级provider；当前只在合成图测试中接入，API/空Worker仍不启动业务图或观测模块。允许明确的correlationId、固定节点名、状态和计数；输入/输出统一替换为REDACTED，自由元数据、异常/事件文本、资源属性和tracestate不导出。每批最多16个span、128KiB，一条请求在途；排队期限为单次超时的两倍，禁止重定向、自动重试和媒体上传。溢出、过期、传输失败、关闭和处理失败有独立丢失计数，stats可读取，flush/关闭输出不含原文的JSON计数。观测不提供可靠投递保证。

脱敏在span结束时、进入Langfuse异步处理及导出队列之前进行，不等于敏感输入从未存在于进程内存或活动span。容量限制涵盖已接纳的活动span及等待/在途导出；活动span本身没有该排队期限，只有进入exporter后开始计时。流量持续产生时flush也不代表有固定全局完成期限；当前只验证有限合成图和有界请求场景。

本机Docker约5.8GiB内存，已经验证合成写入，不代表长期运行或生产容量。部署镜像及兼容版本见依赖说明；故障和脱敏验收见测试文档。

### 完整集成的准备顺序

先完成上文基础设施初始化，再执行以下命令。它们用于准备验收环境，不是本次T6重新运行过的记录。

```powershell
pnpm run checkpoint:init
pnpm run build
pnpm run checkpoint:provision
pnpm run checkpoint:setup
pnpm run observability:init
# 若本机缺少已固定的观测镜像，先运行 observability:pull
pnpm run observability:config
pnpm run observability:up
pnpm run test:integration
```

完整集成要求三份本地配置和九个服务就绪；每次实际执行结果见[最新进度](progress.md)。不要把Compose健康与集成测试通过混为一谈。

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

启动脚本用Node env-file读取.env；入口先通过仅依赖Zod的配置模块校验，再动态加载各自应用装配。启动失败报告独立于Nest/AppLogger，缺配置或非法值时不会加载Nest；退出码为1，只输出安全错误码与字段名。`/health` 是 liveness；API与空Worker当前不自动连接诊断服务。Worker用可清理定时器保持存活，尚无业务消费者。

Ctrl+C触发应用关闭；关闭超过5秒退出失败。脚本/容器停止不应被当成持久化数据删除。

### 与前端联调

前端仓库为 [Resume-Studio-Frontend](https://github.com/Mingan-X/Resume-Studio-Frontend)。API保持默认的 `127.0.0.1:3000`，前端开发服务器把 `/api` 与 `/health` 代理到该地址，因此后端不需要也不应为联调开启CORS。约定见[接口契约规范](api-contract.md#3-部署拓扑与跨域)。

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

`pnpm run infra:stop`只停止postgres/rabbitmq/qdrant，`pnpm run observability:stop`只停止六个langfuse服务；对应up命令分别恢复。两组操作都保留数据卷，显式服务列表与代码入口见[scripts/infra-compose.mjs](../scripts/infra-compose.mjs)和[scripts/observability-compose.mjs](../scripts/observability-compose.mjs)。不要用不带服务名的整项目操作替代这些命令。

禁止删除数据卷、数据库、账号或本地凭证来处理连接问题。丢失任一 `infra/.env`、`infra/.env.checkpoint` 或 `infra/.env.observability` 后重新生成随机密码，不会同步修改已存在的账号；先安排凭证恢复，保留观测旧卷映射。现有本机迁移快照用于回滚参考，不构成已经验收的备份恢复流程。

目前凭证通过本地环境文件注入；Qdrant SDK对HTTP+API Key可能提示非HTTPS连接。仅绑定本机的开发配置不等于生产TLS或完善的权限方案。生产部署前还需认证、TLS、备份恢复、秘密管理、容量与高可用评估。

## 验证

执行 `pnpm run test:integration` 验证真实服务；不能以缺少服务为由跳过。完整覆盖及已有证据见[测试文档](testing.md)。持久化重启实验会写入合成数据并重启本项目容器，需单独安排执行，不作为常规文档检查的一部分。
