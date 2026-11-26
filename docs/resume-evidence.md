# S2.1 文件与证据契约

本文件记录S2.1-T1设计。Schema已定义，但存储、解析、HTTP与数据库实现分别由T2–T8交付；不存在的新路由不注册到OpenAPI。契约真源为[证据Schema](../src/contracts/evidence.ts)与[简历Schema](../src/contracts/resumes.ts)。

## 身份、哈希与文本

- 原文件SHA-256针对原始字节；不得先转换再计算。StorageKey和所有实体ID由服务器生成，原文件名不能进入路径。
- 每次新上传创建Resume与version=1；同owner、同Idempotency-Key绑定文件SHA-256，同key同字节返回原版本（201），不同字节409。不同key即使内容相同仍是独立简历。不增加追加版本接口。
- 解析后文本按顺序将CRLF/CR转为LF、Unicode NFC归一化；不折叠空格、不trim正文。纯空白块不输出，全文无非空白块则失败。定位针对归一化后的持久化文本，不能再改变文本。
- 引用采用JavaScript UTF-16 code unit的`[start,end)`区间；要求start/end不拆分代理对，quote必须逐字等于text.slice(start,end)。Schema先验证形状，T7再结合可信owner、sourceType、sourceVersionId和实际块验证授权及内容，不能仅靠模型给出的quote校验。
- 文本块按解析顺序有连续零基ordinal；块ID在一次版本解析提交前生成UUID，并随不可变产物保存，读取和分析重试不得重建ID。textHash为归一化文本的UTF-8 SHA-256。parserVersion记录包版本及适配器版本；normalizationVersion固定text-v1。
- ExtractedDocument与原文件分开持久化，绑定文件哈希、简历版本、parserVersion与schemaVersion。版本、原文件和已提交文本不得原地替换。

## 位置字段（暂定）

PDF使用一基页码，bounds仅当解析器能可靠给出时填写，否则null；坐标原点、单位和阅读顺序由T5实验证明后定稿。DOCX使用零基段落/抽取块序号，表格可附index/row/cell；不提供虚构页码，T6验证表格定位。JD未来使用TEXT段落定位。引用本身只保存块与文本区间，展示位置由已存块派生，避免模型伪造位置。

## 上传与查询（待T8实现）

`POST /api/v1/resumes`：multipart唯一文件字段file、UUID Idempotency-Key。类型/签名检查→受控暂存→隔离子进程同步预检/解析→文件提交→数据库单事务提交FileAsset/Resume/ResumeVersion/ExtractedDocument/EvidenceBlock/幂等记录→201。所有权只来自IdentityPort。文件系统与数据库不是跨系统原子事务：未知DB提交结果须按owner/key/operation查询对账，不能盲删可能已引用的文件。

失败使用统一安全错误字段，413表示原始文件超过10 MiB；422 UNSUPPORTED_FILE另含Schema枚举reason，涵盖签名、加密、扫描、损坏、空文本、页数/文本/ZIP/运行资源限制。409使用现有IDEMPOTENCY_CONFLICT。不得透传路径、原始解析异常或内容。解析失败不留业务记录；精确暂存补偿与可恢复回收属于T2/T8验收。

`GET /api/v1/resumes`：按createdAt DESC、id DESC稳定排序，limit默认20、上限100；游标绑定排序键，查询仍显式限定owner。`GET /api/v1/resumes/:resumeId/versions/:versionId`：返回版本、文件安全元数据、ExtractedDocument及警告，不返回owner、storageKey、内部路径或空结构化字段。越权与不存在均404。响应Schema不代表路由已交付。

## 资源限制方案（待T4–T6实测）

| 资源 | 初始实验阈值 | 验证方法 |
|---|---|---|
| 上传原始字节 | 10 MiB | 流式计数，边界与超出1字节 |
| PDF页数 | 30 | 30/31页合成样本；DOCX不用页数 |
| 文本总量 | 200,000 UTF-16 code units | 正好阈值/超出及中文代理对 |
| ZIP条目 | 1,000 | 1,000/1,001；不信声明计数 |
| ZIP实际展开总量/单条目 | 50 MiB / 20 MiB | 流式计数，伪造size、CRC及截断 |
| 实际压缩比 | 100:1 | 解压实际字节/压缩大小；零分母单独拒绝 |
| 解析总期限 | 15秒（含预检与子进程启动） | 永不返回、忙循环、父请求中止，确认进程退出 |
| JS堆/RSS | 128 / 256 MiB | 子进程启动堆限制，父进程轮询RSS并终止 |
| CPU | 总期限内最多单子进程CPU占用；独立CPU时间限制待T4验证 | 忙循环与终止实测；不声称OS硬配额 |
| 并发/暂存回收 | 单API最多1个解析；暂存24小时过期 | 过载拒绝；本次文件及数据库引用双重核对 |

以上是实验起点，不是已经验证的安全或性能保证。预检必须拒绝路径穿越/绝对路径/链接/嵌套压缩，并检查实际展开量；mammoth仅接收预检通过的数据且禁用外部文件访问。解析子进程禁止网络与非授权文件读取；Windows先验证，Linux留部署验证，不以Promise超时代替终止与退出确认。

