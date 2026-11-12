/* Zotero-specific storage and privileged local HTTP transport. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OllamaZoteroAdapter = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PREF = "extensions.ollama-local-ai.settings";

  function create(deps) {
    const { Zotero, core } = deps;

    function loadSettings() {
      let raw = {};
      const stored = Zotero.Prefs.get(PREF, true);
      if (typeof stored === "string" && stored) {
        try { raw = JSON.parse(stored); }
        catch (_) { /* Invalid preferences revert to safe defaults. */ }
      }
      try { return core.normalizeSettings(raw); }
      catch (_) { return core.normalizeSettings({}); }
    }

    function saveSettings(raw) {
      const settings = core.normalizeSettings(raw);
      Zotero.Prefs.set(PREF, JSON.stringify(settings), true);
      return settings;
    }

    function getSelectedItems(win) {
      const pane = win && win.ZoteroPane;
      const selected = pane && pane.getSelectedItems ? pane.getSelectedItems() : [];
      const seen = new Set();
      const items = [];
      for (let item of selected || []) {
        if (!item) continue;
        if (!item.isRegularItem() && item.parentID) item = Zotero.Items.get(item.parentID);
        if (!item || !item.isRegularItem() || item.deleted || seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
      }
      return items;
    }

    async function getItem(itemID) {
      const id = Number(itemID);
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error("无效的文献条目编号。");
      const item = await Zotero.Items.getAsync(id);
      if (!item || item.deleted || !item.isRegularItem()) throw new Error("原文献已删除或不再可用。");
      return item;
    }

    function readField(item, name) {
      try { return String(item.getField(name) || "").trim(); }
      catch (_) { return ""; }
    }

    async function collectContext(item, rawSettings) {
      const settings = core.normalizeSettings(rawSettings);
      if (!item || !item.isRegularItem() || item.deleted) throw new Error("请选择有效的文献条目。");
      if (item.loadAllData) await item.loadAllData();
      const sourceWarnings = [];
      const context = {
        title: readField(item, "title"),
        abstract: readField(item, "abstractNote"),
        authors: item.getCreators().map(creator => {
          return creator.name || [creator.firstName, creator.lastName].filter(Boolean).join(" ");
        }).filter(Boolean),
        date: readField(item, "date"),
        publicationTitle: readField(item, "publicationTitle"),
        doi: readField(item, "DOI"),
        existingTags: item.getTags().map(tag => tag.tag),
        fulltext: "",
        fulltextSource: "",
        truncated: false,
        sourceWarnings
      };

      if (settings.includeFulltext) {
        const texts = [];
        const names = [];
        let remaining = settings.maxInputChars;
        let pdfCount = 0;
        for (const attachmentID of item.getAttachments()) {
          if (pdfCount >= 2 || remaining <= 0) break;
          try {
            const attachment = await Zotero.Items.getAsync(attachmentID);
            if (!attachment || attachment.deleted || attachment.attachmentContentType !== "application/pdf") continue;
            pdfCount++;
            const cache = Zotero.FullText.getItemCacheFile(attachment);
            if (!cache || !cache.exists()) continue;
            // Zotero's third argument limits UTF-8 bytes, whereas maxInputChars
            // limits JavaScript characters. Four bytes per character also leaves
            // a look-ahead so truncation is recorded for CJK and emoji text.
            const maxBytes = remaining * 4 + 4;
            const text = String(await Zotero.File.getContentsAsync(cache.path, "utf-8", maxBytes)).trim();
            if (text.length > remaining || (Number.isFinite(cache.fileSize) && cache.fileSize > maxBytes)) {
              context.truncated = true;
            }
            if (!text) continue;
            texts.push(text.slice(0, remaining));
            names.push(readField(attachment, "title") || "PDF");
            remaining -= text.length;
          }
          catch (_) {
            sourceWarnings.push("有一份 PDF 的本地全文缓存无法读取。");
          }
        }
        const combined = texts.join("\n\n");
        if (combined.length > settings.maxInputChars) context.truncated = true;
        context.fulltext = combined.slice(0, settings.maxInputChars);
        context.fulltextSource = names.length ? "本地已索引 PDF：" + names.join("；") : "";
        if (!context.fulltext) sourceWarnings.push("未找到可读取的本地 PDF 全文缓存；本次仅使用文献元数据和摘要。");
        else sourceWarnings.push("PDF 文本取自 Zotero 已有索引，可能仅涵盖部分页；本次输入有长度限制。");
      }
      if (!context.title && !context.abstract && !context.fulltext) throw new Error("该条目没有可用的标题、摘要或本地全文，无法生成可靠内容。");
      if (!context.abstract && !context.fulltext) sourceWarnings.push("该条目缺少摘要和可用全文，生成内容仅以标题及其他元数据为依据。");
      return context;
    }

    async function transport(request) {
      const parsed = new URL(request.url);
      const origin = core.validateEndpoint(parsed.origin);
      if (!["/api/tags", "/api/show", "/api/chat"].includes(parsed.pathname) ||
          parsed.search || parsed.hash || parsed.username || parsed.password ||
          request.url !== origin + parsed.pathname) {
        throw new Error("仅允许访问本地 Ollama 的模型查询和聊天接口。");
      }
      const signal = request.signal;
      const abortError = () => {
        const error = new Error("已取消本地模型请求。");
        error.name = "AbortError";
        return error;
      };
      if (signal && signal.aborted) throw abortError();
      let cancel;
      const abort = () => { if (cancel) cancel(); };
      if (signal) signal.addEventListener("abort", abort, { once: true });
      let response;
      try {
        response = await Zotero.HTTP.request(request.method || "GET", request.url, {
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          responseType: "text",
          timeout: Math.max(1000, Math.min(Number(request.timeoutMs) || 180000, 1800000)),
          // Native Zotero 10 transport blocks redirects before contacting the target.
          followRedirects: false,
          anon: true,
          noCache: true,
          debug: false,
          logBodyLength: 0,
          successCodes: false,
          errorDelayMax: 0,
          cancellerReceiver(fn) {
            cancel = fn;
            if (signal && signal.aborted) cancel();
          }
        });
      }
      catch (error) {
        if (signal && signal.aborted) throw abortError();
        if (error && (error.name === "TimeoutException" || /timeout|timed out/i.test(String(error)))) {
          throw new Error("本地模型请求超时。可在设置中延长超时，或改用较小的模型。");
        }
        throw new Error("无法连接本地 Ollama。请先启动 Ollama，并检查地址和端口（默认 11434）。");
      }
      finally {
        if (signal) signal.removeEventListener("abort", abort);
      }
      if (signal && signal.aborted) throw abortError();
      if (response.status >= 300 && response.status < 400) {
        throw new Error("已阻止 Ollama HTTP 重定向，请填写本地服务的直接地址。");
      }
      if (response.status < 200 || response.status >= 300) {
        let detail = "";
        try { detail = String(JSON.parse(response.responseText).error || "").slice(0, 300); } catch (_) { /* Not JSON. */ }
        throw new Error("Ollama 返回 HTTP " + response.status + (detail ? "：" + detail : "。请检查服务和模型。"));
      }
      const text = String(response.responseText || "");
      if (text.length > 4 * 1024 * 1024) throw new Error("Ollama 响应过大，请减少模型输出长度。");
      let data;
      try { data = JSON.parse(text); }
      catch (_) { throw new Error("Ollama 响应不是有效 JSON，请确认地址指向 Ollama 原生 API。"); }
      if (data && data.error) throw new Error("Ollama：" + String(data.error).slice(0, 300));
      return data;
    }

    async function saveResult(itemID, result, context, rawSettings, mode) {
      const settings = core.normalizeSettings(rawSettings);
      const clean = core.parseGeneration(JSON.stringify({ tags: result.tags, note: result.note }), mode, settings);
      let noteID = null;
      const addedTags = [];
      await Zotero.DB.executeTransaction(async () => {
        const item = await Zotero.Items.getAsync(itemID);
        if (!item || item.deleted || !item.isRegularItem()) throw new Error("原文献已删除或不再可用，未写入结果。");
        const library = Zotero.Libraries.get(item.libraryID);
        if (!library || !library.editable || (item.isEditable && !item.isEditable())) {
          throw new Error("该文献库为只读，无法添加标签或简记。");
        }
        if (item.loadAllData) await item.loadAllData();
        if (mode === "tags" || mode === "both") {
          const existing = new Set(item.getTags().map(tag => tag.tag.normalize("NFKC").trim().toLocaleLowerCase()));
          for (const tag of clean.tags) {
            const key = tag.normalize("NFKC").trim().toLocaleLowerCase();
            if (existing.has(key)) continue;
            item.addTag(tag, 0);
            existing.add(key);
            addedTags.push(tag);
          }
          if (addedTags.length) await item.save();
        }
        if (mode === "note" || mode === "both") {
          const note = new Zotero.Item("note");
          note.libraryID = item.libraryID;
          note.parentID = item.id;
          note.setNote(core.renderNote(clean, context, settings, {
            model: result.model || settings.model,
            sourceInfo: result.sourceInfo,
            createdAt: new Date().toISOString()
          }));
          noteID = await note.save();
        }
      });
      return { addedTags, noteID };
    }

    return { loadSettings, saveSettings, getSelectedItems, getItem, collectContext, transport, saveResult };
  }

  return { create, PREF };
});
