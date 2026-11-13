/* SPDX-License-Identifier: MIT */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OllamaGenerationEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function cancelled(signal) {
    if (!signal?.aborted) return;
    const error = new Error("生成已取消。"); error.name = "AbortError"; throw error;
  }

  function create({ core, adapter, chatgpt, now = () => Date.now() }) {
    const cloudCache = core.createGenerationCache();

    async function listModels(rawSettings, signal) {
      const settings = core.normalizeSettings(rawSettings);
      if (settings.provider === "chatgpt") {
        const status = await chatgpt.status();
        if (!status.connected) throw new Error("请先在模型设置中使用 Continue with ChatGPT 登录并授权订阅额度。");
        const models = await chatgpt.listModels({ signal });
        return models.map(model => ({ name: model.id, label: model.name || model.id }));
      }
      return (await core.listModels(adapter.transport, settings, signal)).map(model => ({ ...model, label: model.name }));
    }

    async function generate(context, mode, rawSettings, signal, options = {}) {
      cancelled(signal);
      const settings = core.effectiveSettings(rawSettings, mode);
      if (settings.provider !== "chatgpt") return core.generate(adapter.transport, context, mode, settings, signal, options);
      const started = now();
      const account = await chatgpt.status();
      cancelled(signal);
      if (!account.connected || !account.accountId) throw new Error("请先使用 Continue with ChatGPT 登录并授权订阅额度。");
      if (!settings.chatgptModel) throw new Error("请先检测 ChatGPT 账户并选择可用模型。");
      const key = "chatgpt:" + account.accountId + ":" + core.generationCacheKey(context, mode, settings);
      if (settings.cacheEnabled && !options.forceRefresh) {
        const cached = cloudCache.get(key);
        if (cached) {
          cancelled(signal);
          options.onProgress?.({ stage: "cache-hit", text: "" });
          return { ...cached, cacheHit: true, stats: { ...cached.stats, elapsedMs: now() - started } };
        }
      }
      const messages = core.buildMessages(context, mode, settings);
      const sourceInfo = JSON.parse(messages[1].content).evidence;
      let streamed = "";
      options.onProgress?.({ stage: "generating", text: "" });
      const response = await chatgpt.generate({
        messages, model: settings.chatgptModel, signal, timeoutMs: settings.timeoutSeconds * 1000,
        onDelta(delta) {
          cancelled(signal);
          streamed += delta;
          options.onProgress?.({ stage: "streaming", delta, text: streamed });
        }
      });
      cancelled(signal);
      // Signing out or switching accounts during a turn never publishes that
      // turn as if it belonged to the newly selected account.
      const current = await chatgpt.status();
      cancelled(signal);
      if (!current.connected || current.accountId !== account.accountId) throw new Error("ChatGPT 账户在生成期间发生变化，请重新生成。");
      const parsed = core.parseGeneration(response.text, mode, settings);
      const result = {
        ...parsed, provider: "chatgpt", model: response.model || settings.chatgptModel,
        sourceInfo: { ...sourceInfo, requestedContextTokens: settings.contextTokens },
        cacheHit: false, stats: { elapsedMs: now() - started }
      };
      if (settings.cacheEnabled) cloudCache.set(key, result);
      options.onProgress?.({ stage: "complete", text: response.text });
      return result;
    }

    function clearCache() { cloudCache.clear(); core.clearCache(); }
    async function login(options) { clearCache(); return chatgpt.login(options); }
    async function logout() { clearCache(); return chatgpt.logout(); }
    async function selectAccount(id) { clearCache(); await chatgpt.selectAccount(id); return chatgpt.status(); }
    function dispose() { clearCache(); chatgpt.dispose(); }
    return { listModels, generate, clearCache, login, logout, selectAccount, status: () => chatgpt.status(), dispose };
  }

  return Object.freeze({ create });
});
