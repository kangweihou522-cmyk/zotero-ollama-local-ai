# v0.3.0 预览版下载

- [下载 Zotero XPI 安装包](https://github.com/kangweihou522-cmyk/zotero-ollama-local-ai/raw/refs/tags/v0.3.0/downloads/ollama-local-ai-0.3.0.xpi)
- [下载完整源码包](https://github.com/kangweihou522-cmyk/zotero-ollama-local-ai/raw/refs/tags/v0.3.0/downloads/ollama-local-ai-0.3.0-source.zip)
- [SHA256 校验值](SHA256SUMS.txt)

在 Zotero「工具 → 插件」中选择「从文件安装插件…」，选中下载的 `.xpi`。

启动本机 Ollama，在插件设置中检测连接并选择已安装模型。RTX 3060 6GB、4B 模型建议先使用快速预设的「标签 + 简记」，概览按需生成。新增流式预览、成功结果内存缓存、强制重新生成和 GPU 驻留检查。

也可选择 ChatGPT 订阅引擎，点击 Continue with ChatGPT，在官方页面登录授权后检测可用模型，无需 API Key。此模式会把选定材料发送给 OpenAI，并使用账户获准的订阅额度；实际账户资格、可用模型与限额需本机验证。

兼容目标为 Zotero 10.0.8。91 项回归与 13 项界面测试通过，并已通过 Linux 真实 Zotero 10.0.8 的安装、流式 HTTP、缓存、原生授权回调、登录管理器和数据库测试。授权和模型响应使用合成数据；真实 Plus 登录和 RTX 3060 速度尚未实测。完整使用步骤见[仓库说明](../README.md)与[验证范围](../docs/VALIDATION.md)。

新增“AI 生成概览”，可单独生成或与标签、简记一并生成。简记保存位置选择“Style 简记栏 + 新建子笔记”即可写入 Style 的 remark 字段；已有非空简记需逐篇勾选允许更新。

0.1.0、0.2.0 包保留为历史归档。0.1.0 因缺少必需更新地址可能无法安装，请使用 0.3.0。
