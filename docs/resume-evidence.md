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
