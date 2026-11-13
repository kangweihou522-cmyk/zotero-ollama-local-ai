const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const {webcrypto}=require('node:crypto');

test('bootstrap loads scoped modules, registers native menus and preferences, opens and cleans up dialog', async () => {
  const root = path.resolve(__dirname, '../addon');
  const registered = [], removed = [], inserted = [], dialogs = [];
  let destroyed = false;
  const item = {id:42,parentID:null,deleted:false,isRegularItem:()=>true,getField:()=> '示例文献'};
  const win = {
    setTimeout, clearTimeout,
    MozXULElement: {insertFTLIfNeeded:file=>inserted.push(file)},
    document: {querySelectorAll:()=>[]},
    ZoteroPane: {getSelectedItems:()=>[item]},
    openDialog(url,name,features,bridge) {
      const dialog = { url, bridge, closed:false, addEventListener(){}, close(){this.closed=true;} };
      dialogs.push(dialog); return dialog;
    }
  };
  const Zotero = {
    initializationPromise:Promise.resolve(),getMainWindows:()=>[win],getMainWindow:()=>win,
    Prefs:{get:()=>undefined,set(){}},
    MenuManager:{registerMenu:options=>{registered.push(options);return options.menuID;},unregisterMenu:id=>removed.push(id)},
    PreferencePanes:{register:async options=>{Zotero.preference=options;}}
  };
  const scriptContexts = new WeakMap();
  const Services = {
    io:{newURI:uri=>uri},
    scriptloader:{loadSubScript(uri,target){
      if(!scriptContexts.has(target)) scriptContexts.set(target,vm.createContext(target));
      vm.runInContext(fs.readFileSync(uri.replace('test:///',''),'utf8'), scriptContexts.get(target), {filename:uri});
    }}
  };
  const Components = {
    classes:{'@mozilla.org/addons/addon-manager-startup;1':{getService:()=>({registerChrome:()=>({destruct:()=>{destroyed=true;}})})}},
    interfaces:{amIAddonManagerStartup:{}},results:{}
  };
  const scope = vm.createContext({Zotero,Services,Components,ChromeUtils:{},URL,TextEncoder,crypto:webcrypto,APP_SHUTDOWN:8});
  vm.runInContext(fs.readFileSync(path.join(root,'bootstrap.js'),'utf8'),scope);
  await scope.startup({id:'ollama-local-ai@local.tools',version:'0.1.0',rootURI:'test:///'+root+'/'});
  assert.equal(registered.length,2);
  assert.ok(registered.some(menu=>menu.target==='main/library/item'));
  assert.deepEqual(inserted,['ollama-local-ai.ftl']);
  assert.match(Zotero.preference.src,/preferences.xhtml$/);
  const action = registered[0].menus[0].menus[0];
  let enabled;
  action.onShowing({target:{ownerGlobal:win}},{setEnabled:value=>{enabled=value;}});
  assert.equal(enabled,true);
  action.onCommand({target:{ownerGlobal:win}});
  assert.equal(dialogs.length,1);
  assert.equal(dialogs[0].bridge.items[0].id,42);
  assert.equal(typeof dialogs[0].bridge.adapter.getItem,'function');
  assert.equal(typeof dialogs[0].bridge.core.generate,'function');
  assert.equal(typeof dialogs[0].bridge.engine.generate,'function');
  assert.equal(typeof dialogs[0].bridge.engine.login,'function');
  scope.shutdown({},4);
  assert.equal(dialogs[0].closed,true);
  assert.equal(removed.length,2);
  assert.equal(destroyed,true);
  assert.equal(Zotero.OllamaLocalAI,undefined);
});
