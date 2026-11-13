/* Zotero-specific storage and privileged local HTTP transport. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OllamaZoteroAdapter = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PREF = "extensions.ollama-local-ai.settings";

  // Style stores its brief remark in an Extra field line. Keep the rest of
  // Extra opaque so citation metadata and other plugins' values are preserved.
  function styleRemarkLines(extra) {
    const pieces = String(extra || "").split(/(\r\n|\n|\r)/);
    const matches = [];
    for (let index = 0; index < pieces.length; index += 2) {
      const match = /^\s*remark\s*:\s?(.*)$/i.exec(pieces[index]);
      if (match) matches.push({ index, value: match[1].trim() });
    }
    if (matches.length > 1) throw new Error("Extra 中存在多条 remark:，请先在 Zotero 中整理简记字段，未自动改写。");
    return { pieces, match: matches[0] || null };
  }

  function readStyleRemark(extra) {
    const { match } = styleRemarkLines(extra);
    return match ? match.value : null;
  }

  function updateStyleRemark(extra, note) {
    const original = String(extra || "");
    const text = String(note || "").replace(/\s+/g, " ").trim();
    if (!text) throw new Error("简记内容为空，未改写 Style 简记栏。");
    const { pieces, match } = styleRemarkLines(original);
    if (match) {
      pieces[match.index] = "remark: " + text;
      return pieces.join("");
    }
    const newline = (original.match(/\r\n|\n|\r/) || ["\n"])[0];
    return "remark: " + text + (original ? newline + original : "");
  }

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
      let styleRemark = null;
      let styleRemarkAmbiguous = false;
      try { styleRemark = readStyleRemark(item.getField("extra")); }
      catch (_) {
        styleRemarkAmbiguous = true;
        sourceWarnings.push("Extra 中存在多条 remark:；可生成子笔记，但需要先整理后才能写入 Style 简记栏。");
      }
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
        styleRemark,
        styleRemarkAmbiguous,
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
      if (!["/api/tags", "/api/show", "/api/chat", "/api/ps"].includes(parsed.pathname) ||
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
      const streaming = request.stream === true || typeof request.onChunk === "function";
      const limit = 4 * 1024 * 1024;
      let cancel;
      let observerXHR;
      let progressListener;
      let receivedCharacters = 0;
      let callbackError;
      // XHR incrementally decodes UTF-8 responseText for us. Slice by the
      // previous JS-string length without interpreting NDJSON in this layer.
      const flushProgress = xhr => {
        if (!streaming || callbackError || (signal && signal.aborted)) return;
        if (!xhr || xhr.status < 200 || xhr.status >= 300) return;
        let content;
        try { content = String(xhr.responseText || ""); }
        catch (_) { return; /* Headers may arrive before readable text. */ }
        if (content.length > limit) {
          callbackError = new Error("Ollama 响应过大，请减少模型输出长度。");
          if (cancel) cancel();
          return;
        }
        if (content.length <= receivedCharacters) return;
        const delta = content.slice(receivedCharacters);
        receivedCharacters = content.length;
        if (typeof request.onChunk === "function") {
          try { request.onChunk(delta); }
          catch (error) {
            callbackError = error instanceof Error ? error : new Error(String(error));
            if (cancel) cancel();
          }
        }
      };
      const abort = () => { if (cancel) cancel(); };
      if (signal) signal.addEventListener("abort", abort, { once: true });
      let response;
      try {
        response = await Zotero.HTTP.request(request.method || "GET", request.url, {
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          headers: { Accept: streaming ? "application/x-ndjson" : "application/json", "Content-Type": "application/json" },
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
          requestObserver(xhr) {
            if (!streaming) return;
            observerXHR = xhr;
            progressListener = () => flushProgress(xhr);
            xhr.addEventListener("progress", progressListener);
          },
          cancellerReceiver(fn) {
            cancel = fn;
            if (signal && signal.aborted) cancel();
          }
        });
      }
      catch (error) {
        if (signal && signal.aborted) throw abortError();
        if (callbackError) throw callbackError;
        if (error && (error.name === "TimeoutException" || /timeout|timed out/i.test(String(error)))) {
          throw new Error("本地模型请求超时。可在设置中延长超时，或改用较小的模型。");
        }
        throw new Error("无法连接本地 Ollama。请先启动 Ollama，并检查地址和端口（默认 11434）。");
      }
      finally {
        if (signal) signal.removeEventListener("abort", abort);
        if (observerXHR && progressListener) observerXHR.removeEventListener("progress", progressListener);
      }
      if (signal && signal.aborted) throw abortError();
      if (callbackError) throw callbackError;
      if (response.status >= 300 && response.status < 400) {
        throw new Error("已阻止 Ollama HTTP 重定向，请填写本地服务的直接地址。");
      }
      if (response.status < 200 || response.status >= 300) {
        let detail = "";
        try { detail = String(JSON.parse(response.responseText).error || "").slice(0, 300); } catch (_) { /* Not JSON. */ }
        throw new Error("Ollama 返回 HTTP " + response.status + (detail ? "：" + detail : "。请检查服务和模型。"));
      }
      const text = String(response.responseText || "");
      if (text.length > limit) throw new Error("Ollama 响应过大，请减少模型输出长度。");
      if (streaming) {
        // The final load can contain bytes for which Gecko emitted no progress
        // event. Flush that suffix once, then return the complete raw body.
        flushProgress(response);
        if (callbackError) throw callbackError;
        return text;
      }
      let data;
      try { data = JSON.parse(text); }
      catch (_) { throw new Error("Ollama 响应不是有效 JSON，请确认地址指向 Ollama 原生 API。"); }
      if (data && data.error) throw new Error("Ollama：" + String(data.error).slice(0, 300));
      return data;
    }

    async function getRuntimeInfo(rawSettings, signal) {
      const settings = core.normalizeSettings(rawSettings);
      const data = await transport({
        url: settings.endpoint + "/api/ps", method: "GET",
        timeoutMs: Math.min(settings.timeoutSeconds * 1000, 10000), signal
      });
      if (!data || !Array.isArray(data.models)) throw new Error("Ollama 的运行状态响应格式错误。");
      const nonnegative = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
      const models = data.models.filter(model => model && typeof (model.name || model.model) === "string")
        .map(model => {
          const sizeBytes = nonnegative(model.size);
          const vramBytes = nonnegative(model.size_vram);
          const gpuFraction = sizeBytes > 0 && vramBytes !== null ? Math.min(1, vramBytes / sizeBytes) : null;
          return {
            name: model.name || model.model,
            sizeBytes,
            vramBytes,
            cpuBytes: sizeBytes !== null && vramBytes !== null ? Math.max(0, sizeBytes - vramBytes) : null,
            gpuFraction,
            processor: gpuFraction === null ? "unknown" : gpuFraction === 0 ? "cpu" : gpuFraction === 1 ? "gpu" : "mixed",
            contextTokens: nonnegative(model.context_length),
            expiresAt: typeof model.expires_at === "string" ? model.expires_at : null
          };
        });
      return {
        models,
        selectedModel: models.find(model => model.name === settings.model) || null,
        isLoaded: models.some(model => model.name === settings.model)
      };
    }

    async function saveResult(itemID, result, context, rawSettings, mode, options = {}) {
      const settings = core.normalizeSettings(rawSettings);
      const clean = core.parseGeneration(JSON.stringify({ tags: result.tags, note: result.note, overview: result.overview }), mode, settings);
      let noteID = null;
      let overviewNoteID = null;
      let styleRemarkUpdated = false;
      const addedTags = [];
      await Zotero.DB.executeTransaction(async () => {
        const item = await Zotero.Items.getAsync(itemID);
        if (!item || item.deleted || !item.isRegularItem()) throw new Error("原文献已删除或不再可用，未写入结果。");
        const library = Zotero.Libraries.get(item.libraryID);
        if (!library || !library.editable || (item.isEditable && !item.isEditable())) {
          throw new Error("该文献库为只读，无法添加标签或简记。");
        }
        if (item.loadAllData) await item.loadAllData();
        const hasTags = core.modeIncludes(mode, "tags");
        const hasNote = core.modeIncludes(mode, "note");
        const hasOverview = core.modeIncludes(mode, "overview");
        let newExtra = null;
        if (hasNote && settings.briefTarget === "style-and-note") {
          const extra = String(item.getField("extra") || "");
          const currentRemark = readStyleRemark(extra);
          if (!context || context.styleRemark === undefined || context.styleRemarkAmbiguous) {
            throw new Error("缺少有效的 Style 简记预览，请重新生成或刷新文献后再保存。");
          }
          if (currentRemark !== context.styleRemark) {
            throw new Error("Style 简记在生成后已被修改，未覆盖。请重新生成并检查最新简记。");
          }
          const newRemark = clean.note.replace(/\s+/g, " ").trim();
          if (currentRemark !== newRemark) {
            if (currentRemark && options.allowStyleOverwrite !== true) {
              throw new Error("Style 已有简记。请先检查原内容，并勾选允许更新已有简记后保存。");
            }
            newExtra = updateStyleRemark(extra, newRemark);
          }
        }
        const metadata = {
          model: result.model || settings.model,
          sourceInfo: result.sourceInfo,
          createdAt: new Date().toISOString()
        };
        // Render before changing the parent item. Network work never enters
        // the transaction, and invalid output cannot leave partial mutations.
        const noteHTML = hasNote ? core.renderNote(clean, context, settings, metadata) : null;
        const overviewHTML = hasOverview ? core.renderOverviewNote(clean, context, settings, metadata) : null;
        if (hasTags) {
          const existing = new Set(item.getTags().map(tag => tag.tag.normalize("NFKC").trim().toLocaleLowerCase()));
          for (const tag of clean.tags) {
            const key = tag.normalize("NFKC").trim().toLocaleLowerCase();
            if (existing.has(key)) continue;
            item.addTag(tag, 0);
            existing.add(key);
            addedTags.push(tag);
          }
        }
        if (newExtra !== null) {
          item.setField("extra", newExtra);
          styleRemarkUpdated = true;
        }
        if (addedTags.length || styleRemarkUpdated) await item.save();
        if (hasNote) {
          const note = new Zotero.Item("note");
          note.libraryID = item.libraryID;
          note.parentID = item.id;
          note.setNote(noteHTML);
          noteID = await note.save();
        }
        if (hasOverview) {
          const overview = new Zotero.Item("note");
          overview.libraryID = item.libraryID;
          overview.parentID = item.id;
          overview.setNote(overviewHTML);
          overviewNoteID = await overview.save();
        }
      });
      return { addedTags, noteID, overviewNoteID, styleRemarkUpdated };
    }

    return { loadSettings, saveSettings, getSelectedItems, getItem, collectContext, transport, getRuntimeInfo, saveResult, readStyleRemark, updateStyleRemark };
  }

  return { create, PREF, readStyleRemark, updateStyleRemark };
});
