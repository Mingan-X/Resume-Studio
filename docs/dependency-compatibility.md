# 依赖与兼容性

版本与接入记录覆盖2026-11-23至2026-11-28。当前声明以[package.json](../package.json)、解析及补丁哈希以[pnpm-lock.yaml](../pnpm-lock.yaml)为准；本文区分已接入组合与未来候选。各阶段的在线核对范围单独记录；S3.3重新核对两项安全修复的registry元数据，其他版本沿用各阶段实际记录。

[registry元数据快照](research/dependency-metadata-2026-11-23.json)保存36个候选包的Node engines及peer字段、66项直接范围检查结果。范围检查不代表完整传递依赖、安全审计或运行验收；快照包含当时考虑过的未安装组件。

## 1. 当前工程依赖

### S3.3 传递依赖安全修复

2026-11-28 registry audit发现undici7.29.1/effect3.20.0共5 high、4 moderate；在pnpm-workspace中只覆盖这两个已解析版本至7.30.1/3.22.1，锁文件同步生成，冻结安装通过，复查audit为0。undici要求Node>=20.18.1，两包MIT且未声明peer，现有Node24.22.3满足声明；没有改变直接依赖、忽略peer或更换技术方向。兼容性回归及395条许可证盘点、特殊EPL/BSD/组合声明见[审计记录](dependency-audit.md)与[进度](progress.md)。这些结果不覆盖Node内置依赖或Docker镜像CVE。

### S2.3 文本向量适配器

百炼适配器使用Node24原生fetch、AbortSignal、Buffer及既有Zod，未新增包或改变锁文件。相比再引入SDK，直接实现官方有限HTTP接口能保留单层重试、总期限与响应上限，成本是自行校验float/base64和供应商错误映射；协议依据与模型/维数限制见[官方核对记录](research/bailian-embedding-2026-11-27.md)。Qdrant沿用已安装1.20.0客户端和1.20.2服务；索引适配器原生fetch用于传播任务取消，见[索引说明](job-index.md)。真实百炼调用未验证，不能从HTTP桩推导模型效果或服务可用性。

### S2.2-T8 OpenAI兼容适配器

2026-11-27按D2接入@langchain/openai1.8.5（MIT、Node>=22、peer core^1.5.0，与当前1.5.1兼容），核对registry精确元数据及官方发布包README/类型/实现。使用ChatOpenAI、baseURL和显式JSON Schema，不改变提供商方向；替代方案是直接调用HTTP/OpenAI SDK，但D2任务要求LangChain适配器，未另建协议运行时。锁文件新增OpenAI SDK7.64.0并使既有LangSmith可选peer解析到该SDK，未升级既有直接core/graph/Zod版本。

用途为ModelPort网络实现；成本是SDK/tokenizer传递依赖与版本兼容维护。SDK与LangChain两层maxRetries=0，所有业务重试由ModelExecutor负责。请求前再次脱敏，只允许HTTPS远端或loopback HTTP桩，拒绝重定向；响应字节/单次期限受限。拒绝环境开启的LangSmith/verbose/OpenAI日志，以免绕开白名单观测；不在日志或数据库保存Key/baseURL/原始异常。

导入触发上游exactOptionalPropertyTypes错误，使用[仅声明补丁](../patches/@langchain__openai@1.8.5.patch)将zdrEnabled与modelKwargs可选字段允许undefined，覆盖d.ts/d.cts；不改运行JS，不启用skipLibCheck，不忽略peer。pnpm patch-commit及冻结安装成功。升级需复核补丁；完整供应链审计留S3.3。本地HTTP桩通过不证明任意中转站支持JSON Schema，真实验证按统一验收延后。

