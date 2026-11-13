/* SPDX-License-Identifier: MIT
 * Official Sign in with ChatGPT plan usage for an open-source local client.
 * Protocol: https://developers.openai.com/siwc/token-sharing-open-source
 * Credentials stay in Firefox's login manager, never preferences or UI objects.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OllamaChatGPT = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const AUTH = "https://auth.openai.com";
  const RESOURCE = "https://api.openai.com/v1";
  const AUTHORIZE = AUTH + "/api/accounts/authorize";
  const TOKEN = AUTH + "/api/accounts/oauth/token";
  const DISCOVERY = AUTH + "/.well-known/openid-configuration";
  const JWKS = AUTH + "/.well-known/jwks.json";
  const REVOKE = AUTH + "/api/accounts/oauth/revoke";
  const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
  const LOGIN_ORIGIN = "chrome://ollama-local-ai";
  const LOGIN_REALM = "ChatGPT subscription authorization";
  const HOST_PREF = "extensions.ollama-local-ai.chatgpt.hostID";
  const ACTIVE_PREF = "extensions.ollama-local-ai.chatgpt.activeClient";
  const ALLOWED = new Set([TOKEN, DISCOVERY, JWKS, REVOKE, RESOURCE + "/models", RESOURCE + "/responses"]);

  function abortError() { const error = new Error("ChatGPT 请求已取消。"); error.name = "AbortError"; return error; }
  function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
  function errorCode(response) {
    try { const value = JSON.parse(response.text || "{}"); return String(value.error?.code || value.error || value.code || "").slice(0, 120); }
    catch (_) { return ""; }
  }
  function apiError(code, status) {
    code = typeof code === "string" && /^[a-z0-9_.:-]{1,120}$/i.test(code) ? code : "chatgpt_request_failed";
    const error = new Error(
      /invalid_grant|invalid_refresh_token|token_expired|refresh_token_expired|refresh_token_invalidated|refresh_token_reused/.test(code)
        ? "ChatGPT 授权已到期或撤销，请重新登录。"
        : /subscription_sharing_usage_limit_exceeded|rate_limit_exceeded|usage_limit/.test(code) || status === 429
        ? "ChatGPT 订阅额度或请求频率达到限制。请稍后重试，并在 ChatGPT 设置的 Usage 中检查额度。"
        : /subscription_sharing_usage_unavailable|insufficient_permissions|access_denied/.test(code) || status === 403
          ? "当前 ChatGPT 账户未允许此应用使用订阅额度，或所选模型不可用。请检查官方授权和应用额度设置。"
          : status === 401 ? "ChatGPT 登录已失效，请重新登录。"
            : "ChatGPT 官方服务请求失败" + (status ? `（HTTP ${status}）` : "") + "，请稍后重试。"
    );
    error.code = code || "chatgpt_request_failed";
    error.status = status || 0;
    return error;
  }
  function base64url(bytes) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let output = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const value = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      output += alphabet[(value >>> 18) & 63] + alphabet[(value >>> 12) & 63];
      if (i + 1 < bytes.length) output += alphabet[(value >>> 6) & 63];
      if (i + 2 < bytes.length) output += alphabet[value & 63];
    }
    return output;
  }
  function unbase64url(text) {
    if (typeof text !== "string" || !/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) throw new Error("ChatGPT 返回了无效的身份令牌。");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const output = [];
    let bits = 0, value = 0;
    for (const letter of text) {
      value = (value << 6) | alphabet.indexOf(letter); bits += 6;
      if (bits >= 8) { bits -= 8; output.push((value >>> bits) & 255); }
    }
    return new Uint8Array(output);
  }
  function bytesText(bytes) { return decodeURIComponent(Array.from(bytes, value => "%" + value.toString(16).padStart(2, "0")).join("")); }
  function jsonPart(part) {
    try { return JSON.parse(bytesText(unbase64url(part))); }
    catch (_) { throw new Error("ChatGPT 返回了无效的身份令牌。"); }
  }
  function utf8(text) {
    const bytes = [];
    for (const character of String(text)) {
      const n = character.codePointAt(0);
      if (n < 128) bytes.push(n);
      else if (n < 2048) bytes.push(192 | (n >> 6), 128 | (n & 63));
      else if (n < 65536) bytes.push(224 | (n >> 12), 128 | ((n >> 6) & 63), 128 | (n & 63));
      else bytes.push(240 | (n >> 18), 128 | ((n >> 12) & 63), 128 | ((n >> 6) & 63), 128 | (n & 63));
    }
    return new Uint8Array(bytes);
  }
  function form(fields) { return Object.entries(fields).map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(value)).join("&"); }
  function clone(record) { return JSON.parse(JSON.stringify(record)); }

  function createSSEParser(onEvent) {
    let buffer = "";
    function frame(text) {
      const lines = text.replace(/\r\n/g, "\n").split("\n");
      const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
      if (!data || data === "[DONE]") return;
      let event;
      try { event = JSON.parse(data); }
      catch (_) { throw new Error("ChatGPT 返回的流式数据格式无效。"); }
      onEvent(event);
    }
    return {
      push(chunk) {
        buffer += chunk;
        if (buffer.length > 4 * 1024 * 1024) throw new Error("ChatGPT 单个流式事件过大。");
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const text = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          frame(text);
        }
      },
      finish() { if (buffer.trim()) frame(buffer); buffer = ""; }
    };
  }

  function nativeStore(Services, Cc, Ci) {
    function logins() { return Services.logins.findLogins(LOGIN_ORIGIN, null, LOGIN_REALM); }
    function info(record) {
      const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
      login.init(LOGIN_ORIGIN, null, LOGIN_REALM, record.client_id, JSON.stringify(record), "", "");
      return login;
    }
    return {
      async list() {
        const records = [];
        for (const login of logins()) {
          try {
            const record = JSON.parse(login.password);
            if (record && record.client_id === login.username && record.issuer === AUTH && typeof record.subject === "string") records.push(record);
          } catch (_) { /* An unrelated invalid entry cannot become authenticated. */ }
        }
        return records;
      },
      async put(record) {
        const existing = logins().find(login => login.username === record.client_id);
        if (existing) Services.logins.modifyLogin(existing, info(record));
        else await Services.logins.addLoginAsync(info(record));
      }
    };
  }

  function create(deps) {
    const { Zotero, Services, ChromeUtils } = deps;
    const components = deps.Components || (typeof Components !== "undefined" ? Components : null);
    const Cc = deps.Cc || components?.classes;
    const Ci = deps.Ci || components?.interfaces;
    const crypto = deps.crypto || Zotero?.getMainWindow?.()?.crypto || (typeof globalThis.crypto !== "undefined" ? globalThis.crypto : null);
    const clock = deps.now || (() => Date.now());
    const timer = deps.setTimeout || Zotero?.getMainWindow?.()?.setTimeout.bind(Zotero.getMainWindow()) || (typeof setTimeout !== "undefined" ? setTimeout : null);
    const clearTimer = deps.clearTimeout || Zotero?.getMainWindow?.()?.clearTimeout.bind(Zotero.getMainWindow()) || (typeof clearTimeout !== "undefined" ? clearTimeout : null);
    const store = deps.store || nativeStore(Services, Cc, Ci);
    const preferences = deps.preferences || {
      get: key => Zotero.Prefs.get(key, true),
      set: (key, value) => Zotero.Prefs.set(key, value, true)
    };
    let pendingLogin = null;
    let disposed = false;
    let discoveryCache = null;
    let jwksCache = null;
    const refreshes = new Map();
    const signingOut = new Set();
    const blockedAccounts = new Set();
    const sessionEpochs = new Map();
    const requests = new Set();
    function epoch(accountID) { return sessionEpochs.get(accountID) || 0; }
    function invalidate(accountID) { if (accountID) sessionEpochs.set(accountID, epoch(accountID) + 1); }
    function requireSession(record, expectedEpoch) {
      if (disposed || signingOut.has(record.client_id) || blockedAccounts.has(record.client_id) || epoch(record.client_id) !== expectedEpoch) throw abortError();
    }
    function requireCrypto() { if (!crypto?.subtle || !crypto.getRandomValues) throw new Error("当前 Zotero 环境不支持安全的 ChatGPT 登录。请升级 Zotero 后重试。"); }
    function random(length = 32) { requireCrypto(); return base64url(crypto.getRandomValues(new Uint8Array(length))); }
    function getHostID() {
      let value = preferences.get(HOST_PREF);
      if (!/^urn:uuid:[0-9a-f-]{36}$/i.test(value || "")) {
        requireCrypto();
        const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
        const h = Array.from(b, n => n.toString(16).padStart(2, "0")).join("");
        value = "urn:uuid:" + [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join("-");
        preferences.set(HOST_PREF, value);
      }
      return value;
    }
    function assertOfficial(url) { if (!ALLOWED.has(url)) throw new Error("已拒绝非官方 ChatGPT 授权或模型地址。"); }
    async function nativeRequest(request) {
      assertOfficial(request.url); checkAbort(request.signal);
      let cancel, consumed = 0, progressError = null;
      const abort = () => { if (cancel) cancel(); };
      requests.add(abort);
      request.signal?.addEventListener("abort", abort, { once: true });
      const read = xhr => {
        if (!request.onChunk || progressError || xhr.status !== 200) return;
        const text = xhr.responseText || "";
        if (text.length > 16 * 1024 * 1024) { progressError = new Error("ChatGPT 响应过大。"); abort(); return; }
        if (text.length > consumed) {
          const chunk = text.slice(consumed); consumed = text.length;
          try { request.onChunk(chunk); } catch (error) { progressError = error; abort(); }
        }
      };
      try {
        const xhr = await Zotero.HTTP.request(request.method || "GET", request.url, {
          body: request.body,
          headers: { Accept: request.onChunk ? "text/event-stream" : "application/json", ...(request.headers || {}) },
          responseType: "text", timeout: Math.max(1000, Math.min(Number(request.timeoutMs) || 30000, 1800000)),
          anon: true, followRedirects: false, noCache: true, debug: false, logBodyLength: 0, errorDelayMax: 0, successCodes: false,
          requestObserver(observerXHR) { if (request.onChunk) observerXHR.addEventListener("progress", () => read(observerXHR)); },
          cancellerReceiver(fn) { cancel = fn; if (request.signal?.aborted || disposed) cancel(); }
        });
        if (progressError) throw progressError;
        checkAbort(request.signal);
        read(xhr);
        if (progressError) throw progressError;
        return { status: xhr.status, text: String(xhr.responseText || "") };
      } catch (error) {
        if (progressError) throw progressError;
        if (request.signal?.aborted || disposed) throw abortError();
        throw new Error(/timeout/i.test(error.name || "") ? "ChatGPT 请求超时，请稍后重试。" : "无法连接 ChatGPT 官方服务，请检查网络后重试。");
      } finally {
        request.signal?.removeEventListener("abort", abort); requests.delete(abort);
      }
    }
    const request = deps.request || nativeRequest;
    async function send(options) {
      assertOfficial(options.url); checkAbort(options.signal);
      if (disposed) throw abortError();
      return request(options);
    }
    async function jsonRequest(url, options = {}) {
      const response = await send({ url, ...options });
      if (response.status < 200 || response.status >= 300) throw apiError(errorCode(response), response.status);
      try { return JSON.parse(response.text); }
      catch (_) { throw new Error("ChatGPT 官方服务返回了无效的 JSON。"); }
    }
    async function discovery(signal) {
      if (discoveryCache && discoveryCache.until > clock()) return discoveryCache.value;
      const value = await jsonRequest(DISCOVERY, { signal });
      if (value.issuer !== AUTH || value.jwks_uri !== JWKS || (value.revocation_endpoint && value.revocation_endpoint !== REVOKE)) throw new Error("ChatGPT 授权发现信息不符合官方安全配置。");
      discoveryCache = { value, until: clock() + 300000 }; return value;
    }
    async function validateIdToken(idToken, clientID, nonce, subject, signal, refreshing = false) {
      requireCrypto();
      if (typeof idToken !== "string" || idToken.length > 65536) throw new Error("ChatGPT 身份令牌无效。");
      const parts = idToken.split(".");
      if (parts.length !== 3) throw new Error("ChatGPT 身份令牌无效。");
      const header = jsonPart(parts[0]); const claims = jsonPart(parts[1]);
      if (header.alg !== "RS256" || typeof header.kid !== "string" || header.crit) throw new Error("ChatGPT 身份令牌的签名算法不受支持。");
      await discovery(signal);
      if (!jwksCache || jwksCache.until <= clock() || !jwksCache.value.keys?.some(key => key.kid === header.kid)) {
        jwksCache = { value: await jsonRequest(JWKS, { signal }), until: clock() + 300000 };
      }
      const jwk = jwksCache.value.keys?.find(key => key.kid === header.kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig"));
      if (!jwk) throw new Error("ChatGPT 身份令牌没有匹配的官方签名密钥。");
      let verified = false;
      try {
        const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
        verified = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unbase64url(parts[2]), utf8(parts[0] + "." + parts[1]));
      } catch (_) { /* A malformed signature is never accepted. */ }
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!verified || claims.iss !== AUTH || !audience.includes(clientID)
        || (audience.length > 1 && claims.azp !== clientID)
        || typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp * 1000 <= clock()
        || (claims.azp !== undefined && claims.azp !== clientID)
        || (claims.iat !== undefined && (!Number.isFinite(claims.iat) || claims.iat * 1000 > clock() + 60000))
        || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf * 1000 > clock() + 60000))
        || typeof claims.sub !== "string" || !claims.sub
        || (!refreshing && claims.nonce !== nonce)
        || (refreshing && claims.nonce !== undefined && claims.nonce !== nonce)
        || (subject && claims.sub !== subject)) throw new Error("ChatGPT 身份校验失败，未保存登录凭据。请重新登录。");
      return claims;
    }
    async function allRecords() { return store.list(); }
    async function selected(accountID) {
      const id = accountID || preferences.get(ACTIVE_PREF);
      return (await allRecords()).find(record => record.client_id === id) || null;
    }
    function publicAccount(record, index) {
      return { id: record.client_id, label: (record.email || "ChatGPT 账户") + " · " + (index + 1), connected: Boolean(record.access_token && record.scopes?.includes("chatgpt.tokens.use.direct") && !signingOut.has(record.client_id) && !blockedAccounts.has(record.client_id)) };
    }
    async function accounts() { return (await allRecords()).map(publicAccount); }
    async function status() {
      const record = await selected(); const list = await accounts();
      return { connected: Boolean(record?.access_token && record?.scopes?.includes("chatgpt.tokens.use.direct") && !signingOut.has(record.client_id) && !blockedAccounts.has(record.client_id)), accountId: record?.client_id || "", accountLabel: list.find(account => account.id === record?.client_id)?.label || "", expiresAt: record?.expires_at || 0, accounts: list };
    }
    async function selectAccount(accountID) {
      if (!(await selected(accountID))) throw new Error("未找到此 ChatGPT 账户，请重新登录。");
      if (signingOut.has(accountID)) throw new Error("该 ChatGPT 账户正在退出，请稍后重试。");
      const prior = preferences.get(ACTIVE_PREF);
      if (prior && prior !== accountID) { invalidate(prior); for (const cancel of requests) cancel(); }
      preferences.set(ACTIVE_PREF, accountID); return status();
    }
    async function clearRejectedCredentials(record, error, expectedEpoch) {
      if (error?.status !== 401) return;
      const current = await selected(record.client_id);
      if (epoch(record.client_id) === expectedEpoch && current?.access_token === record.access_token) { blockedAccounts.add(record.client_id); await store.put(withoutTokens(current)); }
    }

    function nativeCallback({ state, signal, timeoutMs = 180000 }) {
      const server = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
      server.init(-1, true, 4);
      const redirectUri = "http://127.0.0.1:" + server.port + "/auth/callback";
      const connections = new Set();
      let settled = false, settle, reject, timeout;
      const result = new Promise((resolve, failure) => { settle = resolve; reject = failure; });
      function close(error) {
        if (settled) return;
        settled = true; clearTimer(timeout); signal?.removeEventListener("abort", abort);
        try { server.close(); } catch (_) {}
        for (const connection of connections) { try { connection.close(0); } catch (_) {} }
        connections.clear();
        if (error) reject(error);
      }
      const abort = () => close(abortError());
      function reply(output, code, text) {
        const body = "<!doctype html><meta charset=utf-8><title>Ollama Local AI</title><p>" + text + "</p>";
        const message = `HTTP/1.1 ${code}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${body.length}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'\r\nConnection: close\r\n\r\n${body}`;
        output.write(message, message.length); output.close();
      }
      server.asyncListen({
        QueryInterface: ChromeUtils.generateQI(["nsIServerSocketListener"]),
        onSocketAccepted(_server, connection) {
          if (settled) { connection.close(0); return; }
          connections.add(connection);
          const input = connection.openInputStream(0, 0, 0), output = connection.openOutputStream(0, 0, 0);
          let received = "", handled = false;
          const pump = Cc["@mozilla.org/network/input-stream-pump;1"].createInstance(Ci.nsIInputStreamPump);
          pump.init(input, 0, 0, true);
          pump.asyncRead({
            QueryInterface: ChromeUtils.generateQI(["nsIStreamListener", "nsIRequestObserver"]),
            onStartRequest() {},
            onDataAvailable(_request, stream, _offset, count) {
              if (handled || settled) return;
              const reader = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
              reader.init(stream); received += reader.read(count);
              if (received.length > 16384) { handled = true; reply(output, "413 Payload Too Large", "Invalid callback."); connection.close(0); return; }
              if (!received.includes("\r\n\r\n")) return;
              handled = true;
              try {
                const first = /^GET ([^ ]+) HTTP\/1\.[01]\r\n/.exec(received);
                if (!first) throw new Error("Invalid request");
                const url = new URL(first[1], redirectUri);
                const host = /^Host:\s*([^\r\n]+)/im.exec(received)?.[1].trim();
                if (url.origin !== new URL(redirectUri).origin || url.pathname !== "/auth/callback" || host !== "127.0.0.1:" + server.port || url.searchParams.get("state") !== state) throw new Error("Invalid callback");
                reply(output, "200 OK", "Authorization received. Return to Zotero to finish signing in.");
                settle(url.href); close();
              } catch (_) { reply(output, "400 Bad Request", "Invalid authorization callback. Return to Zotero and try again."); }
              finally { try { input.close(); } catch (_) {} connections.delete(connection); }
            },
            onStopRequest() { connections.delete(connection); }
          });
        },
        onStopListening() {}
      });
      timeout = timer(() => close(new Error("ChatGPT 登录等待超时，请重新点击登录。")), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      return { redirectUri, result, close: () => close(abortError()) };
    }
    const openCallback = deps.openCallback || nativeCallback;

    async function login(options = {}) {
      checkAbort(options.signal); requireCrypto();
      if (disposed) throw abortError();
      if (pendingLogin) throw new Error("已有 ChatGPT 登录正在进行，请先完成或取消。");
      const attempt = { cancelled: false, callback: null, close() { this.cancelled = true; this.callback?.close(); } };
      pendingLogin = attempt;
      try {
        const record = options.newAccount ? null : await selected(options.accountId);
        if (record && signingOut.has(record.client_id)) throw new Error("该 ChatGPT 账户正在退出，请稍后重新登录。");
        const state = random(), nonce = random(), verifier = random(48), hostID = getHostID();
        const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(verifier))));
        const callback = await openCallback({ state, signal: options.signal, timeoutMs: options.timeoutMs || 180000 });
        attempt.callback = callback;
        callback.result.catch(() => {});
        checkAbort(options.signal);
        if (attempt.cancelled || disposed) throw abortError();
        if (!/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/.test(callback.redirectUri)) throw new Error("ChatGPT 登录回调地址无效。");
        const url = new URL(AUTHORIZE);
        const params = { client_id: record?.client_id || "dynamic_agent_client", ext_agent_host_id: hostID, response_type: "code", redirect_uri: callback.redirectUri, scope: SCOPES, resource: RESOURCE, state, nonce, code_challenge_method: "S256", code_challenge: challenge };
        if (!record) params.agent_name_hint = "Ollama Local AI for Zotero";
        if (record?.id_token) params.id_token_hint = record.id_token;
        if (record?.email) params.login_hint = record.email;
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        options.onStatus?.("请在官方浏览器页面登录并授权，完成后返回 Zotero。");
        // Never log this URL: returning sign-in can contain an ID-token hint.
        await (deps.launchURL || (value => Zotero.launchURL(value)))(url.href);
        const returned = new URL(await callback.result);
        checkAbort(options.signal);
        if (returned.origin !== new URL(callback.redirectUri).origin || returned.pathname !== "/auth/callback" || returned.searchParams.get("state") !== state) throw new Error("ChatGPT 登录状态校验失败，请重新登录。");
        if (returned.searchParams.has("error")) throw apiError(returned.searchParams.get("error"), 403);
        const issued = returned.searchParams.get("client_id") || record?.client_id;
        const code = returned.searchParams.get("code");
        if (!issued || issued === "dynamic_agent_client" || !code || (record && issued !== record.client_id)) throw new Error("ChatGPT 客户端注册未完成或不匹配，请重新登录。");
        const tokens = await jsonRequest(TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form({ grant_type: "authorization_code", client_id: issued, code, code_verifier: verifier, redirect_uri: callback.redirectUri, resource: RESOURCE }), signal: options.signal });
        const claims = await validateIdToken(tokens.id_token, issued, nonce, record?.subject, options.signal);
        const scopes = String(tokens.scope || "").split(/\s+/).filter(Boolean);
        if (!scopes.includes("chatgpt.tokens.use.direct") || !scopes.includes("resource.invoke")) throw new Error("已登录 ChatGPT，但未授权此应用使用订阅额度。请在官方授权页面允许后重试。");
        if (tokens.token_type?.toLowerCase() !== "bearer" || !tokens.access_token || !tokens.refresh_token || !Number.isFinite(Number(tokens.expires_in)) || Number(tokens.expires_in) <= 0) throw new Error("ChatGPT 未返回完整的订阅授权凭据，请重新登录。");
        const saved = { client_id: issued, issuer: AUTH, subject: claims.sub, email: typeof claims.email === "string" ? claims.email : "", ext_agent_host_id: hostID, nonce, access_token: tokens.access_token, refresh_token: tokens.refresh_token, id_token: tokens.id_token, scopes, expires_at: clock() + Number(tokens.expires_in) * 1000 };
        checkAbort(options.signal);
        if (attempt.cancelled || disposed) throw abortError();
        if (signingOut.has(issued)) throw new Error("该 ChatGPT 账户正在退出，请稍后重新登录。");
        const previousAccount = preferences.get(ACTIVE_PREF);
        if (previousAccount && previousAccount !== issued) invalidate(previousAccount);
        invalidate(issued);
        const commitEpoch = epoch(issued);
        blockedAccounts.add(issued);
        await store.put(saved);
        if (attempt.cancelled || disposed || options.signal?.aborted || signingOut.has(issued) || epoch(issued) !== commitEpoch) {
          const current = await selected(issued);
          if (current?.id_token === saved.id_token && current.nonce === saved.nonce) await store.put(withoutTokens(current));
          throw abortError();
        }
        blockedAccounts.delete(issued);
        preferences.set(ACTIVE_PREF, issued);
        return status();
      } finally { attempt.callback?.close(); if (pendingLogin === attempt) pendingLogin = null; }
    }

    function withoutTokens(record) {
      const saved = { ...record }; for (const key of ["access_token", "refresh_token", "id_token", "expires_at", "nonce"]) delete saved[key];
      return saved;
    }
    async function logout(options = {}) {
      const cancelledPendingLogin = Boolean(pendingLogin);
      pendingLogin?.close(); pendingLogin = null;
      const accountID = options.accountId || preferences.get(ACTIVE_PREF);
      if (accountID && signingOut.has(accountID)) throw new Error("该 ChatGPT 账户正在退出，请等待完成。");
      if (accountID) { signingOut.add(accountID); blockedAccounts.add(accountID); invalidate(accountID); }
      const refreshWasPending = Boolean(accountID && refreshes.has(accountID));
      for (const cancel of requests) cancel();
      try {
        const record = await selected(accountID);
        let remoteRevocationConfirmed = !record?.refresh_token && !cancelledPendingLogin;
        try {
          if (record?.refresh_token) {
            await discovery(options.signal);
            const response = await send({ url: REVOKE, method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form({ token: record.refresh_token, token_type_hint: "refresh_token", client_id: record.client_id }), timeoutMs: 15000, signal: options.signal });
            remoteRevocationConfirmed = response.status === 200 && !refreshWasPending && !cancelledPendingLogin;
          }
        } catch (_) { /* Always clear local tokens; the UI reports remote uncertainty. */ }
        if (record) await store.put(withoutTokens(record));
        return { ...(await status()), remoteRevocationConfirmed, message: remoteRevocationConfirmed ? "已退出 ChatGPT 登录。" : "已清除本地登录，远端撤销未确认；可在 ChatGPT 设置中断开此应用。" };
      } finally { if (accountID) signingOut.delete(accountID); }
    }
    async function accessRecord(signal) {
      checkAbort(signal);
      const record = await selected();
      if (!record?.access_token || !record.scopes?.includes("chatgpt.tokens.use.direct")) throw new Error("请先使用 Continue with ChatGPT 登录并授权订阅额度。");
      const expectedEpoch = epoch(record.client_id);
      requireSession(record, expectedEpoch);
      if (record.expires_at > clock() + 60000) return record;
      if (!record.refresh_token) throw new Error("ChatGPT 登录已到期，请重新登录。");
      if (!refreshes.has(record.client_id)) {
        const refreshing = (async () => {
          const response = await send({ url: TOKEN, method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form({ grant_type: "refresh_token", client_id: record.client_id, refresh_token: record.refresh_token, resource: RESOURCE }), signal });
          if (response.status < 200 || response.status >= 300) {
            const code = errorCode(response);
            if (/invalid_grant|invalid_refresh_token|token_expired|refresh_token_expired|refresh_token_invalidated|refresh_token_reused/.test(code)) {
              const current = await selected(record.client_id);
              if (epoch(record.client_id) === expectedEpoch && current?.refresh_token === record.refresh_token) { blockedAccounts.add(record.client_id); await store.put(withoutTokens(current)); }
            }
            throw apiError(code, response.status);
          }
          let tokens; try { tokens = JSON.parse(response.text); } catch (_) { throw new Error("ChatGPT 刷新响应无效，请稍后重试。"); }
          const scopes = tokens.scope === undefined ? record.scopes : String(tokens.scope).split(/\s+/).filter(Boolean);
          if (!tokens.access_token || !tokens.refresh_token || !scopes.includes("chatgpt.tokens.use.direct") || !scopes.includes("resource.invoke") || tokens.token_type?.toLowerCase() !== "bearer" || !Number.isFinite(Number(tokens.expires_in)) || !(Number(tokens.expires_in) > 0)) throw new Error("ChatGPT 刷新未返回完整订阅权限，请重新登录。");
          let email = record.email;
          if (tokens.id_token) {
            const claims = await validateIdToken(tokens.id_token, record.client_id, record.nonce, record.subject, signal, true);
            email = typeof claims.email === "string" ? claims.email : email;
          }
          const current = await selected(record.client_id);
          requireSession(record, expectedEpoch);
          if (!current?.access_token || current.refresh_token !== record.refresh_token) throw abortError();
          const saved = { ...record, email, access_token: tokens.access_token, refresh_token: tokens.refresh_token, id_token: tokens.id_token || record.id_token, scopes, expires_at: clock() + Number(tokens.expires_in) * 1000 };
          await store.put(saved); return saved;
        })();
        refreshes.set(record.client_id, refreshing);
        refreshing.finally(() => refreshes.delete(record.client_id)).catch(() => {});
      }
      const refreshed = await refreshes.get(record.client_id); checkAbort(signal); requireSession(record, expectedEpoch); return refreshed;
    }
    async function listModels(options = {}) {
      const record = await accessRecord(options.signal);
      const expectedEpoch = epoch(record.client_id);
      let response;
      try { response = await jsonRequest(RESOURCE + "/models", { headers: { Authorization: "Bearer " + record.access_token }, signal: options.signal }); }
      catch (error) { await clearRejectedCredentials(record, error, expectedEpoch); throw error; }
      requireSession(record, expectedEpoch);
      if (!Array.isArray(response.models)) throw new Error("ChatGPT 未返回订阅模型目录，请重新检测账户权限。");
      return response.models.filter(model => model.visibility === "list" && typeof model.slug === "string" && model.slug).map(model => ({ id: model.slug, name: String(model.display_name || model.slug) }));
    }
    async function generate({ messages, model, signal, onDelta, timeoutMs = 180000 }) {
      checkAbort(signal);
      if (!model || typeof model !== "string") throw new Error("请先选择 ChatGPT 账户中可用的模型。");
      if (!Array.isArray(messages) || !messages.length) throw new Error("没有可用的文献生成请求。");
      const record = await accessRecord(signal);
      const expectedEpoch = epoch(record.client_id);
      const instructions = messages.filter(message => message.role === "system" || message.role === "developer").map(message => String(message.content)).join("\n");
      const input = messages.filter(message => message.role !== "system" && message.role !== "developer").map(message => ({ role: message.role === "assistant" ? "assistant" : "user", content: String(message.content) }));
      let text = "", completed = false, responseModel = model, streamedError = null, receivedChunks = false;
      const parser = createSSEParser(event => {
        if (event.type === "response.output_text.delta") {
          if (typeof event.delta !== "string") throw new Error("ChatGPT 流式文本格式无效。");
          text += event.delta; if (text.length > 200000) throw new Error("ChatGPT 生成结果过长。"); onDelta?.(event.delta);
        } else if (event.type === "response.completed") {
          if (event.response?.status && event.response.status !== "completed") throw new Error("ChatGPT 生成未完整结束，请重试。");
          completed = true; responseModel = event.response?.model || model;
          const finalText = event.response?.output?.filter(item => item.type === "message").flatMap(item => item.content || []).filter(item => item.type === "output_text").map(item => item.text || "").join("");
          if (finalText) text = finalText;
        } else if (event.type === "response.failed" || event.type === "error") {
          streamedError = apiError(event.response?.error?.code || event.error?.code || event.code || "response_failed", event.response?.error?.code?.includes("usage_limit") ? 429 : 0);
          throw streamedError;
        } else if (event.type === "response.incomplete") throw new Error("ChatGPT 生成不完整，请减少材料或重试。");
      });
      const response = await send({ url: RESOURCE + "/responses", method: "POST", headers: { Authorization: "Bearer " + record.access_token, "Content-Type": "application/json" }, body: JSON.stringify({ model, instructions, input, store: false, stream: true }), signal, timeoutMs, onChunk: chunk => { receivedChunks = true; parser.push(chunk); } });
      if (response.status < 200 || response.status >= 300) {
        const error = apiError(errorCode(response), response.status);
        await clearRejectedCredentials(record, error, expectedEpoch); throw error;
      }
      // Injected transports follow the same chunk contract. A response with no
      // progress notification can still be consumed after native completion.
      if (!receivedChunks && response.text) parser.push(response.text);
      parser.finish(); checkAbort(signal);
      requireSession(record, expectedEpoch);
      if (streamedError) throw streamedError;
      if (!completed || !text.trim()) throw new Error("ChatGPT 流在完成事件前结束，未采用不完整结果。请重试。");
      return { text, model: responseModel };
    }
    function dispose() { disposed = true; pendingLogin?.close(); pendingLogin = null; for (const cancel of requests) cancel(); }

    return { status, accounts, selectAccount, login, logout, listModels, generate, dispose };
  }

  return Object.freeze({ create, createSSEParser, base64url, unbase64url, constants: Object.freeze({ AUTH, RESOURCE, AUTHORIZE, TOKEN, DISCOVERY, JWKS, REVOKE, SCOPES, HOST_PREF, ACTIVE_PREF }) });
});
