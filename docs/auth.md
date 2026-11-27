# 本地账号与服务端会话

S3.2-T1实现模块与CLI，T2接入业务API的会话身份。当前验证范围见[进度](progress.md)，不提供注册或第三方登录。

账号username为规范化小写3–64字符，口令15–256字符且UTF-8不超过1024字节；scrypt随机16字节salt、N=131072/r=8/p=1、输出64字节，比较使用timingSafeEqual。单进程最多2个并发派生，满额拒绝而不无限排队；此参数是明确实现配置，不表示任意服务器可承受该负载。连续5次失败锁15分钟，未知账号同样执行固定成本派生，错误不透露账号是否存在。口令计算不在数据库事务内等待。

账号只由`pnpm run account:create <username>`创建，口令通过有界标准输入传递，不从命令参数/环境变量读取，也不打印；不支持交互TTY输入以免回显。账号和新owner同事务创建，无自动认领既有开发owner。新owner的Rubric/评分规则由显式命令另行导入；账号创建不隐式复制其他人的私有数据。

会话令牌为32字节随机base64url，数据库只保存SHA-256；Cookie使用`__Host-resume_session; Path=/; HttpOnly; Secure; SameSite=Strict`，不设Domain。认证有效期默认8小时，可显式配置300–86400秒；未登录的CSRF引导会话默认10分钟，上限15分钟。登录成功轮换并删除旧令牌，登出服务端撤销，过期/禁用账号拒绝。CSRF值由会话随机令牌HMAC派生，只通过同源JSON返回，不通过URL/日志发送。

模块路由：GET /api/v1/auth/session返回匿名或已登录状态及csrfToken；GET /auth/me须已登录；POST /auth/login与/logout须带X-CSRF-Token和配置精确HTTPS Origin。所有响应no-store。session用于登录前获取CSRF，匿名会话不允许访问业务资源。测试在loopback HTTP人工发送Cookie只验证服务端属性和行为，不声称浏览器会在HTTP发送Secure Cookie；真实部署需同源HTTPS。

S3.3的可选运维/ready与/health一样不要求会话，但只读依赖可用性且不返回业务数据/内部连接；部署代理不对公网转发/ready。此例外按Controller类型限定，不放宽任何业务资源的会话/CSRF/owner要求。

T1数据库/HTTP测试覆盖错误口令、CSRF/Origin、会话轮换、过期、登出、哈希存储和owner关联；单元核对scrypt/随机salt/错误格式及cookie重复拒绝。没有在测试中建立真实用户或打印真实凭证。

S3.2生命周期政策：简历版本上传满30天清理其关联业务数据，岗位语料单独保留；主动删除全部业务数据含自建JD/语料/向量/自定义规则，保留账号。接口、显式执行器和安全停止/重入规则见[数据生命周期](data-lifecycle.md)；只有启动受监督的清理命令后才执行，不把模块存在描述为已运行常驻调度。

## API与Worker接线（S3.2-T2）

`AUTH_ENABLED=true`、`AUTH_ORIGIN=https://<实际同源主机>`及同业务库DATABASE_URL启用会话模式；AUTH_SESSION_SECONDS/AUTH_ANONYMOUS_SECONDS为可选秒数。生产业务路由必须启用，缺失/非法Origin启动失败。未启用时仅development/test与loopback允许固定开发身份。数据库仍须符合现有项目实例校验，生产配置测试不表示目标服务器已部署。

全局Guard保护业务Controller（健康检查与认证自身流程除外）；服务端查会话后把owner放入请求内部Symbol，request-scoped IdentityPort读取它。客户端正文、query、owner头均不能替换身份。业务非GET/HEAD要求CSRF与Origin；登录失效401，CSRF拒绝403，其他owner资源404。SSE在建立连接时校验会话，单连接最长300秒，失效会话不能重连；当前不承诺登出即时断开已建立SSE。

真实分析/索引消费者按messageId查持久Outbox，核对消息全文hash及任务/事件对应关系后，从数据库获得owner，以AsyncLocalStorage隔离并发执行。production只处理启用账号的任务，开发owner不进入生产执行。非法信封落入专属基础设施owner `00000000-0000-4000-8000-000000000002` 的最小Quarantine/dead Outbox；该owner无账号，不作为HTTP或业务身份。迁移只新增该系统行及账号约束，不认领开发数据。

发布器/对账命令通过私有进程配置 `SERVICE_OWNER_ID` 明确选择已登记账号；production缺失或选择开发owner即拒绝。每个账号需有对应发布/对账监督配置，基础设施owner需额外发布器处理dead事件；共享消费者可处理各账号消息。development/test不填时保留原开发owner。合成消费者/合成对账命令拒绝production。服务进程部署监督在S3.3验证，不把这些显式命令描述为已常驻运行。

发布顺序：后端S3.2合并到develop、前端F3.1同步同源契约并通过登录/CSRF流程后，部署时再启用AUTH_ENABLED；前端现有F3.1-T1/T4覆盖此兼容切换，不修改旧本地开发模式请求。

## API安全边界（S3.2-T6）

会话模式下每进程每分钟：直连来源600次、认证路径来源30次、已登录owner业务120次；超额429，健康检查不计数。固定窗口最多10000个key，容量满拒绝新key，窗口过期可回收；多进程不共享额度。忽略客户X-Forwarded-For，反向代理后的来源计数会共享代理IP，前端部署需结合此边界核对容量。当前参数为可复核起点，非生产负载保证。

JSON与urlencoded限制1MiB，拒绝自动解压；multipart仍使用原10MiB流式文件与30秒传输限制。响应nosniff、DENY、no-referrer、限制性CSP/Permissions-Policy；生产会话模式加HSTS，API响应no-store。匿名会话创建在有界事务中清理最多100条过期会话，并限制最多10000条匿名会话；不把测试参数当作无限存储保证。