| 组件 | 精确版本 | 验证/限制 |
|---|---|---|
| Node.js / pnpm | Node24.22.3；pnpm12.x，实测12.23.0 | Node由engines/.node-version固定；pnpm采用兼容范围，见[当前策略](deployment.md#包管理器版本策略)；其他12.x及Corepack自动选择未验证 |
| Nest common/core/platform-express/testing | 12.6.0 | ESM与实际DI/HTTP测试通过；CLI/schematics未安装 |
| TypeScript / @types/node | 6.0.3 / 24.10.0 | NodeNext、严格类型检查及装饰器元数据通过 |
| ESLint / typescript-eslint / @eslint/js | 10.15.0 / 8.73.0 / 10.0.1 | flat config；当前TS落在parser支持区间 |
| rxjs / reflect-metadata | 7.8.2 / 0.2.2 | 满足Nest peer |
| Zod | 4.6.7 | 环境配置、HTTP和诊断消息边界 |
| Prisma CLI/client/adapter-pg | 7.10.1 | 三包同版；生成、迁移、CRUD与回滚验证通过 |
| pg / @types/pg | 8.23.1 / 8.23.1 | 与Prisma adapter共用兼容Pool类型；外部池在关闭时显式end |
| amqplib | 2.4.1 | 自带类型声明，不安装旧@types/amqplib；真实broker确认/重投测试 |
| Qdrant JS | 1.20.0 | Node>=22，与服务端1.20.2同minor；实际向量CRUD验证 |
| LangChain core / LangGraph | 1.5.1 / 1.7.5 | 合成StateGraph已运行；core有仅声明补丁，未接入提供商模型 |
| Checkpoint / PostgreSQL saver | 1.2.3 / 1.1.4 | 官方setup、独立账号/池、合成子进程恢复已验证 |
| @standard-schema/spec | 1.1.0 | 显式补足Nest声明引用，兼容LangGraph所用协议 |
| @langfuse/core、otel、tracing、langchain | 均6.1.1 | 本地服务4.84.0，合成callback/手工span关联与脱敏读回已验证 |
| @opentelemetry/api | 1.9.0 | 满足SDK2.x的 `<1.10` peer范围 |
| @opentelemetry/core、resources、sdk-trace-base、sdk-trace-node | 均2.12.1 | 显式provider，不启用自动instrumentation或业务进程注册 |
| @opentelemetry/exporter-trace-otlp-http、otlp-exporter-base、otlp-transformer | 均0.223.2 | 前两包满足Langfuse peer；实际发送采用官方JSON序列化与有界fetch适配器 |

测试使用Node自带node:test和node:assert，无Vitest/Jest转换链。Prisma CLI带入Studio/dev等上游传递依赖，不代表本项目启动这些组件或改用其他数据库。pnpm-workspace.yaml仅精确允许prisma与@prisma/engines安装脚本，不全局放开脚本策略。

## S1.3-T1 接入记录（2026-11-25）

新增并固定 LangGraph 1.7.5、core 1.5.1、checkpoint 1.2.3、checkpoint-postgres 1.1.4。接入前重新查询npm registry的latest、engines、peer及发布时间；core已从旧候选1.5.0更新到1.5.1。LangGraph的core范围为^1.3.4，Postgres适配器要求core ^1.1.44及checkpoint ^1.2.0；当前Node 24.22.3和Zod 4.6.7满足声明范围。checkpoint直接声明用于满足严格peer安装和固定官方协议版本，不自建持久化实现。

另显式声明@standard-schema/spec 1.1.0：NestJS 12.6.0的context-utils.d.ts引用它但包清单未声明；全新安装揭示了这一类型依赖。它同时是LangGraph使用的标准Schema协议，成本仅为类型包。

真实编译发现上游声明与exactOptionalPropertyTypes不兼容，使用pnpm patchedDependencies维护两份仅声明文件补丁：

- core 1.5.1：AIMessageFields.usage_metadata与实现类的一致性，Zod V3兼容接口的可选description允许undefined。
- 传递依赖langsmith 0.14.0：BaseRun/RunUpdate.events与RunTree/Tracer声明的一致性。

补丁文件位于[core补丁](../patches/@langchain__core@1.5.1.patch)与[langsmith补丁](../patches/langsmith@0.14.0.patch)，由[pnpm-workspace.yaml](../pnpm-workspace.yaml)的patchedDependencies引用，哈希写入锁文件，已随S1.3任务本地提交。补丁不修改上游JS运行逻辑，不开启skipLibCheck，不关闭exactOptionalPropertyTypes，不忽略peer。升级时必须复核并在上游修复后移除补丁。LangSmith仅为上游传递依赖，观测合成图显式关闭其tracing，未配置其云服务。

依赖与锁文件经冻结安装、编译核验；完整测试结果见[进度](progress.md)。此处的真实验证优先于下方2026-11-23保留的候选表，Langfuse接入记录见下节，模型适配器仍未接入。

## S1.3-T4/T5 观测接入（2026-11-25）

重新核对npm registry后固定@langfuse/core、otel、tracing、langchain 6.1.1；OTel api 1.9.0、core/resources/sdk-trace-base/sdk-trace-node 2.12.1、exporter-trace-otlp-http/otlp-exporter-base/otlp-transformer 0.223.2。API 1.10.0不满足2.x SDK的<1.10 peer，未升级。@langfuse/langchain的core ^1.0.0兼容现有1.5.1；Node24满足>=22。严格peer和冻结安装保持开启。

用途：官方Langfuse CallbackHandler和SpanProcessor负责语义映射，OTel NodeTracerProvider管理上下文；直接使用官方JsonTraceSerializer输出OTLP。默认SDK传输包含重试且未暴露所需的统一容量预算，因此采用本项目小型有界exporter：单次fetch、请求/响应上限、排队期限、丢失计数；没有自研trace协议或Agent运行时。代价是该适配器需要故障测试并随SDK升级复核。Langfuse SDK默认媒体功能与日志被显式关闭，避免绕过脱敏导出路径。

服务采用官方v4.84.0 Compose结构的最小观测组件：web/worker同版4.84.0，ClickHouse26.3.62.3、Redis7-alpine、MinIO和现有兼容PostgreSQL16镜像（仅复用镜像，新实例/卷独立）。所有镜像固定拉取所得digest并设置pull_policy: never，实际引用在[观测Compose](../infra/compose.observability.yaml)。官方模板来源固定到v4.84.0标签；未启动AI Gateway或模型服务。健康接口返回4.84.0，SDK导出的合成span通过v2 observations接口读回验证。

资源限制：本机Docker总内存约5.8GiB，验证仅为合成诊断，不代表官方建议规模或生产容量。首次数据库迁移超出初始等待窗口后完成，未删卷；HOSTNAME显式0.0.0.0，宿主机只绑定127.0.0.1，worker等待web健康。

### S1.4-T9 开发时OpenAPI生成依赖

2026-11-26维护者确认D8后接入 `@asteasolutions/zod-to-openapi` 9.1.0（devDependency）。registry当次latest=9.1.0、发布时间2026-07-19、未标记deprecated，peer为zod ^4.0.0，与现有4.6.7兼容；包未声明engines，不据此假设任意Node版本均兼容，本机Node24.22.3真实生成/编译验证。直接读取registry和安装包内官方README/package.json；raw GitHub README本次下载失败，未将失败读取当作依据。

锁文件仅新增该包及openapi3-ts4.6.2、yaml2.9.1解析，后者要求Node>=14.6；不升级现有Zod/运行依赖，不忽略peer冲突。精确安装及pnpm12冻结安装通过，生成与过期检测结果见progress。用途是从运行时Schema生成文档，成本为开发安装体积和生成/CI维护；API进程不加载该包或运行全局Zod扩展。替代方案为Zod内建JSON Schema再手工维护OpenAPI路径，或额外维护Nest装饰器/DTO；按D8选择现工具以保留一套校验真源，没有同时引入替代工具。

生成器使用OpenAPI 3.1并固定输出顺序；先初始化扩展再动态导入Schema，修复ESM静态导入早于扩展的问题。OpenAPI能表达结构/枚举/格式，不能自动完整表达任意Zod refine或数据库状态机，相关规则保留在运行时和接口文档。该核对不是完整供应链安全审计。

## 2. 容器基线

S2.1-T8：busboy1.6.0作为直接依赖（原已由Nest/multer传递解析），@types/busboy1.5.5作为开发依赖，固定版本与冻结锁文件。registry复核Node>=10.16、无peer；官方发布包LICENSE为MIT，README说明fileSize截断及limit事件。采用流式multipart直接进入StoragePort，避免Multer memoryStorage整文件缓存与diskStorage绕开本项目暂存协议；代价为维护少量请求适配与中止代码。包发布时间较早，不等于已完成安全审计，后续S3.3审计；运行限制和HTTP专项以progress为准。

### S2.1 解析依赖复核与接入（2026-11-27）

[本次registry快照](research/parser-dependencies-2026-11-27.json)记录版本、发布时间、engines/peers、许可证与发布包integrity。pdfjs-dist 6.5.438（2026-11-01，Apache-2.0，Node >=22.13.0或>=24）、mammoth 1.13.0（2026-09-26，BSD-2-Clause，Node >=12）、yauzl 3.4.0（2026-06-07，MIT，Node >=12），均未声明peer，未标记deprecated；本机Node24.22.3满足声明。近期发布与未deprecated只是维护状态证据，不等于安全审计或运行验证。

直接Node fetch registry失败ECONNRESET，改用pnpm registry查询及curl下载官方npm发布包成功；已阅读各包README/package.json及Mammoth/yauzl安全说明。发布包只解压到忽略目录data/parser-dependency-review供只读核查，不是已安装依赖。来源由快照内tarball及integrity固定，未以可变GitHub主分支作为版本依据。

用途与成本：PDF.js负责PDF文本与真实位置，带可选@napi-rs/canvas（平台二进制成本，T5实验确认加载方式）；Mammoth负责DOCX正文/表格，整包JSZip读取带来内存成本，所以先用yauzl流式预检实际展开量。Mammoth默认禁止externalFileAccess，不净化生成HTML，且文档明确提示恶意文件可能消耗CPU/内存，必须隔离执行；如果使用transformDocument，其API被上游标为不稳定，升级需专项回归。yauzl须启用lazyEntries、strictFileNames与validateEntrySizes，但不校验CRC，应用需另行验证CRC及总量/压缩比/链接/嵌套包。三者都不能单独提供完整安全沙箱。

S2.1-T4已精确安装yauzl3.4.0及开发类型@types/yauzl3.4.0（MIT，无peer，未声明engines，需本机编译验证），传递依赖pend；锁文件同步，pnpm12.23.0冻结安装通过。用途为受限子进程内顺序读取ZIP流并核对实际展开量，CRC使用Node内置zlib.crc32，不增加CRC包；类型包无运行成本。PDF.js/Mammoth随后在T5/T6接入，完整运行验证以progress为准。

S2.1-T5安装pdfjs-dist6.5.438与锁定的可选canvas1.2.1及win32-x64构件，冻结安装通过；使用官方建议的legacy构建。子进程未授权addon，未使用渲染，中文文本提取在无canvas能力下专项通过；不按上游警告建议删除node_modules/锁文件。可选二进制带来安装体积但不是生产文件读写权限。Node24.22.3/严格TypeScript编译与Lint通过，质量及限额结果见progress。

S2.1-T6安装mammoth1.13.0并冻结锁文件，共新增22项解析依赖（JSZip/XML等），无需额外类型包；使用transformDocument的公开hook而非导入内部模块，升级必须重跑段落/表格样本。首轮隔离失败定位到上游lib/promises.js的ExternalPromise.__proto__赋值，与额外Node禁用原型开关冲突；移除该非需求开关而不更换解析器，不放开文件/网络/子进程权限，不修改包源码。首次失败与后续检查见progress；不据包支持承诺任意OOXML版式。

替代方案：Python/MinerU或云端解析会新增服务/隐私边界，D11已排除；仅用JSZip不能提供本任务要求的流式资源预检；不另选解析方向。T1只冻结候选和边界，T4–T6安装时精确声明并同步锁文件，验证冻结安装、运行样本和传递依赖；目前不宣称解析可用。

| 服务 | 镜像版本 | digest |
|---|---|---|
| PostgreSQL 16.15 | pgvector/pgvector:pg16 | sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a |
| RabbitMQ 4.4.0 | rabbitmq:4.4.0-management | sha256:753099a19b577c322117f793f864b3129cbba96d40317221a69d73976e3c843c |
| Qdrant 1.20.2 | qdrant/qdrant:v1.20.2 | sha256:d277592721d2e3b73f9b797b53cf05e6a5bb2134f6d13fdbda4ca51782afbcac |

观测组的镜像身份直接以[compose.observability.yaml](../infra/compose.observability.yaml)为唯一清单，避免复制digest漂移。Langfuse PostgreSQL复用上表镜像但使用独立容器/账号/卷；Redis7-alpine与MinIO的tag不表示固定补丁版本，实际身份由digest固定。旧卷的显式映射和保留原标签规则见[部署文档](deployment.md#s13-本地-langfuse-与独立启停)。

验证环境为Docker29.9.3、Compose5.7.0、linux/amd64容器。镜像可复用，实例/网络/数据卷按项目隔离。Compose固定digest并pull_policy: never，冷启动环境需要先准备镜像。PostgreSQL镜像中附带的pgvector未用于替代Qdrant。

服务健康、数据库迁移重复部署和读写、AMQP往返、Qdrant请求及容器重启持久化已有验证记录，详见[测试文档](testing.md)。单节点quorum队列不等于多节点高可用，当前本机HTTP配置不等于生产TLS验证。

## 3. 兼容约束与待接入候选

| 约束 | 证据 | 处理 |
|---|---|---|
| Node运行时下限 | Nest核心engines>=20，但新版Qdrant/Langfuse/PDF.js等需要22+；Nest CLI的schematics门槛高于core | 当前24.22.3满足已查需求；不只看core的engines |
| TS与Lint工具链 | 核验时TS latest7.0.2超出typescript-eslint8.73.0的>=4.8.4且<6.1.0范围；Nest schematics12要求TS6 | 固定TS6.0.3，禁止强制忽略peer冲突 |
| Prisma版本组 | 核验时CLI latest指向8.0.0-rc.35，而client/adapter稳定组为7.10.1 | 三包固定7.10.1，使用7.x API，不混入8 RC文档接口 |
| Prisma7接线 | 官方要求driver adapter和prisma.config；pg池没有默认连接超时 | PrismaPg显式接入pg池、上限与超时；生成目录明确指定 |
| pg类型一致性 | adapter解析的@types/pg8.23.1比8.16.0多出ClientBase方法，外部Pool类型不一致 | 显式对齐8.23.1，不用any或关闭严格检查 |
| Langfuse与OTel | Langfuse6.1.1要求core/trace-base2.x和exporter低于0.300；OTel最新线为3.x/0.301 | 已接入兼容2.x线并完成合成验证，详见T4/T5记录 |
| Langfuse服务端 | JS SDK6使用v4 API，要求服务端>=4.59.0 | 已部署4.84.0并验证SDK6.1.1；v3升级仍需单独安排 |
| Checkpointer边界 | 首次checkpoint尚未提交时可能EmptyInputError，复用thread_id不等于恢复 | 另存Task输入和幂等产物；按官方API续跑 |

仍未接入的候选如下。版本来自2026-11-23/24的研究，不是当前最新版本承诺；正式接入时重新核验。完整历史候选保留在registry元数据快照，已接入组件以第1节及S1.3记录为准。

| 用途 | 已核验候选 | 限制 |
|---|---|---|
| LangChain高层包 | langchain1.6.7 | 当前只需已安装的core，不为候选清单额外安装 |
| OpenTelemetry NodeSDK | sdk-node0.223.2 | 当前使用已安装的sdk-trace-node 2.12.1，不需要自动探测/自动instrumentation |
| 模型适配器 | @langchain/openai1.8.5 | Node>=22、core^1.5.0；包兼容不代表选择了提供商或验证了兼容端点行为 |
| PDF解析 | pdfjs-dist6.5.438 | Node>=22.13；文本提取、双栏阅读顺序与容器原生依赖需样本验证 |
| DOCX解析 | mammoth1.13.0 | 只取文字，不直接展示未经净化HTML；表格与证据定位需验证 |

Rubric起草、OpenAI兼容中转模型与百炼embedding方向已按路线图D1/D2/D3确认；实际模型配置/Key与真实验证按统一验收延后。不能因候选包存在而生成凭证或声称模型API已可用。

Langfuse自托管包含web/worker、PostgreSQL、ClickHouse、Redis及对象存储，官方建议至少4核/16GiB；可能有可选gateway。其内部BullMQ/Redis属于上游观测平台，不作为业务队列。部署方式于2026-11-25确定为本地独立自托管；附属镜像tag/digest和实际接线已在S1.3-T4完成，采用同项目profile与独立数据/网络。

## 4. 验证范围与限制

已核验的Node/peer范围、精确包安装、编译、Lint、真实HTTP和基础设施请求见[测试文档](testing.md)，每次实际运行结论见[开发进度](progress.md)。接入时查询的发布时间不等于安全审计结论，也不表示本次T6重新检查了上游维护状态。

完整回归结论统一见[开发进度](progress.md)。本机Qdrant创建曾超过现有5秒限制，历史通过不代表环境问题已解决；T7不升级依赖或放宽超时，重点修复入口和清理行为。

保留的运行边界：Prisma CLI使用显式导出的prisma/build/index.js；Qdrant超时可能伴随服务端已创建资源，清理必须依据本轮唯一名称；SDK可能提示本地非HTTPS或后台版本探测超时，未关闭兼容性检查。不得通过放宽断言隐藏错误。

尚未完成完整依赖安全审计、其他平台冷安装、生产TLS/权限、多节点故障、真实业务工作流恢复和真实模型评测。S1.4合成任务Outbox/幂等/恢复已有专项验证，不能替代真实业务验收。新组件接入前复核官方版本与最小运行实验，不以旧元数据快照替代当前验证。

## 5. 官方来源

- [Node发行索引](https://nodejs.org/dist/index.json)：版本、发布日期与LTS标识。
- [Nest v12迁移指南](https://docs.nestjs.com/migration-guide)：Node/CLI门槛、ESM、TypeScript与默认测试工具。
- [npm registry](https://registry.npmjs.org/)：精确查询URL及engines/peers保存于本目录的JSON证据。
- [Prisma系统要求](https://www.prisma.io/docs/orm/reference/system-requirements)、[Prisma7升级指南](https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/upgrading-to-prisma-7)：注意通用文档可能转向Prisma8，实际开发跟随7.x API。
- [LangGraph Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)、[Postgres持久化示例](https://docs.langchain.com/oss/javascript/langgraph/add-memory)：续跑、首次setup、durability边界。
- [RabbitMQ版本](https://www.rabbitmq.com/release-information)、[confirms](https://www.rabbitmq.com/docs/confirms)、[consumer timeout](https://www.rabbitmq.com/docs/consumers)、[DLX](https://www.rabbitmq.com/docs/dlx)、[quorum queues](https://www.rabbitmq.com/docs/quorum-queues)。
- [amqplib官方API](https://amqp-node.github.io/amqplib/channel_api.html)：publish返回值、confirm与manual ACK。
- [PostgreSQL生命周期](https://www.postgresql.org/support/versioning/)、[Qdrant官方release](https://github.com/qdrant/qdrant/releases/tag/v1.20.2)。
- [Langfuse SDK与兼容性](https://langfuse.com/docs/observability/sdk/typescript/overview)、[LangChain集成](https://langfuse.com/docs/integrations/langchain/tracing)、[Docker Compose](https://langfuse.com/self-hosting/deployment/docker-compose)、[官方Compose源码v4.84.0](https://github.com/langfuse/langfuse/blob/v4.84.0/docker-compose.yml)、[4.84.0发布](https://github.com/langfuse/langfuse/releases/tag/v4.84.0)。
- [PDF.js官方仓库](https://github.com/mozilla/pdf.js)、[Mammoth官方仓库](https://github.com/mwilliamson/mammoth.js)：解析能力与安全边界；S2.1合成样本运行记录见progress。
