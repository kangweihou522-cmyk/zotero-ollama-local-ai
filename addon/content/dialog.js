/* SPDX-License-Identifier: MIT */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const bridge = window.arguments?.[0];
  if (!bridge) {
    $("notice").textContent = "请从 Zotero 的 Ollama 本地 AI 菜单打开此窗口。";
    return;
  }
  const { core, adapter } = bridge;
  const entries = bridge.items.map(item => ({ ...item, state: "pending", context: null, result: null, mode: bridge.mode, error: "", allowStyleOverwrite: false }));
  let selected = entries.length ? 0 : -1;
  let busy = false;
  let controller = null;
  let closing = false;
  let installedModels = [];

  function notice(message, kind = "") {
    $("notice").textContent = message;
    $("notice").className = "notice" + (kind ? " " + kind : "");
  }
  function page(settingsPage) {
    $("panel-settings").hidden = !settingsPage;
    $("panel-generate").hidden = settingsPage;
    $("tab-settings").classList.toggle("active", settingsPage);
    $("tab-generate").classList.toggle("active", !settingsPage);
  }
  function formSettings() {
    return core.normalizeSettings({
      ...adapter.loadSettings(),
      endpoint: $("endpoint").value,
      model: $("model").value,
      language: $("language").value,
      maxTags: Number($("max-tags").value),
      maxInputChars: Number($("max-input").value),
      timeoutSeconds: Number($("timeout").value),
      contextTokens: Number($("context-tokens").value),
      includeFulltext: $("include-fulltext").checked,
      briefTarget: $("brief-target").value,
      instructions: $("instructions").value
    });
  }
  function fillSettings(settings) {
    $("endpoint").value = settings.endpoint;
    $("language").value = settings.language;
    $("max-tags").value = settings.maxTags;
    $("max-input").value = settings.maxInputChars;
    $("timeout").value = settings.timeoutSeconds;
    $("context-tokens").value = String(settings.contextTokens || 16384);
    $("include-fulltext").checked = settings.includeFulltext;
    $("brief-target").value = settings.briefTarget || "note";
    $("instructions").value = settings.instructions;
    if (settings.model) {
      const option = document.createElementNS("http://www.w3.org/1999/xhtml", "option");
      option.value = settings.model;
      option.textContent = settings.model + "（检测连接以确认）";
      $("model").append(option);
      $("model").value = settings.model;
    }
    modelSummary(settings);
  }
  function modelSummary(settings) {
    $("model-summary").textContent = settings.model ? "模型：" + settings.model : "尚未选择模型";
  }
  function setBusy(value) {
    busy = value;
    for (const id of ["generate", "mode", "items", "save-settings", "refresh-models", "endpoint", "model", "language", "max-tags", "max-input", "timeout", "context-tokens", "include-fulltext", "instructions", "brief-target"]) {
      $(id).disabled = value || (id === "generate" && !entries.length);
    }
    $("cancel").disabled = !value;
    renderCurrent();
  }
  function renderList() {
    const markers = { pending: "○", generating: "…", ready: "●", saved: "✓", error: "!" };
    $("items").replaceChildren();
    entries.forEach((entry, index) => {
      const option = document.createElementNS("http://www.w3.org/1999/xhtml", "option");
      option.value = String(index);
      option.textContent = `${markers[entry.state]} ${entry.title}`;
      option.title = entry.title;
      $("items").append(option);
    });
    $("items").value = String(selected);
    $("item-count").textContent = `${entries.length} 篇`;
  }
  function persistEdits() {
    const entry = entries[selected];
    if (!entry || entry.state !== "ready") return;
    entry.result.tags = $("result-tags").value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    entry.result.note = $("result-note").value;
    entry.allowStyleOverwrite = $("allow-style-overwrite").checked;
    if (core.modeIncludes(entry.mode, "overview")) {
      entry.result.overview = Object.fromEntries(core.OVERVIEW_FIELDS.map(({ key }) => [key, $("overview-" + key).value]));
    }
  }
  function sourceText(entry) {
    if (!entry.context) return "生成前将读取本地元数据和可用的 PDF 索引。";
    const evidence = entry.result?.sourceInfo;
    const hasFulltext = evidence ? evidence.hasFulltext : Boolean(entry.context.fulltext);
    const info = hasFulltext ? "元数据 + 本地 PDF 索引" : "仅标题 / 摘要等元数据，未使用 PDF 正文";
    const budget = evidence ? `实际输入 ${evidence.inputChars} 字符${evidence.contextTokens ? `；上下文 ${evidence.contextTokens} tokens` : ""}${evidence.truncated ? "；输入已截断" : ""}` : "";
    return [info, budget, ...(entry.context.sourceWarnings || [])].filter(Boolean).join("\n");
  }
  function renderCurrent() {
    const entry = entries[selected];
    const mode = entry?.result ? entry.mode : $("mode").value;
    $("tags-area").hidden = !core.modeIncludes(mode, "tags");
    $("note-area").hidden = !core.modeIncludes(mode, "note");
    $("overview-area").hidden = !core.modeIncludes(mode, "overview");
    $("item-title").textContent = entry?.title || "请先在文献库选中文献";
    $("source-info").textContent = entry ? sourceText(entry) : "关闭此窗口，在文献库选中一篇或多篇文献后重新打开。";
    $("result-tags").value = entry?.result?.tags.join("\n") || "";
    $("result-note").value = entry?.result?.note || "";
    for (const { key } of core.OVERVIEW_FIELDS) $("overview-" + key).value = entry?.result?.overview?.[key] || "";
    const editable = entry?.state === "ready" && !busy;
    $("result-tags").disabled = !editable;
    $("result-note").disabled = !editable;
    for (const { key } of core.OVERVIEW_FIELDS) $("overview-" + key).disabled = !editable;
    const styleTarget = $("brief-target").value === "style-and-note";
    $("style-preview").hidden = !styleTarget;
    $("existing-style-remark").textContent = entry?.context?.styleRemarkAmbiguous
      ? "该条目的 Extra 中有多条 remark，需先整理后才能写入 Style 简记栏。"
      : entry?.context?.styleRemark ? "已有 Style 简记：" + entry.context.styleRemark
      : "保存时将新增 Extra 的 remark 行；其他字段保留。";
    $("style-overwrite-label").hidden = !entry?.context?.styleRemark;
    $("allow-style-overwrite").checked = Boolean(entry?.allowStyleOverwrite);
    $("allow-style-overwrite").disabled = !editable;
    $("save-current").disabled = !editable;
    $("save-all").disabled = busy || !entries.some(item => item.state === "ready");
    const labels = { pending: "待生成", generating: "正在生成…", ready: "待保存 · 可编辑", saved: "已保存到 Zotero", error: "生成失败 · 可重试" };
    $("item-status").textContent = entry ? (entry.error || labels[entry.state]) : "";
  }
  async function detectModels(settings, signal) {
    const current = $("model").value;
    const models = await core.listModels(adapter.transport, settings, signal);
    installedModels = models;
    $("model").replaceChildren();
    const empty = document.createElementNS("http://www.w3.org/1999/xhtml", "option");
    empty.value = "";
    empty.textContent = models.length ? "请选择模型" : "没有本地模型，请先 ollama pull";
    $("model").append(empty);
    for (const model of models) {
      const option = document.createElementNS("http://www.w3.org/1999/xhtml", "option");
      option.value = model.name;
      option.textContent = model.name;
      $("model").append(option);
    }
    $("model").value = models.some(model => model.name === current) ? current : (models[0]?.name || "");
    $("connection-status").textContent = `连接成功，发现 ${models.length} 个本地模型。`;
    return models;
  }
  async function refreshModels() {
    try {
      persistEdits();
      const settings = formSettings();
      controller = new AbortController();
      setBusy(true);
      notice("正在连接本机 Ollama…");
      await detectModels(settings, controller.signal);
      notice(installedModels.length ? "连接成功。选择模型后保存设置，即可生成。" : "Ollama 已连接，但没有可用的本地模型。请先下载模型。", installedModels.length ? "" : "warn");
    } catch (error) {
      $("connection-status").textContent = error.message;
      notice(error.message, "error");
    } finally { controller = null; setBusy(false); }
  }
  function saveSettings() {
    try {
      const settings = formSettings();
      if (!settings.model) throw new Error("请检测连接并选择一个已安装模型。");
      adapter.saveSettings(settings);
      modelSummary(settings);
      notice("设置已保存。回到「文献整理」即可开始生成。");
    } catch (error) { notice(error.message, "error"); }
  }
  async function generate() {
    persistEdits();
    const pending = entries.filter(entry => entry.state === "pending" || entry.state === "error");
    if (!pending.length) { notice("所有文献都已有结果。请预览并保存；如需重新生成，请关闭后从文献库重新打开。"); return; }
    let settings;
    try {
      settings = formSettings();
      if (!settings.model) { page(true); throw new Error("请先检测连接、选择本地模型并保存设置。"); }
      adapter.saveSettings(settings);
      modelSummary(settings);
      controller = new AbortController();
      setBusy(true);
      notice("正在确认本地模型…");
      const models = await detectModels(settings, controller.signal);
      if (!models.some(model => model.name === settings.model)) {
        page(true);
        throw new Error(`本机未找到模型 ${settings.model}。请重新选择模型。`);
      }
      let completed = 0;
      for (const entry of pending) {
        if (controller.signal.aborted || closing) break;
        selected = entries.indexOf(entry);
        entry.mode = $("mode").value;
        entry.state = "generating";
        entry.error = "";
        entry.allowStyleOverwrite = false;
        renderList(); renderCurrent();
        notice(`正在生成 ${completed + 1} / ${pending.length}：${entry.title}\n首次加载模型可能需要较长时间。`);
        try {
          const item = await adapter.getItem(entry.id);
          entry.context = await adapter.collectContext(item, settings);
          if (controller.signal.aborted || closing) { entry.state = "pending"; break; }
          entry.result = await core.generate(adapter.transport, entry.context, entry.mode, settings, controller.signal);
          entry.settings = { ...settings };
          entry.state = "ready";
        } catch (error) {
          if (controller.signal.aborted || closing) { entry.state = "pending"; break; }
          entry.state = "error";
          entry.error = error.message;
        }
        completed++;
        renderList(); renderCurrent();
      }
      const ready = entries.filter(entry => entry.state === "ready").length;
      const errors = entries.filter(entry => entry.state === "error").length;
      notice(`${controller.signal.aborted ? "已停止。" : "生成结束。"}${ready} 篇待保存，${errors} 篇失败。请检查结果后保存。`, errors ? "warn" : "");
    } catch (error) { notice(error.message, "error"); }
    finally { controller = null; setBusy(false); renderList(); }
  }
  async function saveEntries(all) {
    persistEdits();
    const targets = all ? entries.filter(entry => entry.state === "ready") : [entries[selected]].filter(entry => entry?.state === "ready");
    if (!targets.length) return;
    setBusy(true);
    $("cancel").disabled = true;
    let saved = 0;
    const errors = [];
    for (const entry of targets) {
      try {
        notice(`正在保存 ${saved + 1} / ${targets.length}：${entry.title}`);
        // Validate edited fields before starting the database transaction.
        const validated = core.parseGeneration(JSON.stringify({tags:entry.result.tags,note:entry.result.note,overview:entry.result.overview}), entry.mode, entry.settings);
        const result = { ...entry.result, ...validated };
        const saveSettings = { ...entry.settings, briefTarget: $("brief-target").value };
        await adapter.saveResult(entry.id, result, entry.context, saveSettings, entry.mode, { allowStyleOverwrite: entry.allowStyleOverwrite });
        entry.result = result;
        entry.state = "saved";
        entry.error = "";
        saved++;
      } catch (error) {
        entry.error = "保存失败：" + error.message;
        errors.push(entry.title + "：" + error.message);
      }
      renderList(); renderCurrent();
    }
    setBusy(false);
    notice(`已保存 ${saved} 篇。${errors.length ? "\n" + errors.join("\n") : "所选结果已写入 Zotero。"}`, errors.length ? "error" : "");
  }

  $("version").textContent = "v" + bridge.version + " · Zotero " + (bridge.hostVersion || "10");
  fillSettings(adapter.loadSettings());
  $("mode").value = bridge.mode || "all";
  renderList(); renderCurrent(); setBusy(false);
  page(Boolean(bridge.settingsPage));
  notice(entries.length ? `已选中 ${entries.length} 篇文献。生成完成后可预览、编辑，再保存到文献库。` : "请先配置本地模型。生成时，请从文献库选中文献后重新打开。 ");
  $("tab-settings").addEventListener("click", () => page(true));
  $("tab-generate").addEventListener("click", () => page(false));
  $("items").addEventListener("change", () => { persistEdits(); selected = Number($("items").value); renderCurrent(); });
  $("mode").addEventListener("change", () => { persistEdits(); renderCurrent(); });
  $("brief-target").addEventListener("change", () => {
    persistEdits();
    try { adapter.saveSettings(formSettings()); renderCurrent(); }
    catch (error) { notice(error.message, "error"); }
  });
  $("refresh-models").addEventListener("click", refreshModels);
  $("save-settings").addEventListener("click", saveSettings);
  $("generate").addEventListener("click", generate);
  $("cancel").addEventListener("click", () => controller?.abort());
  $("save-current").addEventListener("click", () => saveEntries(false));
  $("save-all").addEventListener("click", () => saveEntries(true));
  window.addEventListener("unload", () => { closing = true; controller?.abort(); }, { once: true });
})();
