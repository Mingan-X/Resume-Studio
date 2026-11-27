# 岗位语料与召回

S2.3按任务逐步实现；当前仅T1语料、技能归一化与快照，检查结果见[进度](progress.md)。真实向量索引与召回质量尚未验证。

## 合成语料

`synthetic-jd-zh-v1`由10类技术岗位与10类合成业务域组合，生成100条中文JD；全部明确标记合成，无真实企业、招聘主体或个人信息。每条包含六维软要求及可验证的UTF-16原文引用，不含人工相关性标注。模板多样性有限，不能代表真实岗位分布或模型质量。

```powershell
pnpm run build
pnpm run corpus:generate <ownerUuid>
# 在忽略的.env中配置JOB_INDEX_TARGET_FILE，指向本地正式索引目标JSON。
pnpm run corpus:import <ownerUuid>
```

命令只接受已有owner；导入前核对本项目PostgreSQL归属。目标JSON复用[岗位发布配置](jd-rubric.md)的JobIndexTarget Schema，不提供默认目标，不接受fixture/synthetic/test-only目标。T1数据库测试在独立临时owner下显式注入测试目标，只验证发布事务；不注册正式索引，不调用embedding，不把PENDING标为READY。正式语料导入等待S2.3后续正式目标配置。

相同owner与语料版本产生相同job/version ID及正文；逐条建立草稿，走S2.2确认和发布服务，事务生成JobIndexTask、JobIndexTarget、Outbox。发布幂等键使用确定性的jobVersion UUID。中断后重新执行同一命令，已发布项复用原任务，已有草稿校验内容后继续。内容不同立即失败；不覆盖用户修改。全部发布后才冻结语料快照，部分导入不构成完整快照。不自动删除导入内容，不在大事务内执行整个批次。

## 字典与快照

`skills-zh-v1`对结构化技能做NFKC、去首尾空格、小写、连续空白合并及精确别名映射，保留未知技能，去重后按代码单元排序。中文别名包含自动化测试、持续集成、数据分析等；Java不会匹配JavaScript。字典冲突拒绝加载，不进行正文子串猜测。

`JobCorpusVersion`以owner/version为主键，只支持private可见性。manifest保存完整字典、按jobVersionId排序的已发布版本列表、各内容哈希与归一化技能；SHA-256覆盖完整manifest。相同内容重复冻结返回原快照，同版本不同内容拒绝，数据库拒绝UPDATE。改字典或改变成员需新版本，不修改历史快照。版本删除后manifest仍是历史记录，后续召回必须回查PostgreSQL有效且属于该owner的发布版本，不仅信任manifest；T2实现该查询。

内部Schema见[src/contracts/job-corpus.ts](../src/contracts/job-corpus.ts)，本任务不增加HTTP接口。迁移新增独立表与不可变触发器，不改既有发布表/历史行。应用回退可保留新增表，不通过删数据库或卷回滚。

## 验证

[基础测试](../test/job-corpus.test.ts)验证字典边界、版本独立性、100条确定性生成与引用。[数据库专项](../test/integration/job-corpus.test.ts)验证100条发布/Outbox、导入重放、草稿与跨owner拒绝、快照冲突和不可变性、字典升级不修改旧结果。测试保存本轮owner manifest，清理前再次核对PostgreSQL归属，只清理本轮记录；正式rubric与其他owner保持不变。
