# v0.2.0 预览版下载

- [下载 Zotero XPI 安装包](https://github.com/kangweihou522-cmyk/zotero-ollama-local-ai/raw/refs/tags/v0.2.0/downloads/ollama-local-ai-0.2.0.xpi)
- [下载完整源码包](https://github.com/kangweihou522-cmyk/zotero-ollama-local-ai/raw/refs/tags/v0.2.0/downloads/ollama-local-ai-0.2.0-source.zip)
- [SHA256 校验值](SHA256SUMS.txt)

在 Zotero「工具 → 插件」中选择「从文件安装插件…」，选中下载的 `.xpi`。

启动本机 Ollama，在插件设置中检测连接并选择已安装模型。之后选中文献，右键打开「Ollama 本地 AI」，生成并检查结果后保存。

兼容目标为 Zotero 10.0.8。53 项自动测试通过，并已通过 Linux 真实 Zotero 10.0.8 的 XPI 安装、窗口和数据库流程验证；模型服务使用模拟数据，实际生成质量仍需本机验证。完整使用步骤见[仓库说明](../README.md)。

新增“AI 生成概览”，可单独生成或与标签、简记一并生成。简记保存位置选择“Style 简记栏 + 新建子笔记”即可写入 Style 的 remark 字段；已有非空简记需逐篇勾选允许更新。

0.1.0 包保留为历史归档，但因缺少必需的更新地址可能无法安装，请使用 0.2.0。
