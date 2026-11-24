# HTTP API

当前只提供健康检查。简历、岗位、分析任务和报告接口仍为[架构设计](architecture.md#9-api调用链进度与错误)，尚未实现。

## GET /health

默认地址：`http://127.0.0.1:3000/health`。

无查询参数。成功状态码200：

```json
{
  "status": "ok",
  "service": "api",
  "environment": "development"
}
```

environment来自启动配置，可为development/test/production。返回200仅表示API进程可响应，不表示PostgreSQL、RabbitMQ、Qdrant或模型服务就绪。

服务器为每个请求生成独立UUID并通过 `x-request-id` 响应头返回；不信任客户端提供的同名值。请求日志可通过该ID关联，默认不记录原始URL、查询参数、请求正文或Authorization头。

调用链：请求上下文中间件 → HealthController → ZodValidationPipe → HealthService → ConfigService → 响应。未知查询参数返回400，未知路由返回404。

## 错误响应

```json
{
  "code": "VALIDATION_ERROR",
  "message": "请求参数无效",
  "retryable": false,
  "requestId": "00000000-0000-4000-8000-000000000000"
}
```

上例UUID仅是格式示例；实际值与响应头一致。

| 状态 | code | 说明 |
|---|---|---|
| 400 | VALIDATION_ERROR | 请求不符合Schema，例如未知查询参数 |
| 400 | BAD_REQUEST | 请求格式错误，例如HTTP body解析失败 |
| 404 | NOT_FOUND | 不存在的路由 |
| 500及以上 | INTERNAL_ERROR | 安全的服务端错误，不暴露原始异常 |
| 其他HTTP异常 | HTTP_ERROR | 统一的HTTP错误表示 |

retryable仅在429/502/503/504时为true，不把所有失败都视为可重试。安全错误不包含SQL、凭证、内部路径或堆栈。测试专用失败路由不注册在实际API中。

## 启动错误

启动失败尚未提供HTTP响应；配置非法时进程输出CONFIG_INVALID与字段名并退出1。监听失败等其他启动错误输出STARTUP_FAILED，不打印原始配置值。详见[部署配置](deployment.md)。
