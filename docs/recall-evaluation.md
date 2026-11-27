# 中文技能相关性标注与Recall@K

S2.3-T8提供格式、标注说明和计算脚本；人工标注与真实embedding运行按路线图延后。当前没有质量指标，不能用合成端口或自动生成标签填补。测试中的手工构造对象只用于验证公式与拒绝边界，不是评测数据。

## 标注流程

先冻结JobCorpusVersion、查询及各自内容hash；语料可以是合成JD，但相关性标签由维护者逐条完成。标注者先读取去除联系方式的技能/项目/岗位目标查询，再对冻结语料中的每个jobVersionId标relevant=true/false：岗位主要技术/职责与查询有直接关联且值得进入下一步精判为相关；仅泛化软技能、名称相似或无岗位证据不能单独判相关。城市只有用户明确选择时才是约束，缺失年限/城市不得推测为不满足。疑难项先讨论，不用随机/默认false补齐。

标注不参考当前检索排序，不用模型判断替代人工。全语料标注才能确定Recall分母；未审查的条目不得当作不相关。对无相关岗位的查询保留全部false，脚本返回null并单列数量，不把它算100%。标签变更创建新annotationVersion，不能覆盖已报告结果。

## 文件格式

两个JSON均schemaVersion=1，字段和运行校验同源于[Schema及计算函数](../src/modules/recall/evaluation.ts)。

| 文件 | 字段 |
|---|---|
| 人工标注 | annotationVersion、provenance=HUMAN_ANNOTATED、reviewedBy（标注者代号）、reviewedAt（ISO时间）、corpusHash、corpusJobVersionIds、queries |
| 标注query | queryId、queryHash、judgments：每个成员一条{jobVersionId,relevant} |
| 实测运行 | runVersion、provenance=BAILIAN_REAL、embeddingVersion、corpusHash、performedAt、queries |
| 运行query | queryId、queryHash、degraded=false、rankedJobVersionIds（真实召回顺序，无重复） |

所有UUID、版本名、哈希与布尔值严格校验，拒绝缺标、重复、额外查询、语料/hash不一致、外部岗位或降级运行。provenance字段是运行者声明，不能从JSON本身证明真实调用或人工行为；维护者须保留可审查的标注与真实运行记录。脚本不会生成这些记录，也不会伪造provenance。

```powershell
pnpm run build
pnpm run recall:evaluate <人工标注JSON路径> <真实运行JSON路径> 20
```

每查询Recall@K=前K条中相关岗位数/全部相关岗位数。macro平均排除无相关岗位的null项并报告排除数；micro按相关岗位总数加权。输出绑定标注/运行/embedding/corpus版本并保留各查询hits/分母。没有任何正例时两项汇总均null。文件上限各10MiB；失败返回安全码，不输出原文或配置。实际指标只在人工标注和真实百炼运行齐全后执行，不预设合格阈值。
