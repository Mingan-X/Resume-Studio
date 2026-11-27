# S3.3质量评测准备

数据为本项目自行编写的中文合成材料，来源与授权声明固定在[生成器](../src/modules/evaluation/dataset.ts)，依据维护者2026-11-27确认的合成方案；不含真实人物、联系方式、抓取内容或授权不明的简历。20份简历覆盖缺证据、明确否定、部分职责、日期重叠/冲突、团队贡献、未来计划和指令性内容；100条JD复用已版本化的synthetic-jd-zh-v1。模板数据不代表真实求职人群分布，也不是PDF/DOCX版面评测。

```powershell
pnpm run build
pnpm run evaluation:dataset data/evaluation-zh-v1.json
```

离线命令仅新建指定JSON（已存在则拒绝覆盖），不连接数据库或模型。输出清单包含版本、数量、完整datasetHash；每份简历含contentHash。冻结数据后才开始标注，修改文本必须创建新评测版本并重新核对hash。coverage是样本设计说明，不是语义正确标签。

## 人工标注流程

1. 保存数据hash、实际模型/提示词/embedding/规则版本、运行时间和原始输出hash；原始输出只放本地忽略目录，不提交真实数据或trace。
2. 标注者使用代号，先独立阅读输入；结构化字段逐项核对是否忠于原文，缺失信息不能补造。按原文UTF-16区间核对引用位置，再判断引用是否支持对应语义。
3. 对每条实际执行的岗位要求人工给出met/partial/unmet/unknown；资料不足使用unknown，有明确反证才用unmet。不把未执行项当unknown，不用画像等级代替逐要求证据。
4. 对unknown逐项检查是否确实缺证据；同时检查应当unknown却被判定为其他状态的漏报。保留混淆矩阵与分母，不仅报告总体正确率。
5. 每份简历对冻结的100条JD完整标相关/不相关，不参考机器召回排名；疑难项讨论后再提交。人工未看过的项目不得默认false。Recall@K规则沿用[召回标注说明](recall-evaluation.md)。
6. 第二位审查者核对争议项并保存修订记录；最终文件声明HUMAN_ANNOTATED、标注版本/时间/代号和输出hash。程序只能校验声明及完整性，不能证明标注确由人完成，维护者负责审核来源。

人工标注、真实模型/embedding运行、指标报告和上线阈值均延后到统一验收。当前没有质量结果；不得把生成器、算术测试或合成端口结果当作准确率。费用缺失保留null，预留预算不视为实际费用。

## 质量脚本输入与输出

字段以[质量Schema与计算](../src/modules/evaluation/quality.ts)为准，三份输入分别是生成的数据集、真实运行记录、人工标注；各文件最大20MiB。运行记录由真实产物导出/核对后提供，本命令不会调用模型或自动制造标注。

| 文件 | 必需内容 |
|---|---|
| 运行根对象 | schemaVersion=1、runVersion、provenance=REAL_MODEL_AND_EMBEDDING、datasetHash、performedAt、modelVersion、promptVersion、embeddingVersion、rubricVersion、scoringPolicyVersion、currency=CNY或USD、results |
| 每份运行结果 | resumeId、resumeHash、durationMs、inputTokens/outputTokens/costMicros（未知为null）、degraded=false、output |
| output | candidateJobVersionIds（冻结精判候选，最多20个）、structured（逐字段{id,value}）、citations（{id,start,end,quote}，引用当前简历全文）、requirements（{jobVersionId,requirementId,verdict,citationIds}）、rankedJobVersionIds（召回原始顺序） |
| 要求结果 | 覆盖所有冻结候选的全部要求；verdict为met/partial/unmet/unknown，未完成用null且citationIds为空；不能删除失败项或使用unknown填充 |
| 标注根对象 | schemaVersion=1、annotationVersion、provenance=HUMAN_ANNOTATED、datasetHash、reviewedBy、reviewedAt、results |
| 每份标注 | resumeId、outputHash（规范化完整output哈希）、expectedFieldIds（含应有但漏掉的字段）、fields（每个实际字段{id,correct}）、citations（每条{id,supported}）、requirements（每条已执行要求{jobVersionId,requirementId,expected}）、relevance（完整100条{jobVersionId,relevant}） |

所有简历必须同时存在于运行和标注中；拒绝缺标、重复、未知候选/要求、部分相关性标注、降级召回和hash变化。结构化正确率只衡量实际字段，另报告预期字段覆盖率，防止漏字段被正确率掩盖。引用位置检查范围、逐字相等和UTF-16代理对边界；语义有效率还要求人工supported=true。要求质量输出四类混淆矩阵及准确率；unknown的precision/recall分别暴露误报和漏报。未执行数/执行覆盖率单列。

```powershell
pnpm run evaluation:quality data/evaluation-zh-v1.json data/real-run.json data/human-annotations.json 20
```

输出仅含指标、计数和版本/hash，不输出简历、原始判断或标注者身份。Recall@K分母为人工全语料正例数，无正例返回null并单列；macro排除null，micro按正例总数加权。费用报告已知样本小计与未知数，任何样本费用缺失则总费用为null；token同理。时延记录样本均值/范围，不代表性能保证。releaseThreshold固定null，由维护者依据实测决定上线门槛。

当前只执行单元算术/拒绝边界验证，没有真实运行与人工标签，因此没有生成质量评测报告。provenance及reviewedBy是可审计声明，脚本不能验证其真实性。已有[独立Recall脚本](recall-evaluation.md)可继续用于S2.3的单独召回实验；两种输入格式不可混用。
