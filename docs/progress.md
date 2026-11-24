# 开发进度

按时间倒序记录每个阶段或任务的完成情况与验证证据。阶段定义与状态总表见[开发计划](development-roadmap.md)。

记录规则：

- 每条记录写明日期、阶段/任务编号、分支或提交、完成内容、执行的检查及结果、未执行项及原因。
- 只记录实际运行过的检查。验证结果只代表当时的环境，不能推广为其他平台或生产环境已验证。
- 已有记录不改写；发现错误时追加更正记录。

## 2026-11-24 文档重构（分支 feature/s1.3-docs-restructure）

- 为路线图补充阶段编号（S1.1–S3.3）、状态列、阻塞决策和S1.3/S1.4任务拆分。
- S1.3中依赖任务表fence的恢复隔离验收移到S1.4-T7，原因是相关字段在S1.4才建立。
- 新增[接口契约规范](api-contract.md)与本进度文档；验证记录从测试和部署文档移到本文。
- 前端框架决策D5确定为Vue 3 + TypeScript + Vite，详见前端仓库ADR-0001。
- 只修改文档，未运行类型检查、Lint或测试。

## 2026-11-24 S1.1 工程基线、S1.2 基础设施诊断（提交 c0881b3、f20769c）

两个阶段在同一次初始化中交付，没有独立历史分支。

环境：Windows主机，Node 24.22.3，pnpm 12.23.0，Docker 29.9.3，Compose 5.7.0，linux/amd64容器。

已执行并通过：

- 类型检查、零警告Lint、11项基础测试、4项真实服务集成测试（1个父测试与3个子测试）。
- Prisma generate/validate/deploy/status；第二次部署无pending migration，迁移记录一条。
- pg连接池上限3；Nest上下文关闭后池连接数为0。
- RabbitMQ：无路由的mandatory消息未被confirm误判为成功；未ACK的消息在关闭channel后重投；相同messageId可被重复交付。
- Qdrant：错误维数返回400；集合与点CRUD通过。
- 持久化重启实验：本项目三个容器重启后，数据库记录、持久消息和向量仍存在；专属测试资源已清理。
- 离线冻结安装通过，但复用了本机缓存，不等于新机器冷安装。

pnpm元数据调整后的安装验证：

- 改动：`package.json` 移除精确的 `packageManager` 字段，`engines.pnpm` 改为 `>=12 <13`。
- 在仓库外空目录复制package.json、锁文件、.npmrc和pnpm-workspace.yaml，使用独立的store、state、cache、config和temp目录及空的用户/全局npmrc，执行 `pnpm install --frozen-lockfile --store-dir <独立store> --state-dir <独立state> --reporter append-only`。
- 结果：退出码0，安装342个包，19个直接依赖版本与清单一致；安装前后清单、两份配置和锁文件逐字节一致。未使用非冻结安装，未跳过安装脚本。
- 该次验证在上述业务测试之后进行，没有重新运行业务与集成测试。

未验证：其他pnpm 12.x版本、Corepack自动选择、其他主机平台、Linux信号关闭行为、生产TLS与认证、完整依赖安全审计、多节点故障、备份恢复。

已知问题：持久化辅助工具与集成测试的清理只校验连接范围、固定数据库/vhost/端口和UUID/manifest，不独立检查Docker标签，见[测试文档](testing.md#数据隔离与已知边界)。
