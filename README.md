# Ollama Local AI · Zotero 标签、简记与概览

为选中的文献生成标签、一句话简记和结构化概览，检查、编辑后保存到 Zotero。**0.3.0 预览版**增加面向小显存的快速预设、流式预览、内存缓存，以及官方 ChatGPT 订阅授权引擎；仍可完全使用本机 Ollama。

兼容目标为 **Zotero 10.0.8 桌面版**，安装清单允许 `10.0.x`。其他主版本未声明兼容。测试结果和边界见[验证说明](docs/VALIDATION.md)，本机模型的质量和实际耗时需要用自己的文献检查。

下载：[XPI 安装包](https://github.com/kangweihou522-cmyk/zotero-ollama-local-ai/raw/refs/tags/v0.3.0/downloads/ollama-local-ai-0.3.0.xpi) · [完整源码包](https://github.com/kangweihou522-cmyk/zotero-ollama-local-ai/raw/refs/tags/v0.3.0/downloads/ollama-local-ai-0.3.0-source.zip) · [v0.3.0 说明](https://github.com/kangweihou522-cmyk/zotero-ollama-local-ai/releases/tag/v0.3.0)。

## 可以完成什么

| 功能 | 内容 | 保存位置 |
| --- | --- | --- |
| AI 标签 | 文献的主题、对象、方法等学术标签 | 追加并去重，保留已有标签 |
| AI 简记 | 一句话短提示，默认要求约 15～40 个汉字 | 新子笔记；可选同时写入 Style 简记栏 |
| AI 概览 | 单篇文献的背景、问题、方法、发现、局限、参考价值 | 独立结构化子笔记 |

默认先生成“标签 + 简记”，概览按需选择。也可单独生成任一项或全部三项。多选文献时逐篇处理，支持停止；本版没有跨文献综合综述、完整 PDF 分块或 OCR。

本插件使用独立的 **“Ollama 本地 AI”菜单**。Style 原菜单仍由 Style 与 Awesome GPT 处理；安装本插件不会改变原菜单的模型设置。

## 安装与本地快速设置

1. 在 Zotero“工具 → 插件”的齿轮菜单中选择“从文件安装插件…”，安装 `ollama-local-ai-0.3.0.xpi`，按提示重启。不要继续使用缺少必需更新字段的旧版 `0.1.0`。
2. 安装并启动 [Ollama](https://ollama.com/)。后台应用已运行时不用重复启动服务；命令行方式为 `ollama serve`。通过 `ollama list` 确认模型已部署。
3. 打开“工具 → Ollama 本地 AI → 模型与生成设置…”，选择本地 Ollama 引擎。保留根地址 `http://127.0.0.1:11434`，检测连接并选择已安装模型。
4. 对 4B 模型、RTX 3060 6GB 这类配置，先选择“快速”预设，生成标签和简记；需要详细内容时再生成概览。
5. 选中文献，右键打开本插件，生成并检查结果，编辑后保存本篇或全部待保存结果。

| 预设与任务 | 上下文上限 | 材料字符上限 | PDF 缓存 |
| --- | --- | --- | --- |
| 快速：标签／简记／两者 | 4096 tokens | 4000 字符 | 关闭，使用元数据和摘要 |
| 快速：概览／全部三项 | 8192 tokens | 8000 字符 | 关闭，使用元数据和摘要 |
| 均衡 | 8192 tokens | 12000 字符 | 使用可用的本地索引 |
| 自定义 | 使用界面设置 | 使用界面设置 | 使用界面选择 |

实际输入还受模型公布的上下文能力及提示词、输出预算限制，因此可能短于表中字符上限。降低上下文可减少显存压力；具体速度仍取决于模型量化、GPU 使用、材料长度与输出长度。本版不承诺固定的每篇秒数。生成时可运行 `ollama ps` 查看 `PROCESSOR`，也可通过插件提供的运行信息检查可获取的模型驻留情况。[Ollama 说明](https://docs.ollama.com/faq#how-can-i-tell-if-my-model-was-loaded-onto-the-gpu)

## ChatGPT 订阅授权模式

本地开源应用可通过官方 **Sign in with ChatGPT**，请求符合资格的 ChatGPT Plus／Pro 账户使用订阅额度，无需用户提供另行计费的 API Key。[官方快速开始](https://developers.openai.com/siwc/quickstart)

1. 在插件设置中选择 ChatGPT 订阅引擎，点击 **Continue with ChatGPT**。
2. 在官方 OpenAI 登录页面完成登录，确认对本应用的授权。
3. 返回插件，检测账户可用模型并选择模型。可用目录不等于保证每个模型都获准使用，实际请求还要通过账户权限与额度检查。
4. 生成前检查材料范围；该引擎会将选中文献的标题、摘要或所选 PDF 索引文本发送给 OpenAI。生成结果仍在 Zotero 中预览并由你保存。

此通道使用官方 OAuth 订阅授权，不抓取网页 Cookie，也不读取 ChatGPT 聊天记录。仍受订阅、账户和模型限制；达到限额、授权失效或权限不足时会提示，不会自动改用 API Key 计费。可选择回本地引擎，或在官方账户设置中管理授权与额度。[机制说明](https://developers.openai.com/siwc/token-sharing-open-source)、[预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

OAuth 令牌交由 Zotero／Mozilla 登录管理器保管和刷新，不写入插件普通偏好、明文生成缓存或仓库。退出登录会清除本机保存的登录令牌；如提示远端撤销未确认，可在 ChatGPT 设置中断开应用。宿主登录管理器本身的保护方式遵循 Zotero 与操作系统配置。

官方通道仍处预览阶段，实际登录、账户资格、可用模型和生成速度需在用户本机验证。开发与自动测试使用模拟授权和模型响应，不会要求用户把密码、Cookie 或令牌发到聊天中。

## 流式预览与缓存

生成时逐步显示已收到的回答，便于及早看到进展；只有完整响应通过 JSON 与内容校验后，结果才能保存。中断或失败的部分文本不会写入文献库。流式显示改善等待反馈，本身不保证模型推理更快。

成功结果可在内存中复用：上限 50 条，最长保留 24 小时。键包含引擎、账户、模型、任务、生成设置和材料；这些内容变化后重新生成。缓存副本与可编辑草稿分离，修改预览不会污染后续缓存。

缓存不写入磁盘，重启 Zotero 后清空。需要重新请求时选择忽略缓存，或清空缓存；失败和取消的请求不会进入结果缓存。保存后的子笔记、标签和 Extra 仍属于正常 Zotero 数据。

## Style 简记栏互通

Style 的简记存放在 Extra（“其他”）字段的 `remark: 文本` 行，是短提示，不是较长的概览。[作者说明](https://github.com/MuiseDestiny/zotero-style/issues/1308)

默认创建简记子笔记。保存位置选择“Style 简记栏 + 新建子笔记”后，保存时可同时写入 `remark:`；概览另存为子笔记。

- 只修改目标行，保留 Extra 中的 DOI、引用键、评级及其他内容。
- 更新已有非空简记，需要在该篇预览中勾选允许更新。
- 原简记在生成后被修改时，会停止保存并提示；多条 `remark:` 需先人工整理。
- 缓存复用不会代替上述保存前检查。

## 材料、保存与同步

材料包括标题、摘要、作者、日期、期刊、DOI 和已有标签。均衡或自定义模式启用 PDF 时，读取至多两份 **Zotero 本地全文索引缓存**。不自动下载附件、不建立新索引，也不执行 OCR。索引可能只覆盖部分页；有缓存不等于读完全文。

子笔记保留所用引擎、模型、材料来源和截断提示。材料不足时应标为“材料未提供”；只有标题、摘要或部分索引的概览不能等同于全文结论。AI 输出需要对照原文检查。

生成只产生预览，保存时才写入。保存新增子笔记并保留旧笔记；已保存结果在当前窗口不能重复保存。选中附件或子笔记时会使用其所属文献并去重，保存前复查条目存在性和文献库写权限。

Ollama 引擎只接受 `localhost`、`127.0.0.1`、`[::1]`，禁止重定向，拒绝已识别的云模型。ChatGPT 引擎只使用明确的官方授权与生成端点。保存后的标签、Extra 和笔记仍遵循 Zotero 同步设置。

## 保留原 Style 菜单调用 Ollama

原调用链为 **Style → Awesome GPT → 模型接口**。[作者用法](https://github.com/windingwind/zotero-actions-tags/discussions/519)

| Awesome GPT 设置 | 内容 |
| --- | --- |
| 协议 | OpenAI Chat |
| Full URL | 开启 |
| API 地址 | `http://127.0.0.1:11434/v1/chat/completions` |
| API Key | 非空占位值 `ollama` |
| Model | `ollama list` 中的完整名称 |

本插件的 Ollama 地址填写根地址，以上 Awesome GPT 配置填写完整路径；两处设置相互独立。此表只针对原菜单的本地 Ollama 配置，**不是 ChatGPT 订阅授权入口**。不同插件版本入口可能不同。[占位 Key 实例](https://github.com/MuiseDestiny/zotero-gpt/issues/472#issuecomment-3345029250)

## 常见问题与后续方向

| 现象 | 处理方式 |
| --- | --- |
| 本地生成约一分钟 | 先用快速预设只生成标签和简记，检查 GPU 驻留，再按需生成概览。 |
| 生成刚开始较慢 | 首次加载和材料处理也占时间；参考实际加载、生成统计，不能只看窗口等待时间。 |
| 没有可用本地模型 | 确认 Ollama 运行、端口正确且 `ollama list` 能列出模型。 |
| ChatGPT 模型不可用或达到限额 | 检查官方授权和订阅额度，必要时重新登录；不会自动产生 API Key 费用。 |
| 输出格式错误或内容不完整 | 减少材料、换用适合指令与结构化输出的模型，或忽略缓存后重试。 |
| 缺少 PDF 缓存 | 使用 Zotero 自身索引功能；扫描件需先有文字层。 |
| Style 简记不显示 | 确认保存位置及 Extra 的 `remark:`，检查 Style 显示设置。 |
| 安装提示不兼容 | 在“帮助 → 关于 Zotero”检查本体版本；当前支持范围为 `10.0.x`。 |

尚未实现：完整 PDF 分块与原文定位、多篇综合、按任务分别指定模型、受控标签词表。当前没有在用户的 RTX 3060 6GB 与实际 Plus 账户上测得的速度保证。

## 开发与打包

运行插件无需 Node.js 或 Python；开发使用 Node.js 18+、Python 3.9+。

```sh
npm test
python3 scripts/build.py
```

`dist/` 生成 `ollama-local-ai-0.3.0.xpi` 与 `ollama-local-ai-0.3.0-source.zip`。可用 `python3 scripts/build.py --output /path/to/output` 指定目录。构建仅使用 Python 标准库，校验必需更新元数据与双引擎资源，并采用固定时间戳和排序。

可选模拟界面测试需要 Playwright 与 Chromium：

```sh
npm install --no-save playwright
npx playwright install chromium
npm run test:ui
```

原生测试和授权验证的范围见[验证说明](docs/VALIDATION.md)。本项目独立实现，未复制 Awesome GPT 或 Ethereal Style 源码，采用 [MIT License](LICENSE)。
