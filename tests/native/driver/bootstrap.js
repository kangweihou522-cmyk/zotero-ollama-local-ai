/* SPDX-License-Identifier: MIT
 * Test-only addon. This runs only in the disposable profile created by run.sh.
 */
var nativeSmokeStarted = false;
var nativeSmokeFinished = false;
var nativeSmokeReport = { success: false, stages: [] };
var nativeSmokeDriverRootURI;

function install() {}
function uninstall() {}
function shutdown() {}

function startup({ rootURI }) {
  if (nativeSmokeStarted) return;
  nativeSmokeDriverRootURI = rootURI;
  nativeSmokeStarted = true;
  // Plugin startup is awaited by Zotero.Plugins.init(), before the UI becomes
  // ready. Do not return this Promise or wait for uiReadyPromise in startup.
  nativeSmokeRun().catch(error => nativeSmokeFinish(error));
}

function nativeSmokeCheck(condition, message) {
  if (!condition) throw new Error(message);
}

function nativeSmokeProfileFile(name) {
  const file = Services.dirsvc.get("ProfD", Components.interfaces.nsIFile);
  file.append(name);
  return file;
}

async function nativeSmokeStage(name, details = {}) {
  nativeSmokeReport.stages.push({ name, ...details });
  await IOUtils.writeUTF8(
    nativeSmokeProfileFile("native-smoke.json").path,
    JSON.stringify(nativeSmokeReport, null, 2)
  );
  Zotero.debug("Ollama native smoke: " + name);
}

async function nativeSmokeWaitFor(check, description, milliseconds = 30000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for " + description);
}

async function nativeSmokeInstall(AddonManager, file) {
  const install = await AddonManager.getInstallForFile(file);
  nativeSmokeCheck(install, "AddonManager did not return an installer for the built XPI");
  nativeSmokeCheck(!install.error, "XPI was rejected by the real manifest parser: " + install.error);
  nativeSmokeCheck(install.addon?.id === "ollama-local-ai@local.tools", "Installer parsed an unexpected addon ID");
  nativeSmokeCheck(!install.addon.appDisabled, "Parsed XPI is application-incompatible");
  await nativeSmokeStage("xpi-parsed", { id: install.addon.id, version: install.addon.version });
  return new Promise((resolve, reject) => {
    install.addListener({
      onInstallEnded(_install, addon) { resolve(addon); },
      onInstallFailed(failed) { reject(new Error("Native installation failed: " + failed.error)); },
      onInstallCancelled() { reject(new Error("Native installation was cancelled")); },
      onDownloadFailed(failed) { reject(new Error("Local XPI load failed: " + failed.error)); }
    });
    try {
      const installing = install.install();
      if (installing && typeof installing.catch === "function") installing.catch(reject);
    } catch (error) { reject(error); }
  });
}

function nativeSmokeDialog() {
  const windows = Services.wm.getEnumerator(null);
  while (windows.hasMoreElements()) {
    const window = windows.getNext();
    if (window.document?.documentURI === "chrome://ollama-local-ai/content/dialog.xhtml") return window;
  }
  return null;
}

