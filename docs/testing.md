# 测试与验证

当前测试使用 TypeScript 编译产物和 Node 内置 test runner，Nest testing用于创建应用上下文；没有额外的测试转换器。真实集成测试连接独立的本项目容器，不使用其他项目实例。

## 执行命令

首次安装依赖后，先运行 `pnpm run infra:init` 和 `pnpm run db:generate`。生成步骤无需连接数据库；运行集成测试前按[部署文档](deployment.md)启动服务并应用迁移。

依赖安装使用 `pnpm install --frozen-lockfile`，包管理器遵循[pnpm版本策略](deployment.md#包管理器版本策略)。

```powershell
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run test:integration
```

`pnpm test`编译后执行顶层测试文件，不要求外部服务；`test:integration`读取被忽略的infra/.env并执行真实服务测试，服务不可用会失败而非跳过。

## 覆盖范围

| 测试 | 验证内容 |
|---|---|
| test/config.test.ts | 配置转换、必需字段、非法端口、未知环境、秘密字段排除 |
| test/http.test.ts | 编译后的Nest依赖注入、实际HTTP、400/404/500契约、非法JSON、并发requestId隔离 |
| test/process.test.ts | API/Worker真实子进程的启动失败、正常启动、关闭、日志脱敏与端口释放 |
| test/infrastructure-config.test.ts | 拒绝外部地址、其他数据库/vhost、管理员账号及非项目端口 |
| test/integration/infrastructure.test.ts | Prisma CRUD/唯一约束/回滚/池关闭；RabbitMQ确认/return/ACK/重投/重复投递；Qdrant CRUD与维数错误 |

当前基础测试11项；真实服务集成测试为1个父测试与3个子测试，共4项。数量随覆盖变化，以实际测试输出为准。断言验证输出与故障行为，不以源码里是否有装饰器等实现细节代替运行验证。

### 集成测试辅助设施

`test/integration/persistence.fixture.ts`是通过 `infra:persistence` 手动调用的辅助工具，不是 `*.test.ts` 用例，不计入上述11/4项统计。它创建专属记录、消息与向量，以manifest保留本轮资源ID，供容器重启后的verify和cleanup使用；具体步骤见下文。拥有辅助工具不代表每次测试都会运行重启验证。

## 验证记录

每次实际运行的检查、环境与结果记录在[开发进度](progress.md)，本文不重复保存。记录只代表当时的环境；后续变更应重新运行适用检查。

## 数据隔离与已知边界

测试数据库/vhost使用固定诊断标识，临时记录、队列和collection附本轮UUID，清理只针对本轮创建资源。不要删除整个数据库、数据卷或全部前缀资源来通过测试。

初始化与清理均应核实实例归属。现有 `infra-provision.mjs` 已检查Compose项目/服务标签；持久化辅助工具及集成测试仅校验本机连接范围、固定数据库/vhost/端口、UUID/manifest，不独立检查Docker标签或证明manifest未被替换。因此不能把现有清理能力描述为完整的容器归属保护；补强须在后续实现与测试任务中完成，当前不要向未知实例执行清理。

客户端超时不证明远端没有执行。Qdrant曾出现create请求超时而服务端创建成功的情况，因此测试预留唯一名称，并在finally检查存在性后精确清理；不能仅以create响应成功作为清理条件。当前仍可能遇到本地网络/服务超时，不增加超时或跳过断言掩盖失败。

Qdrant SDK可能对HTTP+API Key发出提示，后台版本查询也出现过超时。保持兼容性检查开启；服务端版本由固定镜像及实际请求核验，不将警告等同于全部网络稳定。

Windows子进程关闭测试通过私有IPC触发与SIGINT/SIGTERM共用的关闭函数；未宣称验证Linux信号行为。测试专用500路由不包含在正常应用模块中。

## 持久化重启验证

以下实验需主动执行，会重启本项目容器；不应对其他项目实例运行。先确认没有未清理的data/s12-persistence.json，再执行：

```powershell
pnpm run build
pnpm run infra:persistence prepare
docker compose --env-file infra/.env -f infra/compose.yaml restart
pnpm run infra:up
pnpm run infra:persistence verify
pnpm run infra:persistence cleanup
```

prepare保留manifest并创建专属测试资源；verify不消费掉持久消息，便于重复核验；cleanup仅处理manifest记录的本轮资源。禁止使用通配删除替代cleanup。

## 尚未验证

正式任务与Outbox、业务幂等、重试/DLQ、Checkpoint崩溃恢复、LLM输出质量、真实简历解析、生产TLS/认证、完整依赖安全审计、多节点故障、备份恢复与其他主机平台。对应阶段见[开发计划](development-roadmap.md)。

当前RabbitMQ重投测试不能证明业务任务可靠。旧Worker迟到写入、旧thread隔离和两类任务各自的终态保护在S1.3-T3与S1.4-T7中单独验收。

## 新增测试的约定

- 单元测试放在 `test/*.test.ts`，不依赖外部服务；真实服务测试放在 `test/integration/*.test.ts`。
- 测试名称描述被验证的行为，而不是被调用的函数。
- 每个任务的验收条件至少对应一个测试；故障边界（超时、重复消息、旧执行、非法输入）与正常路径同样需要覆盖。
- 只使用合成或经授权脱敏的数据；新增测试资源使用本轮UUID，并只清理本轮创建的资源。
