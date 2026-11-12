# Ollama Local AI · Zotero 本地标签与简记

为选中的 Zotero 文献调用本机 Ollama，生成标签和简记。支持逐篇预览、直接编辑、批量保存；简记保存为**文献下的新子笔记**。

当前版本：`0.1.0`。兼容目标是 **Zotero 10.0.8 桌面版**；安装清单允许 `10.0.x`。本项目尚未在真实 Zotero 10.0.8 和真实 Ollama 模型中完成联合实测，验证范围见 [docs/VALIDATION.md](docs/VALIDATION.md)。

下载：[v0.1.0 预览版与安装包](https://github.com/kangweihou522-cmyk/zotero-ollama-local-ai/releases/tag/v0.1.0)。在该页面的 Assets 中下载 `.xpi`；源码包和中文说明一并提供。

![使用模拟数据的界面预览](docs/preview.png)

## 安装与首次使用

1. 从 [Ollama 官网](https://ollama.com/)安装适合系统的版本，并启动 Ollama。桌面应用已在后台运行时，无需重复运行服务；命令行启动方式为：

   ```sh
   ollama serve
   ```

2. 下载一个适合本机内存、显存的模型，例如：

   ```sh
   ollama pull qwen3:8b
   ```

   也可使用 `qwen2.5:7b` 等指令模型。模型越大，通常需要更多内存和生成时间。插件不会代为下载模型。

3. 在 Zotero 打开「工具 → 插件」，点击齿轮菜单中的「从文件安装插件…」，选择 `ollama-local-ai-0.1.0.xpi`。如果 Zotero 提示重启，按提示操作。
4. 打开「工具 → Ollama 本地 AI → 模型与生成设置…」，保留默认地址 `http://127.0.0.1:11434`，点击「检测连接」，选择已安装的本地模型，保存设置。也可从 Zotero 设置中的「Ollama Local AI」进入。
5. 返回文献库，选中一篇或多篇文献，右键选择「Ollama 本地 AI」，打开「生成标签与简记…」「仅生成标签…」或「仅生成简记…」。
6. 点击「开始生成」。生成结束后逐篇检查和编辑结果，点击「保存本篇」或「保存全部待保存结果」。

界面默认中文，也可在设置中选择英文输出、标签数量、输入字符上限、模型上下文长度、请求超时和补充要求。

## 生成与保存行为

- **标签**：在文献原有标签上追加并去重，不删除标签，也不改变已有标签的普通/自动类型。
- **简记**：每次保存新增一篇子笔记，保留已有笔记。笔记包含模型、材料来源、输入是否截断和生成时间。
- **预览**：生成不会自动写入 Zotero；标签可按每行一个编辑，简记可直接修改。已保存的结果在当前窗口不能重复保存。
- **批量**：按顺序逐篇生成，减少同时加载造成的资源压力。点击「停止」会取消当前请求并停止后续条目；已生成的结果仍可保存。
- **选择附件**：选中附件或子笔记时，使用它所属的文献；同一文献只处理一次。独立笔记和独立附件不会作为文献处理。
- **权限**：保存时重新检查条目是否仍然存在、文献库是否可编辑；只读库不会写入。

## 文本来源与边界

输入包括文献标题、摘要、作者、日期、期刊、DOI 和已有标签。启用全文选项时，还会读取至多两份 PDF 附件的 **Zotero 本地全文索引缓存**。

插件不自动下载附件，不执行 OCR，也不建立新的全文索引。未下载的 PDF、未索引的附件或没有文字层的扫描件可能没有可用全文，此时界面会提示仅依据元数据和摘要。Zotero 已有索引也可能只包含部分页面；有文本缓存不代表已读完全文。

输入字符上限默认 24,000，可在设置中调整到 2,000～120,000。模型上下文默认 16,384 tokens，可按硬件条件调整；上下文越长，通常越占用内存。插件会读取模型公布的上下文上限，设置 Ollama 的 `num_ctx`，为提示词和输出留出空间，再以 UTF-8 字节数保守限制材料长度，因此实际输入可能比字符上限短。界面会显示实际输入字符数、上下文和截断情况；简记保留来源范围及截断提示。

不同模型的分词方式不同，预算不能等同于模型实际 token 数。Qwen3 等支持关闭思考的模型会优先关闭思考；只支持思考等级的模型使用其支持的低等级，其余保留服务默认行为。AI 输出仍可能出错，请结合原文核对。

## 本地连接与同步

插件仅允许 `localhost`、`127.0.0.1`、`[::1]` 本机回环地址，使用 Ollama 原生 `/api/tags`、`/api/show`、`/api/chat` 接口。无需 API Key，禁止 HTTP 重定向，并拒绝已识别的云模型及云端别名。生成请求不会发往插件作者或其他在线 AI 服务。

本地推理不改变 Zotero 的同步方式：保存后的标签和笔记仍遵循你的 Zotero 同步设置。本机 Ollama 的安装、模型下载及其自身配置由用户管理。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 无法连接 Ollama | 确认 Ollama 正在运行，检查地址、端口；默认端口为 `11434`。 |
| 连接成功但没有模型 | 先执行 `ollama pull 模型名`，下载完成后重新检测连接。云模型不会列为可用本地模型。 |
| 请求超时 | 首次加载可能较慢；延长超时，减少输入长度，或选择更小的模型。 |
| 模型返回格式错误或内容为空 | 重试或换用适合指令与 JSON 输出的模型；不要手动使用兼容 OpenAI API 的 `/v1` 地址。 |
| 提示没有 PDF 全文缓存 | 确认附件在本地，并通过 Zotero 自身的全文索引功能建立索引；扫描件需先有可提取文字。 |
| 无法保存到群组库 | 检查文献库写权限，或将文献复制到可编辑的文献库。 |
| 需要重新生成 | 关闭生成窗口，从文献库重新选中并打开；再次保存会新建子笔记。 |

## 开发与打包

运行时无需 Node.js、Python 或额外 npm 包。开发时使用 Node.js 18+ 和 Python 3.9+。

```sh
npm test
python3 scripts/build.py
```

默认输出到 `dist/`：

- `ollama-local-ai-0.1.0.xpi`：可安装文件，根目录直接包含 `manifest.json` 和 `bootstrap.js`。
- `ollama-local-ai-0.1.0-source.zip`：源码、测试、文档和打包脚本。

可指定输出目录：

```sh
python3 scripts/build.py --output /path/to/output
```

构建只使用 Python 标准库，不下载依赖；归档使用固定时间戳和排序，便于复现。`npm test` 为不依赖第三方包的核心、适配器与生命周期测试。

可选界面测试使用 Playwright 和 Chromium：

```sh
npm install --no-save playwright
npx playwright install chromium
npm run test:ui
```

界面测试使用模拟 Zotero/Ollama 桥接，不能替代真实宿主与真实模型测试。

主要文件：`addon/bootstrap.js` 管理生命周期；`content/main.js` 注册菜单和设置入口；`content/core.js` 处理提示词、输出校验与笔记格式；`content/zotero-adapter.js` 连接 Zotero 与 Ollama；`content/dialog.*` 提供预览编辑界面。

## 参考与许可

本项目独立实现，参考 Awesome GPT、Ethereal Style 的文献整理使用场景，没有复制其源代码，不依赖这些插件，也不写入 Ethereal Style 的内部简记字段。

- [Zotero 10 开发文档](https://www.zotero.org/support/dev/zotero_10_for_developers)
- [Zotero 官方版本记录](https://www.zotero.org/support/changelog)
- [Zotero 10.0.8 插件菜单 API 源码](https://github.com/zotero/zotero/blob/10.0.8/chrome/content/zotero/xpcom/pluginAPI/menuManager.js)
- [Ollama API 类型定义](https://github.com/ollama/ollama/blob/main/api/types.go)
- [Ollama API 文档](https://github.com/ollama/ollama/tree/main/docs/api)

项目采用 [MIT License](LICENSE)。
