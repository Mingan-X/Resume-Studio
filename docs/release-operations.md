# S3.3发布与进程运维

D10确定单机Docker Compose、前后端同源。应用配置见[release Compose](../infra/release/compose.yaml)、[Dockerfile](../infra/release/Dockerfile)和[TLS代理模板](../infra/release/default.conf.template)。当前连接校验仍限定本项目loopback、端口、数据库/vhost、卷及网络；Linux Engine的host networking使应用容器继续使用这些已约束地址，不放宽到任意服务实例。此配置存在不代表目标服务器已部署，真实模型/embedding、浏览器TLS、Linux信号及目标环境容量仍待统一验收。

`pnpm run test:deployment`显式运行真实Docker CLI只读归属代理和就绪HTTP故障专项；保持串行。Windows fixture只适用于当前Docker Desktop Linux Engine管道，Linux分支使用/var/run/docker.sock，其他远端/Rootless引擎未验证。

## 镜像与密钥准备

从[release.env.example](../infra/release/release.env.example)在仓库外建立release.env，填入已核验的Node24.22.3、兼容Docker CLI（包含Compose插件）、nginx与应用镜像digest；不可把placeholder/tag/latest直接当发布身份。先核对官方镜像、平台和digest，再显式pull/build，Compose的pull_policy=never避免启动时隐式更新。Dockerfile默认使用已验证的pnpm12.23.0构建工具，PNPM_VERSION可选择兼容12.x；依赖始终冻结安装。构建只用无秘密占位配置执行Prisma generate，不连接数据库，不把宿主.env/data/生成目录复制进镜像。