async function nativeSmokeRun() {
  // This timeout also produces a report when the host never opens its main UI.
  setTimeout(() => {
    if (!nativeSmokeFinished) nativeSmokeFinish(new Error("Native smoke exceeded its 120-second deadline"));
  }, 120000);
  await nativeSmokeStage("driver-started");
  await Zotero.initializationPromise;
  await nativeSmokeWaitFor(() => Zotero.getMainWindow()?.document?.readyState === "complete", "main Zotero window");
  await Zotero.uiReadyPromise;
  const hostVersion = Zotero.version || Services.appinfo.version;
  nativeSmokeCheck(hostVersion === "10.0.8", "Expected Zotero 10.0.8, received " + hostVersion);
  nativeSmokeReport.hostVersion = hostVersion;
  await nativeSmokeStage("host-ready", { hostVersion });

  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const installerFile = nativeSmokeProfileFile("ollama-local-ai.xpi");
  nativeSmokeCheck(installerFile.exists(), "Built XPI is missing from the disposable profile");
  await nativeSmokeInstall(AddonManager, installerFile);
  const addon = await nativeSmokeWaitFor(async () => {
    const current = await AddonManager.getAddonByID("ollama-local-ai@local.tools");
    return current?.isActive && current;
  }, "installed addon to become active");
  await nativeSmokeWaitFor(() => Zotero.OllamaLocalAI?.openSettings, "production addon startup");
  await nativeSmokeWaitFor(() => Zotero.PreferencePanes.pluginPanes.some(pane => pane.pluginID === addon.id), "production preference pane");
  const menuOptions = Zotero.MenuManager._menuManager.options.filter(option => option.pluginID === addon.id);
  nativeSmokeCheck(menuOptions.some(option => option.target === "main/library/item"), "Library context menu was not registered");
  nativeSmokeCheck(menuOptions.some(option => option.target === "main/menubar/tools"), "Tools menu was not registered");
  await nativeSmokeStage("addon-started", { id: addon.id, version: addon.version, registeredMenus: menuOptions.length });

  Zotero.OllamaLocalAI.openSettings();
  const dialog = await nativeSmokeWaitFor(() => {
    const current = nativeSmokeDialog();
    return current?.document?.readyState === "complete" && current;
  }, "real chrome generation dialog");
  await nativeSmokeWaitFor(() => {
    const notice = dialog.document.getElementById("notice");
    return notice && !notice.textContent.includes("正在加载");
  }, "dialog JavaScript initialization");
  for (const id of ["mode", "generate", "endpoint", "model", "result-note", "result-tags", "provider", "profile", "live-output", "chatgpt-login"]) {
    nativeSmokeCheck(dialog.document.getElementById(id), "Chrome dialog is missing control " + id);
  }
  const bridge = dialog.arguments?.[0];
  nativeSmokeCheck(bridge?.core?.generate && bridge?.adapter?.saveResult, "Chrome dialog bridge is missing its production APIs");
  nativeSmokeCheck(bridge.engine?.generate && bridge.engine?.login, "Dual-engine bridge is missing");
  nativeSmokeCheck(dialog.document.getElementById("mode").value === "both", "Default task should avoid generating a long overview");
  nativeSmokeCheck(dialog.document.getElementById("context-tokens").value === "4096", "Default brief task did not apply the 6GB fast context");
  nativeSmokeCheck([...dialog.document.getElementById("mode").options].some(option => option.value === "all"), "Real dialog has no all-features mode");
  await nativeSmokeStage("chrome-dialog-ready", { title: dialog.document.title });

  const authTestScope = { Zotero, Services, ChromeUtils, Components, URL, URLSearchParams, TextEncoder,
    crypto: Zotero.getMainWindow().crypto, setTimeout, clearTimeout };
  authTestScope.globalThis = authTestScope;
  Services.scriptloader.loadSubScript(nativeSmokeDriverRootURI + "chatgpt-native.js", authTestScope, "UTF-8");
  const authDetails = await authTestScope.runChatGPTNativeSmoke(authTestScope);
  await nativeSmokeStage("subscription-native-callback-and-vault-passed", authDetails);

  const { core, adapter, engine } = bridge;
  const settings = core.effectiveSettings({
    endpoint: "http://127.0.0.1:11435",
    model: "smoke-model",
    includeFulltext: false,
    briefTarget: "style-and-note",
    timeoutSeconds: 15,
    contextTokens: 8192,
    cacheEnabled: true,
    profile: "fast"
  }, "all");
  const models = await core.listModels(adapter.transport, settings);
  nativeSmokeCheck(models.some(model => model.name === settings.model), "Native HTTP did not list the loopback model");
  const item = new Zotero.Item("journalArticle");
  item.libraryID = Zotero.Libraries.userLibraryID;
  item.setField("title", "Native smoke synthetic literature item");
  item.setField("abstractNote", "This synthetic abstract describes a local literature tagging test. No user documents are used.");
  const preservedExtra = "DOI: 10.0000/native-smoke\nCitation Key: NativeSmokeFixture\nUnrelated: keep this text";
  item.setField("extra", preservedExtra);
  item.addTag("preserved fixture", 1);
  await item.saveTx();
  const context = await adapter.collectContext(item, settings);
  let streamEvents=0;
  const generated = await engine.generate(context, "all", settings, undefined, {onProgress(event){if(event.stage==="streaming"&&event.text)streamEvents++;}});
  nativeSmokeCheck(streamEvents>0,"Native streaming did not produce answer progress");
  nativeSmokeCheck(generated.stats?.tokensPerSecond===50,"Native response metrics were not retained");
  const cached=await engine.generate(context,"all",settings);
  nativeSmokeCheck(cached.cacheHit===true,"Native generation cache did not reuse identical evidence");
  const runtime=await adapter.getRuntimeInfo(settings);
  nativeSmokeCheck(runtime.selectedModel?.processor==="gpu","Native runtime diagnostics did not parse fixture residency");
  await nativeSmokeStage("native-streaming-cache-and-runtime-passed", {streamEvents,cacheHit:cached.cacheHit});
  const saved = await adapter.saveResult(item.id, generated, context, settings, "all");
  nativeSmokeCheck(saved.noteID && saved.overviewNoteID && saved.noteID !== saved.overviewNoteID, "Native save did not create distinct brief and overview notes");
  nativeSmokeCheck(saved.styleRemarkUpdated, "Native save did not update the optional Style remark");
  const stored = await Zotero.Items.getAsync(item.id);
  await stored.loadAllData();
  const tags = stored.getTags();
  nativeSmokeCheck(tags.some(tag => tag.tag === "preserved fixture" && tag.type === 1), "Existing automatic tag was changed");
  nativeSmokeCheck(tags.some(tag => tag.tag === "native smoke"), "Generated tag was not saved");
  const extra = stored.getField("extra");
  nativeSmokeCheck(extra.includes(preservedExtra), "Native save changed unrelated Extra metadata");
  nativeSmokeCheck(adapter.readStyleRemark(extra) === generated.note, "Style remark differs from the generated brief");
  const note = await Zotero.Items.getAsync(saved.noteID);
  const overview = await Zotero.Items.getAsync(saved.overviewNoteID);
  await note.loadAllData();
  await overview.loadAllData();
  nativeSmokeCheck(note.parentID === stored.id && overview.parentID === stored.id, "Child notes are attached to the wrong parent");
  nativeSmokeCheck(note.getNote().includes(generated.note), "Generated brief is missing from the real child note");
  nativeSmokeCheck(overview.getNote().includes(generated.overview.methods), "Generated overview is missing from the real child note");
  await nativeSmokeStage("native-http-and-database-passed", { createdItemID: stored.id, noteID: saved.noteID, overviewNoteID: saved.overviewNoteID });

  const freshContext = await adapter.collectContext(stored, settings);
  const edited = { ...generated, note: "Updated native test brief", tags: ["must remain absent on rejected save"] };
  let overwriteRejected = false;
  try { await adapter.saveResult(stored.id, edited, freshContext, settings, "all"); }
  catch (error) { overwriteRejected = /已有简记|允许更新/.test(error.message); }
  nativeSmokeCheck(overwriteRejected, "Existing Style remark was overwritten without opt-in");
  nativeSmokeCheck(!stored.getTags().some(tag => tag.tag === "must remain absent on rejected save"), "Rejected save partially added tags");
  nativeSmokeCheck(stored.getNotes().length === 2, "Rejected save partially created notes");
  await nativeSmokeStage("overwrite-guard-passed");
  dialog.close();
  nativeSmokeReport.success = true;
  await nativeSmokeFinish();
}

async function nativeSmokeFinish(error) {
  if (nativeSmokeFinished) return;
  nativeSmokeFinished = true;
  if (error) {
    nativeSmokeReport.success = false;
    nativeSmokeReport.error = { message: String(error.message || error), stack: String(error.stack || "") };
    Zotero.logError(error);
  }
  try {
    await IOUtils.writeUTF8(
      nativeSmokeProfileFile("native-smoke.json").path,
      JSON.stringify(nativeSmokeReport, null, 2)
    );
  } finally {
    Services.startup.quit(Components.interfaces.nsIAppStartup.eForceQuit);
  }
}
