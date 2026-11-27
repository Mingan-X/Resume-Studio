# 本地账号与服务端会话

S3.2-T1实现模块与CLI，业务API接入及生产身份替换由T2完成。当前验证范围见[进度](progress.md)，T1不解除既有固定开发身份的production限制，不提供注册或第三方登录。

账号username为规范化小写3–64字符，口令15–256字符且UTF-8不超过1024字节；scrypt随机16字节salt、N=131072/r=8/p=1、输出64字节，比较使用timingSafeEqual。单进程最多2个并发派生，满额拒绝而不无限排队；此参数是明确实现配置，不表示任意服务器可承受该负载。连续5次失败锁15分钟，未知账号同样执行固定成本派生，错误不透露账号是否存在。口令计算不在数据库事务内等待。

账号只由`pnpm run account:create <username>`创建，口令通过有界标准输入传递，不从命令参数/环境变量读取，也不打印；不支持交互TTY输入以免回显。账号和新owner同事务创建，无自动认领既有开发owner。新owner的Rubric/评分规则由显式命令另行导入；账号创建不隐式复制其他人的私有数据。

会话令牌为32字节随机base64url，数据库只保存SHA-256；Cookie使用`__Host-resume_session; Path=/; HttpOnly; Secure; SameSite=Strict`，不设Domain。认证有效期默认8小时，可显式配置300–86400秒；未登录的CSRF引导会话默认10分钟，上限15分钟。登录成功轮换并删除旧令牌，登出服务端撤销，过期/禁用账号拒绝。CSRF值由会话随机令牌HMAC派生，只通过同源JSON返回，不通过URL/日志发送。

模块路由：GET /api/v1/auth/session返回匿名或已登录状态及csrfToken；GET /auth/me须已登录；POST /auth/login与/logout须带X-CSRF-Token和配置精确HTTPS Origin。所有响应no-store。session用于登录前获取CSRF，匿名会话不允许访问业务资源。测试在loopback HTTP人工发送Cookie只验证服务端属性和行为，不声称浏览器会在HTTP发送Secure Cookie；真实部署需同源HTTPS。

T1数据库/HTTP测试覆盖错误口令、CSRF/Origin、会话轮换、过期、登出、哈希存储和owner关联；单元核对scrypt/随机salt/错误格式及cookie重复拒绝。没有在测试中建立真实用户或打印真实凭证。

S3.2本轮已确认的生命周期政策：简历版本上传满30天清理其关联业务数据，岗位语料单独保留；主动删除全部业务数据含自建JD/语料/向量/自定义规则，保留账号。执行器尚待T4/T5，不把本段政策描述为已启用自动删除。
