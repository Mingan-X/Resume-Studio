# 测试与验证

当前测试使用 TypeScript 编译产物和 Node 内置 test runner，Nest testing用于创建应用上下文；没有额外的测试转换器。真实集成测试连接独立的本项目容器，不使用其他项目实例。

## 当前验收状态

以[开发进度中的最新验收/回归记录](progress.md)为准，本文只维护检查方式与覆盖边界，不复制运行计数。

## 执行命令

首次安装依赖后，先运行 `pnpm run infra:init` 和 `pnpm run db:generate`。生成步骤无需连接数据库；运行集成测试前按[部署文档](deployment.md)启动服务并应用迁移。

依赖安装使用 `pnpm install --frozen-lockfile`，包管理器遵循[pnpm版本策略](deployment.md#包管理器版本策略)。

```powershell
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run test:integration
```

S1.3的真实恢复测试还需要先执行 `checkpoint:init`、构建、`checkpoint:provision`、`checkpoint:setup`，步骤见[部署文档](deployment.md#s13-checkpointer-初始化独立于业务进程)。真实观测测试先执行 `observability:init`、`observability:up` 并确认六个langfuse服务健康。集成命令加载 `infra/.env`、`infra/.env.checkpoint` 和 `infra/.env.observability`，缺配置或缺服务时失败，不跳过。

`pnpm test`编译后执行顶层测试文件，不要求外部服务；`test:integration`读取上述三份被忽略的配置并执行真实服务测试，服务不可用会失败而非跳过。

真实服务测试文件使用 `--test-concurrency=1` 顺序运行，以减少三组测试共享本机Docker资源时的竞争。并行执行曾出现Qdrant创建超过5秒，但串行后仍复发；专项排查还确认停止观测服务后仍可能超时，不能只归因于测试并发或Langfuse。只限制文件之间的调度，各用例的池并发、重投、强杀与超时断言不变；不将串行验收描述为同时满负载验证。

## 覆盖范围

| 测试 | 验证内容 |
|---|---|
| test/config.test.ts | 配置转换、必需字段、非法端口、未知环境、秘密字段排除 |
| test/http.test.ts | 编译后的Nest依赖注入、实际HTTP、400/404/500契约、非法JSON、并发requestId隔离 |
| test/process.test.ts | API/Worker真实子进程的启动失败、正常启动、关闭、日志脱敏与端口释放；registerHooks记录缺配置/非法配置时未加载Nest或bootstrap |
| test/infrastructure-config.test.ts | 拒绝外部地址、其他数据库/vhost、管理员账号及非项目端口 |
| test/integration/infrastructure.test.ts | Prisma CRUD/唯一约束/回滚/池关闭；RabbitMQ确认/return/ACK/重投/重复投递；Qdrant CRUD/维数错误及有界对账清理 |
| test/qdrant-cleanup.test.ts | 真实HTTP桩迟到创建后精确删除、未确认结果的manifest与失败、归属拒绝及项目/服务/端口/卷校验 |
| test/checkpoint-config.test.ts | 运行/初始化账号分离、连接范围、schema白名单、池上限及配置错误不泄漏值 |
| test/integration/checkpoint.test.ts | 官方setup重复执行、数据库权限隔离、运行账号DDL拒绝、池关闭；真实子进程强制终止后的续跑和首Checkpoint缺失时恢复 |
| test/observability.test.ts | 配置白名单；实际HTTP捕获OTLP并检查关联与脱敏；断连、超时、503和部分拒绝；200个span冲击8容量及关闭释放 |
| test/integration/observability.test.ts | 核对本项目容器/网络/卷、健康及诊断项目身份；Nest ObservabilityModule运行合成图，查询Langfuse已持久化的callback/手工span及原文脱敏 |

`checkpoint-worker.fixture.ts`仅是测试子进程入口。合成输入独立保存在既有诊断表，图状态只保存UUID、数值和步骤；不含简历、模型请求或真实业务任务。中途终止用例先从PostgreSQL确认首节点状态已持久化，再强杀子进程，等待进程退出后以同thread和 `invoke(null, config)` 续跑，通过独立执行记录验证已完成节点没有重复运行。首次Checkpoint用例在官方saver首次put前设置测试屏障并强杀，确认thread不存在后从独立保存的输入启动。屏障不属于生产实现，也不证明任意外部副作用恰好一次。

新测试清理前等待其子进程全部退出，再重新检查容器/端口/卷归属，只使用本轮随机UUID调用官方 `deleteThread` 和删除对应诊断记录。T7只为infrastructure.test.ts的Qdrant路径补齐归属与对账清理，持久化辅助工具的历史限制仍保留。合成子进程关闭LangSmith tracing，不使用LLM或外部观测。

每次运行的测试总数、通过/失败数、耗时及残留检查统一记在[开发进度](progress.md)，不在本页维护副本。断言验证行为，不以源码文本匹配代替运行验证。

真实Langfuse测试通过HTTP查询全部导出span的持久化结果，检查traceId、parentObservationId与correlationId，同时确认模拟电话、邮箱和密钥未出现在返回数据中。测试只删除本次随机trace，删除请求由上游异步处理；不删除整个项目或共享卷。合成图不请求模型。独立启停/迁移属于主动环境实验，实际结果记录在进度中，不在普通测试中自动停止用户的服务。

### 集成测试辅助设施

`test/integration/persistence.fixture.ts`是通过 `infra:persistence` 手动调用的辅助工具，不是 `*.test.ts` 用例，不计入自动测试统计。它创建专属记录、消息与向量，以manifest保留本轮资源ID，供容器重启后的verify和cleanup使用；具体步骤见下文。拥有辅助工具不代表每次测试都会运行重启验证。

## 验证记录

每次实际运行的检查、环境与结果记录在[开发进度](progress.md)，本文不重复保存。记录只代表当时的环境；后续变更应重新运行适用检查。

## 数据隔离与已知边界

测试数据库/vhost使用固定诊断标识，临时记录、队列和collection附本轮UUID，清理只针对本轮创建资源。不要删除整个数据库、数据卷或全部前缀资源来通过测试。

初始化与清理均应核实实例归属。T7的Qdrant集成测试在创建前及删除前验证Compose项目、qdrant服务、127.0.0.1:56333映射、storage挂载和卷标签；集合名由本轮UUID确定，拒绝任意名称。Checkpoint与Langfuse使用各自已有检查。旧persistence.fixture.ts仍只校验连接范围和manifest，未独立验证Docker标签或manifest来源，不应向未知实例执行其cleanup。

Qdrant客户端创建超时保持5秒。T7在创建失败后独立进行最长15秒的清理对账，每次HTTP请求不超过5秒且受剩余期限约束；第一次exists=false仍继续等待，出现后检查归属并精确删除、确认消失。对账成功也不覆盖原创建失败，原测试仍失败。到期无法确认或归属不符时，在data/qdrant-cleanup/<runId>.json保留schemaVersion、project、service、runId、精确collection、原因及时间，并抛出QDRANT_CLEANUP_PENDING；不保存凭证。原始错误与清理错误同时发生时保留两者。

manifest是待处理证据，不自动授权后续删除。后续操作必须核对文件内容、执行记录和目标实例归属，只处理该条精确名称，确认删除后才清除此manifest；禁止按s12前缀批量删除。创建在对账期限之外完成仍可能留存，因此保留manifest并明确失败，不承诺任意迟到创建都会在本次进程内清理。真实回归后只读统计s12_*残留，并把数量写入progress。

Qdrant SDK可能对HTTP+API Key发出提示，后台版本查询也出现过超时。保持兼容性检查开启；服务端版本由固定镜像及实际请求核验，不将警告等同于全部网络稳定。

Windows子进程关闭测试通过私有IPC触发与SIGINT/SIGTERM共用的关闭函数；未宣称验证Linux信号行为。测试专用500路由不包含在正常应用模块中。

## 持久化重启验证

以下实验需主动执行，会重启本项目容器；不应对其他项目实例运行。先确认没有未清理的data/s12-persistence.json，再执行：

```powershell
pnpm run build
pnpm run infra:persistence prepare
docker compose --env-file infra/.env -f infra/compose.yaml restart postgres rabbitmq qdrant
pnpm run infra:up
pnpm run infra:persistence verify
pnpm run infra:persistence cleanup
```

prepare保留manifest并创建专属测试资源；verify不消费掉持久消息，便于重复核验；cleanup仅处理manifest记录的本轮资源。禁止使用通配删除替代cleanup。

## 尚未验证

正式任务与Outbox、业务幂等、重试/DLQ、真实业务Checkpoint恢复、LLM输出质量、真实简历解析、生产TLS/认证、完整依赖安全审计、多节点故障、备份恢复与其他主机平台。合成图恢复的实际运行结果见进度记录；旧执行fence与新恢复thread隔离仍由S1.4-T7验收。对应阶段见[开发计划](development-roadmap.md)。

当前RabbitMQ重投测试不能证明业务任务可靠。S1.3-T3只验证旧进程已确认退出后的合成图恢复；旧Worker迟到写入、旧thread隔离和两类任务各自的终态保护在S1.4-T7中单独验收。

## 新增测试的约定

- 单元测试放在 `test/*.test.ts`，不依赖外部服务；真实服务测试放在 `test/integration/*.test.ts`。
- 测试名称描述被验证的行为，而不是被调用的函数。
- 每个任务的验收条件至少对应一个测试；故障边界（超时、重复消息、旧执行、非法输入）与正常路径同样需要覆盖。
- 只使用合成或经授权脱敏的数据；新增测试资源使用本轮UUID，并只清理本轮创建的资源。
