# v0.1.0 预览版下载

- [下载 Zotero XPI 安装包](https://github.com/kangweihou522-cmyk/zotero-ollama-local-ai/raw/refs/heads/main/downloads/ollama-local-ai-0.1.0.xpi)
- [下载完整源码包](https://github.com/kangweihou522-cmyk/zotero-ollama-local-ai/raw/refs/heads/main/downloads/ollama-local-ai-0.1.0-source.zip)
- [SHA256 校验值](SHA256SUMS.txt)

在 Zotero「工具 → 插件」中选择「从文件安装插件…」，选中下载的 `.xpi`。

启动本机 Ollama，在插件设置中检测连接并选择已安装模型。之后选中文献，右键打开「Ollama 本地 AI」，生成并检查结果后保存。

兼容目标为 Zotero 10.0.8。核心、适配器、生命周期和模拟界面共 32 项自动测试通过，尚未完成真实 Zotero 与 Ollama 模型联合实测。完整使用步骤见[仓库说明](../README.md)。
