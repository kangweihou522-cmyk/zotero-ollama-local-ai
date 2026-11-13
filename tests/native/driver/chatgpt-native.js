/* SPDX-License-Identifier: MIT
 * Synthetic OAuth transport + real Gecko callback and credential storage.
 * This helper is copied only into the disposable native-test driver addon.
 * It never sends fixture credentials or authentication requests to OpenAI.
 */
var runChatGPTNativeSmoke = async function ({ Zotero, Services, ChromeUtils, Components, crypto, URL, URLSearchParams, TextEncoder, setTimeout, clearTimeout }) {
  const scope = { Zotero, Services, ChromeUtils, Components, crypto, URL, URLSearchParams, TextEncoder, setTimeout, clearTimeout };
  scope.globalThis = scope;
  Services.scriptloader.loadSubScript("chrome://ollama-local-ai/content/chatgpt.js", scope, "UTF-8");
  const provider = scope.OllamaChatGPT;
  if (!provider?.create) throw new Error("Installed ChatGPT provider did not load for native validation");
  const C = provider.constants;
  const CLIENT = "oaiapp_native_smoke_synthetic";
  const LOGIN_ORIGIN = "chrome://ollama-local-ai";
  const LOGIN_REALM = "ChatGPT subscription authorization";
  const encoder = new TextEncoder();
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const previous = new Map([C.HOST_PREF, C.ACTIVE_PREF].map(key => [key,
    Services.prefs.prefHasUserValue(key) ? Services.prefs.getStringPref(key) : null]));
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const publicKey = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "native-smoke-synthetic-key", alg: "RS256", use: "sig" };
  let authorizationURL = null, now = Date.now(), exchangeCount = 0, refreshCount = 0, modelCount = 0, generationCount = 0, revocationCount = 0, callbackCount = 0;
  const instances = [];
  const answer = JSON.stringify({ tags: ["synthetic plan test"], note: "Synthetic native subscription test." });
  const json = value => ({ status: 200, text: JSON.stringify(value) });
  const encode = value => provider.base64url(encoder.encode(JSON.stringify(value)));
  async function signedIDToken(clientID) {
    const header = encode({ alg: "RS256", kid: publicKey.kid });
    const payload = encode({ iss: C.AUTH, aud: clientID, sub: "native-smoke-synthetic-subject", email: "native-smoke@example.test", nonce: authorizationURL.searchParams.get("nonce"), iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600 });
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, encoder.encode(header + "." + payload));
    return header + "." + payload + "." + provider.base64url(new Uint8Array(signature));
  }
  async function request(options) {
    // These branches are an in-process protocol fixture. All unspecified URLs
    // fail locally; only launchURL below makes a real HTTP loopback request.
    if (options.url === C.DISCOVERY) return json({ issuer: C.AUTH, jwks_uri: C.JWKS, revocation_endpoint: C.REVOKE });
    if (options.url === C.JWKS) return json({ keys: [publicKey] });
    if (options.url === C.TOKEN) {
      const fields = new URLSearchParams(options.body);
      check(fields.get("client_id") === CLIENT, "Native OAuth fixture received an unexpected client ID");
      check(fields.get("resource") === C.RESOURCE && !fields.has("client_secret"), "Native OAuth exchange did not follow the public-client contract");
      if (fields.get("grant_type") === "authorization_code") {
        exchangeCount++;
        check(fields.get("code") === "native-smoke-synthetic-code", "Native callback code was not preserved");
        check(fields.get("redirect_uri") === authorizationURL.searchParams.get("redirect_uri"), "Native OAuth changed its exact callback URI");
        const digest = await crypto.subtle.digest("SHA-256", encoder.encode(fields.get("code_verifier")));
        check(provider.base64url(new Uint8Array(digest)) === authorizationURL.searchParams.get("code_challenge"), "Native OAuth PKCE verification failed");
        return json({ access_token: "SYNTHETIC_NATIVE_ACCESS", refresh_token: "SYNTHETIC_NATIVE_REFRESH", id_token: await signedIDToken(CLIENT), scope: C.SCOPES, token_type: "Bearer", expires_in: 3600 });
      }
      if (fields.get("grant_type") === "refresh_token") {
        refreshCount++;
        check(fields.get("refresh_token") === "SYNTHETIC_NATIVE_REFRESH", "Native credential manager did not retain the renewable session");
        return json({ access_token: "SYNTHETIC_NATIVE_ROTATED_ACCESS", refresh_token: "SYNTHETIC_NATIVE_ROTATED_REFRESH", token_type: "Bearer", expires_in: 3600 });
      }
      throw new Error("Unexpected native OAuth fixture grant");
    }
    if (options.url === C.RESOURCE + "/models") {
      modelCount++;
      check(options.headers.Authorization === "Bearer SYNTHETIC_NATIVE_ACCESS" || options.headers.Authorization === "Bearer SYNTHETIC_NATIVE_ROTATED_ACCESS", "Native model request omitted the selected fixture session");
      return json({ models: [{ slug: "native-plan-model", display_name: "Synthetic plan model", visibility: "list" }] });
    }
    if (options.url === C.RESOURCE + "/responses") {
      generationCount++;
      const body = JSON.parse(options.body);
      check(body.model === "native-plan-model" && body.store === false && body.stream === true, "Native plan generation sent unsupported request settings");
      const events = [
        { type: "response.output_text.delta", delta: answer.slice(0, 12) },
        { type: "response.output_text.delta", delta: answer.slice(12) },
        { type: "response.completed", response: { status: "completed", model: "native-plan-model", output: [{ type: "message", content: [{ type: "output_text", text: answer }] }] } }
      ];
      const text = events.map(event => "data: " + JSON.stringify(event) + "\r\n\r\n").join("");
      for (let i = 0; i < text.length; i += 17) options.onChunk?.(text.slice(i, i + 17));
      return { status: 200, text };
    }
    if (options.url === C.REVOKE) {
      revocationCount++;
      const fields = new URLSearchParams(options.body);
      check(fields.get("client_id") === CLIENT && fields.get("token_type_hint") === "refresh_token" && fields.get("token") === "SYNTHETIC_NATIVE_ROTATED_REFRESH", "Native sign-out did not revoke the newest fixture session");
      return { status: 200, text: "" };
    }
    throw new Error("Native OAuth fixture blocked an unexpected endpoint");
  }
  async function launchURL(value) {
    authorizationURL = new URL(value);
    check(authorizationURL.origin + authorizationURL.pathname === C.AUTHORIZE, "Native OAuth attempted to launch an unexpected sign-in page");
    const callback = new URL(authorizationURL.searchParams.get("redirect_uri"));
    check(callback.protocol === "http:" && callback.hostname === "127.0.0.1" && callback.pathname === "/auth/callback" && callback.port, "Native callback is not an ephemeral IPv4 loopback listener");
    callback.searchParams.set("state", authorizationURL.searchParams.get("state"));
    callback.searchParams.set("client_id", CLIENT);
    callback.searchParams.set("code", "native-smoke-synthetic-code");
    const response = await Zotero.HTTP.request("GET", callback.href, { responseType: "text", timeout: 10000, anon: true, followRedirects: false, noCache: true, logBodyLength: 0, debug: false, successCodes: false, errorDelayMax: 0 });
    check(response.status === 200, "Real native loopback OAuth callback did not respond successfully");
    callbackCount++;
  }
  function instance() {
    const api = provider.create({ Zotero, Services, ChromeUtils, Components, crypto, request, launchURL, now: () => now, setTimeout, clearTimeout });
    instances.push(api); return api;
  }
  try {
    const first = instance();
    check(!(await first.status()).connected, "Disposable profile unexpectedly has a connected ChatGPT account");
    const loggedIn = await first.login({ timeoutMs: 15000 });
    check(loggedIn.connected && loggedIn.accountId === CLIENT && callbackCount === 1 && exchangeCount === 1, "Native OAuth did not complete its synthetic callback and signed-token exchange");
    check(!JSON.stringify(loggedIn).includes("SYNTHETIC_NATIVE_"), "Native account status exposed fixture credentials");
    const hostID = Zotero.Prefs.get(C.HOST_PREF, true);
    check(/^urn:uuid:/.test(hostID), "Native OAuth did not persist its opaque host identifier");
    const second = instance();
    check((await second.status()).connected, "A fresh provider did not recover credentials from the actual LoginManager");
    let models = await second.listModels();
    check(models.length === 1 && models[0].id === "native-plan-model", "Native provider did not read the fixture account model catalog");
    let streamed = "";
    const generated = await second.generate({ messages: [{ role: "system", content: "Return JSON only." }, { role: "user", content: "Synthetic material only." }], model: models[0].id, onDelta: delta => { streamed += delta; } });
    check(generated.text === answer && streamed === answer && generationCount === 1, "Native subscription provider did not complete its synthetic SSE generation");
    now += 3600000;
    models = await second.listModels();
    check(models.length === 1 && refreshCount === 1 && modelCount === 2, "Native LoginManager refresh/rotation did not complete");
    const loggedOut = await second.logout();
    check(!loggedOut.connected && loggedOut.remoteRevocationConfirmed && revocationCount === 1, "Native subscription sign-out failed");
    const after = await first.status();
    check(!after.connected && after.accountId === CLIENT && Zotero.Prefs.get(C.HOST_PREF, true) === hostID, "Native sign-out lost account mapping or retained a connected credential");
    return { callback: true, credentialManager: true, signedTokenValidation: true, refreshRotation: true, generation: true, logout: true };
  } finally {
    for (const api of instances) api.dispose();
    // Remove only this test's synthetic record and restore the exact test-
    // profile preferences. No user profile is opened by the native runner.
    for (const login of Services.logins.findLogins(LOGIN_ORIGIN, null, LOGIN_REALM)) {
      if (login.username === CLIENT) Services.logins.removeLogin(login);
    }
    for (const [key, value] of previous) {
      if (value === null) {
        if (Services.prefs.prefHasUserValue(key)) Services.prefs.clearUserPref(key);
      } else Services.prefs.setStringPref(key, value);
    }
  }
};
