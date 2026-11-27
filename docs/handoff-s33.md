# S3.3后端交接要求

本文件由S3.2收尾会话根据维护者2026-11-28明确指令记录；只在S3.2合并到develop后开始S3.3。路线图是任务范围真源，先读AGENTS.md、CONTRIBUTING.md、architecture/development-roadmap/progress/deployment/testing。

## 授权与约束

- 所有会话禁止goal模式，不调用create_goal/update_goal等工具，也不借新会话重启该模式。
- 按任务提交；阶段从develop创建feature/s3.3-…，完成后--no-ff合并develop、标待验收并推送阶段分支与develop；master只由维护者最终验收合并。
- 未确认PostgreSQL SocketTimeout作为已知问题保留，不再阻塞后续开发。旧失败和L1/L2不能改写为已修复；其他行为故障按路线图处理，不取消停止证据或降低安全校验。
- 机械盘环境，安装/构建/测试命令必须串行。原生Qdrant6333由维护者手动管理，未启动就记录未执行，不擅自启停。
- 不提交本地凭证、真实简历或原始trace；不删除数据卷/数据库/配置解决环境问题。清理前核验本项目Compose标签、卷、网络及精确测试清单。
- 内置浏览器/会话工具缺失或不可调用时，维护者授权自主修复。先按C:/Users/Lenovo/.codex/skills/codex-desktop-tool-repair/SKILL.md只读诊断与官方工具恢复，保留原生审批策略。当前已发现原生create_thread/read_thread/send_message_to_thread/wait_threads，无需改配置。
- 本阶段完成后可按需要另开会话继续；不得提前开启并行构建/测试的其他执行会话。

## S3.3任务与延后边界

按路线图S3.3-T1–T9执行：合成评测数据/标注说明与指标脚本、故障注入、可本地测的任务创建性能、备份恢复步骤和隔离演练、漏洞/许可证审计、同源TLS反向代理与API/Worker/发布器/对账器/生命周期清理进程监督、发布文档。当前代码的连接/归属配置仍限定本项目本机实例，不能把配置存在宣称为目标服务器已部署。

真实模型/embedding Key、人工标注质量指标、真实分析费用与耗时、目标服务器部署/备份回滚验证及L1/L2解除按路线图延后到维护者统一验收。不能用假模型/假标注补齐这些项目。完成本阶段可执行开发部分后即可交接前端，不因这些既定延后项停住。

## 前端恢复（全部后端开发完成后才执行）

维护者明确授权恢复E:/Resume-Studio/Resume-Studio-Frontend中的现有会话：`01a218e5-774c-71e3-b816-3d737a491283`，hostId为local。先读取最新状态，再通过原生send_message_to_thread继续其中既有F1.1–F3.2计划，并告知后端develop已合并的实际提交SHA、契约位置、生命周期/会话变化、已知问题与延后项；要求它继续按自身文档，不修改后端，不操作main，禁止goal模式。

只在后端阶段完成后发送恢复消息，不创建重复前端会话。使用wait_threads确认该会话实际启动，并在最终汇报中如实区分“已恢复执行”与“前端已完成”。会话消息授权来自维护者原话，原会话为当前S3.2主会话`01a21c36-51f8-7c13-b13e-e3a9dcbff628`，需要核验可用read_thread读取。

## S3.2已知运行边界

生命周期CLI须显式监督运行；数据删除只有DONE才算完成，WAITING/RUNNING可能需要外部服务恢复或经核验的历史清单/执行停止证据。未知Qdrant写入结果、上传补偿不明、旧线程/trace不完整均保留，不能强行清零。完整接口和恢复规则见[data-lifecycle.md](data-lifecycle.md)，最终验证/合并记录见progress。
