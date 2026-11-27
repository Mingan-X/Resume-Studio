# 分析输入与配置

S2.5补充：新任务还校验当前owner的ScoringPolicy，冻结scoringPolicyHash并建立政策外键；scoringVersion必须已由显式命令导入。旧快照不原地修改，无该hash的旧任务仍走S2.4原图；以下T1边界为历史交付范围，评分接线与恢复详见[评分说明](scoring.md)。

S2.4-T1提供真实分析创建与不可变输入，执行图、预算调用及语义节点由后续任务接入。真实模型端到端T9仍按路线图延后。

## 配置

在本地启用 `TASK_API_ENABLED=true`，通过绝对路径 `ANALYSIS_CONFIG_FILE` 指向不含凭证的JSON，文件上限64KiB。配置使用 [analysisConfigurationSchema](../src/contracts/tasks.ts)，未知字段拒绝；不保存baseURL、Key、模型输入或联系方式。没有文件时新分析返回503，已提交任务的幂等重放仍可查询。

配置字段：schemaVersion=1、configurationVersion、rubricVersion、scoringVersion、promptVersion、modelConfigVersion、embeddingVersion、budget、maxJudgments（默认400，最大400）、recall及indexTarget。recall沿用[召回配置](job-recall.md)，indexTarget沿用[indexCollectionSchema](../src/contracts/job-index.ts)但不接受ownerId，owner由执行身份补入；本地文件只接受bailian来源且embedding版本必须相同。该声明不证明真实embedding已经运行，实际运行验证仍延后。

budget冻结maxAttempts/maxModelCalls/maxTokens/maxCostMicros/currency/maxDurationMs。数值必须由本地配置明确给出，不将测试预算作为生产默认值。模型连接参数仍由不入库的本地模型配置供Worker使用，modelConfigVersion用于选择对应能力。此任务仅冻结scoringVersion标识，评分政策持久化按S2.5-T1接入；不宣称已有评分结果。

首次使用时在同事务保存AnalysisConfiguration（owner/version唯一）及内容哈希，禁止原地修改；同版本不同内容返回409，变更须新版本。创建任务存配置全部安全字段和hash，不依赖后续可变文件。Rubric、corpus内容分别经Schema/hash验证后绑定版本及hash；简历绑定明确版本及fileHash，要求存在非空合法ExtractedDocument。固定开发owner下已导入的正式Rubric保持待人工审核，创建任务不修改其状态。

## 事务与幂等

真实请求hash包含任务类型、kind、可信owner和规范化请求正文；服务器生成的配置与内容hash保存在不可变snapshot。先检查(owner,key)原任务再加载当前配置，故重放不会偷偷升级配置或重建任务；同key不同输入409。真实/合成任务共用幂等作用域，不能互相冒充。

AnalysisTask新增可空真实简历/corpus/Rubric/configuration复合外键，与合成UUID兼容。SQL CHECK核对kind与列，触发器核对创建时已存解析产物、所有内容hash和完整配置，禁止更换身份；任务及Outbox在同事务创建，插入失败全部回滚。配置和资源操作不调用模型、队列或向量库。旧合成入口仍严格解析synthetic输入，领取真实分析返回deferred，不消耗attempt预算。

真实语料身份沿用JobCorpusVersion的(ownerId,version)，因此真实snapshot的jobCorpusVersionId是versionName；合成快照仍为UUID，kind明确区分。客户端不得传owner或完整snapshot。

## 验证边界

[创建专项](../test/integration/analysis-creation.test.ts)覆盖HTTP/数据库、并发幂等、配置轮换重放、越权、配置不可变、晚期Outbox失败回滚及合成消费者拒绝；[契约测试](../test/analysis-input.test.ts)覆盖严格输入和配置。仅使用测试创建的owner及合成简历/JD；测试复制正式Rubric内容到临时owner，不修改开发owner原记录。运行结果以[进度](progress.md)为准。
