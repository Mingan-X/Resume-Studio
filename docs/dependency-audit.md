# S3.3-T6依赖漏洞与许可证审计

2026-11-28以提交锁文件和本机pnpm12.23.0为输入，执行`pnpm audit --json`与`pnpm licenses list --json`。前者查询当前registry公告，后者盘点已安装包；没有使用忽略列表或audit fix批量升级。原始带本机路径的报告只保存在data/s33-audit.json、data/s33-licenses.json。

## 漏洞与处置

首轮退出1：0 critical、5 high、4 moderate。8条关联undici7.29.1，1条关联effect3.20.0；不是9个不同包。Qdrant/OpenAI/LangSmith链路带入undici，Prisma配置链路带入effect。

| 包 | 公告 | 处置 |
|---|---|---|
| undici7.29.1 | GHSA-4qv8-2p9j-2685、GHSA-f72v-6w45-q472、GHSA-xjj6-f33q-929c、GHSA-4w7w-5xrc-9h26、GHSA-2m5v-pch6-74hx、GHSA-qrxm-fqhp-jwvm、GHSA-9fm3-97px-rjf6、GHSA-55wc-3pg8-jfw6 | 定向覆盖到公告修复线7.30.1，保持同一主版本 |
| effect3.20.0 | GHSA-7589-6fvf-x4pw，Schema.TemplateLiteral ReDoS | 定向覆盖到公告修复线3.22.1 |

用途保持原HTTP和Prisma配置依赖，不增加框架。选择两个精确transitive override的原因是直接升级LangChain/Prisma会改变更多已验证接口；代价是维护覆盖与重新运行兼容性回归。未降低strict-peer-dependencies，没有忽略漏洞或将高危项直接标接受。宿主Node内置fetch的HTTP实现不由pnpm override替换，Node镜像/系统组件需独立跟踪安全更新。

已向官方npm registry核对指定版本：undici7.30.1声明Node>=20.18.1、MIT、无peer；effect3.22.1声明MIT、无engines/peer，未标记deprecated，registry更新时间2026-11-27。Node24.22.3满足undici声明；无engines不是任意平台兼容承诺。锁文件由`pnpm install --lockfile-only`显式生成，再以`--frozen-lockfile`安装，不手改解析结果。安装/新审计和回归的最终结果见[进度](progress.md)，不以版本号存在代替测试通过。

## 许可证盘点

首轮清单395个包名条目（可能包含多个版本），与audit依赖图441条的口径不同。分组：MIT289、Apache-2.0 49、ISC29、BSD-2-Clause11、BSD-3-Clause6、BlueOak-1.0.0 3、Unlicense2、0BSD1，以及下列特殊声明。没有UNKNOWN/UNLICENSED分组；这仅反映元数据，不保证全部传递内容已法律审核。

| 特殊声明 | 已核对的包与处理 |
|---|---|
| BSD | duck0.1.12的发布包LICENSE实际为两条保留声明条件；保留原文件，记录为BSD两条款来源，不改包元数据 |
| EPL-2.0 | elkjs0.11.1，经Prisma→@prisma/studio-core带入。已阅读发布包LICENSE.md；保留许可/归属说明，并在分发包含该包的镜像时附对应源码来源与许可。没有修改elkjs源码，不将其归入MIT |
| MIT OR GPL-3.0-or-later | jszip3.10.2的LICENSE.markdown明确提供MIT或GPL选择；本项目按MIT选项使用，保留完整随包声明 |
| MIT and ISC / MIT AND Zlib | @visx/vendor4.0.0-alpha.0、pako1.0.11，分别保留组合许可，不把AND当OR |

Dockerfile保留已安装包的LICENSE/NOTICE与版本信息；当前包含开发依赖，所以不能把Prisma Studio的EPL包排除出镜像盘点。正式镜像分发前须随发行记录保存锁文件、许可证清单、原许可证/NOTICE和elkjs精确版本源码来源，不移除相应文件。运行镜像最小化需另行验证，不在本审计中删依赖换取更少告警。

elkjs0.11.1发布包的官方registry gitHead为572e73323791d05f09b0815ff639af2b67f202ab，源码入口为https://github.com/kieler/elkjs/tree/572e73323791d05f09b0815ff639af2b67f202ab；发布包为https://registry.npmjs.org/elkjs/-/elkjs-0.11.1.tgz，integrity=sha512-zxxR9k+rx5ktMwT/FwyLdPCrq7xN6e4VGGHH8hA01vVYKjTFik7nHOxBnAYtrgYUB1RpAiLvA1/U2YraWxyKKg==。发行时保留这些来源与随包EPL文本，并按许可证提供对应源码；目前没有向第三方发布镜像。

## 后续升级规则

每次发布重新运行audit与许可证盘点，对新高危/critical明确修复或由维护者记录接受理由；本轮没有授权接受未修复高危。上游吸收修复后检查是否可删除override，再重新生成锁文件、冻结安装、基础/真实服务回归和模型HTTP桩。声明补丁仍需随上游版本检查。Node/Docker/nginx与基础设施镜像的OS/CVE扫描、真实模型供应链和新机冷安装不由pnpm audit覆盖，目标环境验证保留在发布清单中。
