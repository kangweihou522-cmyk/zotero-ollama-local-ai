/* SPDX-License-Identifier: MIT */
var chromeHandle;
var pluginScope;

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;
  const aom = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Components.interfaces.amIAddonManagerStartup);
  chromeHandle = aom.registerChrome(Services.io.newURI(rootURI + "manifest.json"), [
    ["content", "ollama-local-ai", rootURI + "content/"]
  ]);
  pluginScope = {
    Zotero, Services, ChromeUtils, Components,
    Cc: Components.classes, Ci: Components.interfaces, Cr: Components.results,
    URL, TextEncoder, rootURI
  };
  pluginScope.globalThis = pluginScope;
  for (const file of ["core.js", "zotero-adapter.js", "main.js"]) {
    Services.scriptloader.loadSubScript(rootURI + "content/" + file, pluginScope, "UTF-8");
  }
  await pluginScope.OllamaLocalMain.start({ id, version, rootURI });
}

function onMainWindowLoad({ window }) {
  pluginScope?.OllamaLocalMain?.addWindow(window);
}

function onMainWindowUnload({ window }) {
  pluginScope?.OllamaLocalMain?.removeWindow(window);
}

function shutdown(data, reason) {
  if (reason === APP_SHUTDOWN) return;
  pluginScope?.OllamaLocalMain?.stop();
  pluginScope = null;
  chromeHandle?.destruct();
  chromeHandle = null;
}