在独立受限目录准备runtime.env、checkpoint.env、observability.env、models/*.json和tls/fullchain.pem/privkey.pem。示例仅包含占位符；真实值来自既有本机/目标环境配置及维护者提供的Key，不由AI代选模型或费用政策。只给应用运行账号数据库/Checkpoint/队列/观测项目凭证，不给PostgreSQL管理员或Checkpoint setup账号。两个env中的unused-ownership-render-only字段仅供原Compose解析卷配置，不用于初始化服务。

Compose secrets是本机文件挂载，**没有自动加密本地文件**。宿主目录仅部署管理员和容器UID1000所需访问，私钥及env不能对普通用户开放；配置轮换后重建相应容器并验证旧会话/任务兼容。Dockerfile包含完整构建依赖，镜像大小及开发依赖审计仍计入发布检查，不能宣称已最小化运行镜像。模型/embedding请求预算来自真实配置，缺少配置时进程明确失败。

## 部署顺序

1. 先按[本地部署流程](deployment.md)在目标主机核验并初始化本项目基础设施、账号、32条基线及后续迁移、官方Checkpointer和业务拓扑；只由宿主管理流程执行provision/setup。不得在应用容器里挂载完整Docker控制接口或管理员凭证。
2. 为明确账号owner导入已批准的rubric/scoring政策和语料，提供真实版本配置；STORAGE_DIRECTORY使用专用/srv/resume-studio/storage，并允许UID1000写入。前端构建产物部署到FRONTEND_DIST，只读挂载；不在后端仓库构建或改写前端。
3. 按Dockerfile显式build并保存不可变应用镜像引用；API/Worker与管理CLI使用同一提交。对release Compose执行`docker compose --env-file <私有release.env> -f infra/release/compose.yaml config --quiet`，仅quiet，不打印展开密钥。再显式up应用服务：ownership-reader、api、analysis-worker、index-worker、publisher、analysis-reconciler、index-reconciler、lifecycle、proxy；与基础设施使用同一项目，使用显式服务列表，不能remove-orphans/down整个项目。
4. 先确认ownership-reader健康、API /ready成功，再开放代理。nginx终止TLS、80重定向、前端静态资源和/api同源；Origin仍由API精确校验，不信任X-Forwarded-For、不开CORS。/ready只供本机探测，公网代理返回404。SSE禁用缓冲，读超时覆盖API的300秒连接周期；上传流式转发，11MiB代理上限包含multipart开销，应用仍执行10MiB文件限制。
5. 执行真实浏览器登录/CSRF/Secure Cookie、上传、任务创建/状态/SSE、取消、报告、重算和删除；没有真实模型产物的部分按既定延后清单保留。检查故障后Outbox/任务可恢复、备份隔离恢复和同源TLS，再由维护者验收。

## 归属代理与权限

ownership-reader是唯一挂载Docker socket的服务，提供固定loopback23750的只读元数据代理。[实现](../src/infrastructure/deployment/docker-read-proxy.ts)只接受版本/项目容器列表/本项目实例、卷和网络的查询，过滤其他项目，移除容器Env与日志字段；拒绝exec/start/stop/delete、日志和文件归档路径。每次仍由原有ownedPostgres/ownedRabbit/ownedQdrant/Langfuse校验标签、端口、挂载和卷，未关闭这些检查。管理员仍需核对所有项目资源和网络，旧工具的未覆盖范围没有自动消失。

Docker socket本身具有高权限，read_only挂载不限制Docker API；因此只放在隔离的专用代理服务，代理不读取应用密钥，应用只拿受限HTTP元数据。代理实现/镜像必须受代码审查，不能开放到0.0.0.0或宿主外网；宿主root与Docker管理员仍属于信任边界，不宣称能防御已控制宿主的攻击者。

## 监督、停机与告警

[监督入口](../scripts/process-supervisor.mjs)只接受七个固定角色，单进程串行运行子命令；Worker完成一个任务/会话后2秒再运行，发布批次同样循环；对账和生命周期使用已有watch。连续错误最多3次后非零退出，失败间隔2/4秒加0–999ms jitter；Compose再最多重启3次。业务任务持久重试次数、费用/token与总期限不会因此重置。达到上限后需要运营检查依赖和持久状态，再人工恢复进程，不能把循环重启当作无限任务重试。

SIGTERM转发给当前子进程，15秒未退出则强杀，Compose预留20秒；强杀不写“已停止”业务标记，后续必须按既有实际退出/fence规则对账。/ready检查DB SELECT1和两条业务队列可读，1秒缓存/合并并发；DB池1、连接/语句各2秒，AMQP总体2秒。它不会宣称模型、索引或Worker已就绪；Compose health=unhealthy也不会自动重启一个仍存活的API进程。

发布器和两类对账器依旧使用显式SERVICE_OWNER_ID，一个实例负责一个已核验账号。多账号部署必须为每个明确owner配置相应监督实例；不能用系统owner或“最近账号”兜底，也不能称默认一组进程已覆盖所有账号。生命周期扫描按其既有持久策略运行，DONE才表示删除完成，WAITING/RUNNING和未知外部写入须保留。

定期查看安全结构化日志、容器退出/健康、Outbox最老待发/失败、任务租约/重试/DLQ、删除步骤等待、观测丢失与磁盘余量。日志每容器10MiB×3只是本机起始限制，不是完整告警系统。备份、发布回滚及删除数据复活风险见[备份恢复手册](backup-recovery.md)。停止/清理必须显式核验项目/服务/卷/网络与本轮资源；不删除卷、数据库或本地配置来处理故障。

## S3.3-T8目标环境验收清单

维护者提供目标服务器后，先记录硬件/OS/磁盘、镜像、Git SHA、依赖锁与配置版本。串行运行基础测试3次、完整集成2次，原生Qdrant对照与默认Docker结果分开；逐轮保留失败，不以重新跑通覆盖旧结果。另核对同批次默认Docker Qdrant创建耗时是否满足原5秒要求，不能用现行15秒请求上限下通过替代L2解除。SocketTimeout根因仍未确认。全部成功且维护者核对后才改变L1/L2状态。

目标服务器尚未提供，以上目标回归、正式TLS/部署/回滚验证本阶段延后；本地已执行结果和失败只记录在[进度](progress.md)，不写成目标环境通过。