## 合成样本矩阵

| 样本 | 预期与任务 |
|---|---|
| 中文、换行、emoji、多页PDF | T5正常提取，T7逐字引用及代理对边界 |
| 双栏PDF、表格PDF、项目列表 | T5逐块核对顺序；不确定则明确警告或失败 |
| 扫描PDF、文字/图像混合页 | T5拒绝全扫描；不能把无文本图像页当成功文本 |
| 密码PDF、损坏/截断PDF、空文本、31页 | T4/T5明确422原因 |
| 中文DOCX段落、软换行、项目列表、表格单元格 | T6逐块核对，不生成页码 |
| OLE/CFB加密DOCX、旧.doc、.docm、伪装扩展名 | T4类型/签名交叉检查，明确拒绝 |
| DOCX缺正文、空正文、损坏ZIP、CRC错误 | T4/T6明确失败 |
| ZIP穿越、绝对路径、符号链接、嵌套ZIP、外部关系 | T4拒绝，不读取/写入外部资源 |
| ZIP条目/实际展开量/压缩比/文本量超限 | T4/T6资源边界失败 |
| 中断上传、写失败、DB提交未知、客户端断连 | T2/T8精确补偿、可核查状态与回收 |
| 两份同时处理的不同owner/版本简历 | T7/T8不串文本或引用 |

T1只完成矩阵设计和Schema用例；解析样本及恶意文件的实际生成和运行归各专项，不能据矩阵宣称已验证。

## T4 预检与子进程实现边界

已实现扩展名/MIME/签名交叉检查、OLE/CFB拒绝、yauzl顺序流式预检（实际展开量/条目/压缩比/CRC）、危险路径/链接/嵌套压缩/重复条目/外部关系及实体声明拒绝。UTF-16编码XML先拒绝，避免绕过安全预检；不把其描述为完整OOXML支持。正常包须包含Content Types、根关系和正文，正文结构/内容仍由T6校验。

IsolatedParser接收字节，不接受外部文件路径；子进程环境不传数据库或模型凭证。Node permission限制只读编译代码和依赖，禁止写文件/子进程/addon/worker；可信解析依赖的网络入口另行关闭（fetch/socket/http/tls/UDP/DNS）。这不是用于执行不可信JS的通用沙箱，输入文档不得生成可执行代码。PDF/Mammoth适配器尚待T5/T6，因此当前正式worker在预检后明确失败，绝不返回占位文本。

Windows父进程以tasklist按PID轮询RSS，Linux实现读取/proc（未实测）；轮询不重叠，监测错误失败关闭，监测工具也有3秒期限。总期限包含子进程启动与解析，忙循环由父进程SIGKILL终止并等待close及在途监测结束；RSS不是瞬时OS硬配额，CPU由进程总期限约束而非独立调度配额。JS堆通过--max-old-space-size限制。默认15秒/128MiB堆/256MiB RSS是合成实验起点，不是生产容量保证。解析器实例一次仅接纳一个执行，超额立即失败；API全局装配在T8验证。

本机专项已实测网络/文件权限拒绝、不继承数据库凭证、非法JSON/输出文本超限拒绝、忙循环期限、请求中止、RSS/堆超限，以及拒绝后原PID确实退出。测试使用合成文件与独立测试worker，不证明尚未接入的PDF/DOCX解析质量；默认阈值的复杂样本和Linux验证仍待后续专项。

## T5 PDF位置与质量边界

PDF.js6.5.438 legacy构建仅用于文本抽取，接收Uint8Array，不接收URL；关闭字体回退、XFA、Wasm与worker fetch，未调用渲染或文档JavaScript。Node权限不允许加载canvas原生addon，legacy模块可能产生渲染相关警告，worker不把第三方日志混入JSON协议；文本专项在此限制下真实运行。

PDF位置字段定稿为一基page与bounds=null。TextItem的transform是基线变换，width/height不等于可精确引用的字形矩形，因此不据此伪造框。按量化行高/横向位置稳定排序，每个非空TextItem形成独立文本块；同行间距超过30 PDF单位、旋转/非LTR等产生READING_ORDER_UNCERTAIN。双栏/表格文本不承诺语义阅读顺序，引用以保存块逐字核对。块的持久UUID及引用完整性在T7落库，不依据显示排序重新生成引用。

合成ToUnicode字体样本覆盖中文、多页、项目列表、双栏/单行表格单元顺序；双栏明确警告。30页允许、31页拒绝；扫描图像页返回SCANNED_PDF，空白全文EMPTY_TEXT，混合无文本页保留PARTIAL_TEXT_LAYER；密码文件ENCRYPTED_FILE、损坏CORRUPT_FILE、文本超量TEXT_LIMIT。未使用系统字体或真实简历，不做OCR；其他复杂字体/版式仍受支持边界约束，不能用本次样本推断任意PDF质量。
