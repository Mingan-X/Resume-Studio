import 'reflect-metadata';
import { createApi } from './bootstrap.js';
import { loadConfig } from './modules/config/app-config.js';
import { AppLogger } from './infrastructure/logging/app-logger.js';
import { registerShutdown, reportStartupFailure } from './lifecycle.js';

try {
  const config = loadConfig('api', process.env); // 加载配置
  const app = await createApi(config); // 创建API应用
  try {
    await app.listen(config.HTTP_PORT, config.HTTP_HOST);
    registerShutdown(app); // 登记注册关闭事件
    app.get(AppLogger).write('info', { event: 'application_started' }); // 记录应用启动事件
    process.send?.({ type: 'ready', role: 'api' }); // 发送就绪信号
  } catch (error) {
    await app.close(); // 关闭应用
    throw error;
  }
} catch (error) {
  reportStartupFailure(error); // 报告启动失败
}
