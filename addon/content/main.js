/* SPDX-License-Identifier: MIT */
var OllamaLocalMain = (() => {
  const adapter = OllamaZoteroAdapter.create({ Zotero, Services, Cc, Ci, Cr, ChromeUtils, core: OllamaLocalCore });
  const chatgpt = OllamaChatGPT.create({ Zotero, Services, Components, Cc, Ci, ChromeUtils, crypto });
  const engine = OllamaGenerationEngine.create({ core: OllamaLocalCore, adapter, chatgpt });
  const windows = new Set();
  const dialogs = new Set();
  const menuIDs = [];
  let identity;

  function addWindow(win) {
    if (!win || windows.has(win)) return;
    win.MozXULElement.insertFTLIfNeeded("ollama-local-ai.ftl");
    windows.add(win);
  }

  function removeWindow(win) {
    windows.delete(win);
    const links = win.document?.querySelectorAll('link[href="ollama-local-ai.ftl"]') || [];
    for (const link of links) link.remove();
  }

  function open(win, mode = "both", settingsPage = false) {
    win = win || Zotero.getMainWindow();
    if (!win) return;
    const items = adapter.getSelectedItems(win);
    const bridge = {
      core: OllamaLocalCore,
      adapter,
      engine,
      version: identity.version,
      hostVersion: Zotero.version || "10",
      mode,
      settingsPage,
      items: items.map(item => ({ id: item.id, title: item.getField("title") || "无标题文献" }))
    };
    const dialog = win.openDialog(
      "chrome://ollama-local-ai/content/dialog.xhtml",
      "", "chrome,centerscreen,resizable,dialog=no", bridge
    );
    dialogs.add(dialog);
    dialog.addEventListener("unload", () => dialogs.delete(dialog), { once: true });
  }

  function owner(event) {
    return event.target?.ownerGlobal || event.target?.ownerDocument?.defaultView || Zotero.getMainWindow();
  }

  async function start(info) {
    identity = info;
    for (const win of Zotero.getMainWindows()) addWindow(win);
    const actions = [
      ["both", "ollama-local-ai-both"],
      ["tags", "ollama-local-ai-tags"],
      ["note", "ollama-local-ai-note"],
      ["overview", "ollama-local-ai-overview"],
      ["all", "ollama-local-ai-all"]
    ];
    const menus = actions.map(([mode, l10nID]) => ({
      menuType: "menuitem", l10nID,
      onShowing: (event, context) => context.setEnabled(adapter.getSelectedItems(owner(event)).length > 0),
      onCommand: event => open(owner(event), mode)
    }));
    menus.push({ menuType: "separator" }, {
      menuType: "menuitem", l10nID: "ollama-local-ai-settings",
      onCommand: event => open(owner(event), "both", true)
    });
    for (const target of ["main/library/item", "main/menubar/tools"]) {
      const menuID = "ollama-local-ai-" + target.replaceAll("/", "-");
      const registered = Zotero.MenuManager.registerMenu({
        menuID, pluginID: info.id, target,
        menus: [{ menuType: "submenu", l10nID: "ollama-local-ai-menu", menus }]
      });
      if (!registered) throw new Error("Ollama Local AI 菜单注册失败");
      menuIDs.push(registered);
    }
    Zotero.OllamaLocalAI = { openSettings: () => open(null, "both", true) };
    await Zotero.PreferencePanes.register({
      pluginID: info.id,
      id: "ollama-local-ai-preferences",
      label: "Ollama Local AI",
      src: info.rootURI + "content/preferences.xhtml",
      scripts: [info.rootURI + "content/preferences.js"]
    });
  }

  function stop() {
    for (const dialog of dialogs) {
      try { dialog.close(); } catch (_) {}
    }
    dialogs.clear();
    engine.dispose();
    for (const id of menuIDs.splice(0)) Zotero.MenuManager.unregisterMenu(id);
    for (const win of windows) removeWindow(win);
    windows.clear();
    delete Zotero.OllamaLocalAI;
  }

  return { start, stop, addWindow, removeWindow };
})();
