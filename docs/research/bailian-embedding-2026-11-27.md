# 百炼文本向量接口核对

2026-11-27为S2.3-T7实施读取[阿里云官方同步文本向量API](https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api)，HTTP 200。本机忽略目录data/s23-bailian-official.html保存本次页面；UTF-8保存文件SHA-256为49d4b28da96deec06d760380c3a533c438c995cf2fc401d08d23851e4b28f71d。页面会更新，以下只记录本次读取内容，不是供应商永久承诺。

本次文档列出text-embedding-v4（Qwen3-Embedding系列），维数支持2048、1536、1024（默认）、768、512、256、128、64，每批最多10条、单条8192 Token。T7拟使用text-embedding-v4，显式维数由本地版本配置给出，不依赖服务端默认值；索引处理器批次8条满足本次文档上限。token输入边界仍须本地保守预算和供应商校验，不把字符数等同于token数。

文档给出的OpenAI兼容HTTP接口为`POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/embeddings`，认证为Bearer API Key，JSON请求包含model、input、dimensions、encoding_format。不同地域URL不同，部署实际endpoint/WorkspaceId由维护者在本地配置中提供，不凭示例选择实际出网区域。

特别注意：文档说明实际返回的embedding可能受网关影响为float或base64，不能只因请求encoding_format=float就假设收到数值数组；适配器应严格校验维数和有限数值，明确处理或拒绝不支持格式。返回数据index用于还原输入顺序，usage只记录供应商返回的量；缺失费用不能填0。价格和免费额度按地域/账户变化，本轮不自动推定实际费用。

此记录只完成官方文档核对；未配置Key、没有真实调用、没有创建正式embedding索引，也没有人工相关性标注或召回质量结论。适配器和本地HTTP桩验证完成后另记progress。
