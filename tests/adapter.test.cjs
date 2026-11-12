const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../addon/content/core.js');
const { create, PREF } = require('../addon/content/zotero-adapter.js');

function fixture() {
  const saved = [];
  const prefs = new Map();
  const item = {
    id: 15, libraryID: 2, deleted: false,
    tags: [{ tag: 'Existing', type: 1 }],
    isRegularItem: () => true,
    isEditable: () => true,
    getField: field => ({title: 'Paper', abstractNote: 'Abstract'}[field] || ''),
    getCreators: () => [{firstName:'Ada', lastName:'Lovelace'}],
    getTags() { return this.tags.map(tag => ({...tag})); },
    getAttachments: () => [30, 31],
    addTag(tag, type) { this.tags.push({tag,type}); },
    async save() { saved.push({type:'item', tags:this.getTags()}); return 15; }
  };
  const attachments = {
    30: {id:30, isRegularItem:()=>false, attachmentContentType:'application/pdf', getField: () => 'Primary PDF'},
    31: {id:31, isRegularItem:()=>false, attachmentContentType:'text/html', getField: () => 'Snapshot'}
  };
  const library = {editable:true};
  const Zotero = {
    Prefs: {
      get(key, global) { assert.equal(global,true); return prefs.get(key); },
      set(key, value, global) { assert.equal(global,true); prefs.set(key,value); }
    },
    Items: {
      get(id) { return id===15 ? item : attachments[id]; },
      async getAsync(id) { return this.get(id); }
    },
    Libraries: {get: () => library},
    FullText: {getItemCacheFile: () => ({path:'/cache/local', exists:()=>true})},
    File: {getContentsAsync: async path => {assert.equal(path,'/cache/local'); return 'Cached full text';}},
    DB: {executeTransaction: async fn => fn()},
    Item: class {
      constructor(type) { this.type=type; }
      setNote(html) { this.html=html; }
      async save() { saved.push(this); return 77; }
    },
    HTTP: {request: async()=>({status:200,responseText:'{}'})}
  };
  return {api:create({Zotero,core}),Zotero,item,library,saved,prefs};
}

test('preferences reject remote destinations before persisting', () => {
  const {api,prefs}=fixture();
  assert.throws(()=>api.saveSettings({endpoint:'https://remote.example'}));
  assert.equal(prefs.size,0);
  api.saveSettings({model:'qwen3:8b'});
  assert.equal(api.loadSettings().model,'qwen3:8b');
  prefs.set(PREF,'not JSON');
  assert.equal(api.loadSettings().endpoint,core.DEFAULTS.endpoint);
});

test('selection deduplicates parent item and ignores standalone notes', () => {
  const {api,item}=fixture();
  const note={id:21,parentID:15,isRegularItem:()=>false};
  const standalone={id:22,isRegularItem:()=>false};
  assert.deepEqual(api.getSelectedItems({ZoteroPane:{getSelectedItems:()=>[note,item,standalone]}}),[item]);
});

test('getItem rejects invalid, deleted, and non-document items',async()=>{
  const {api,item}=fixture();
  assert.equal(await api.getItem(15),item);
  await assert.rejects(api.getItem('invalid'),/无效/);
  await assert.rejects(api.getItem(30),/不再可用/);
  item.deleted=true;
  await assert.rejects(api.getItem(15),/不再可用/);
});

test('context reads only cached PDF text and records limited coverage',async()=>{
  const {api}=fixture();
  const context=await api.collectContext(fixture().item,{});
  assert.equal(context.fulltext,'Cached full text');
  assert.deepEqual(context.authors,['Ada Lovelace']);
  assert.match(context.fulltextSource,/Primary PDF/);
  assert.match(context.sourceWarnings.join(' '),/部分页/);
});

test('missing fulltext cache falls back to metadata without invoking downloads',async()=>{
  const {api,Zotero,item}=fixture();
  Zotero.FullText.getItemCacheFile=()=>({exists:()=>false});
  Zotero.File.getContentsAsync=()=>assert.fail('must not read missing cache');
  const context=await api.collectContext(item,{});
  assert.equal(context.fulltext,'');
  assert.match(context.sourceWarnings.join(' '),/仅使用文献元数据和摘要/);
});

test('PDF reads distinguish UTF-8 bytes from character limit and mark truncation',async()=>{
  const {api,Zotero,item}=fixture();
  Zotero.FullText.getItemCacheFile=()=>({path:'/cache/local',exists:()=>true,fileSize:12000});
  Zotero.File.getContentsAsync=async(path,charset,maxBytes)=>{
    assert.equal(maxBytes,8004);
    return '文'.repeat(2001);
  };
  const context=await api.collectContext(item,{maxInputChars:2000});
  assert.equal(context.fulltext.length,2000);
  assert.equal(context.truncated,true);
});

test('saving keeps existing automatic tags and adds one new child note',async()=>{
  const {api,item,saved}=fixture();
  const context=await api.collectContext(item,{});
  const result=await api.saveResult(15,{tags:['existing','New'],note:'A useful short note.',model:'local:8b'},context,{},'both');
  assert.deepEqual(item.tags,[{tag:'Existing',type:1},{tag:'New',type:0}]);
  assert.deepEqual(result,{addedTags:['New'],noteID:77});
  assert.equal(saved[1].parentID,15);
  assert.equal(saved[1].libraryID,2);
  assert.match(saved[1].html,/A useful short note/);
});

test('save rechecks library permissions after generation',async()=>{
  const {api,library,item,saved}=fixture();
  const context=await api.collectContext(item,{});
  library.editable=false;
  await assert.rejects(api.saveResult(15,{tags:['New'],note:'Note'},context,{},'both'),/只读/);
  assert.equal(saved.length,0);
  assert.equal(item.tags.length,1);
});

test('transport passes anonymous, no-redirect, no-body-logging controls to native Zotero HTTP',async()=>{
  const {api,Zotero}=fixture();
  let options;
  Zotero.HTTP.request=async(method,url,raw)=>{
    assert.equal(method,'POST');
    assert.equal(url,'http://127.0.0.1:11434/api/show');
    options=raw;
    return {status:200,responseText:'{"capabilities":["completion"]}'};
  };
  const data=await api.transport({url:'http://127.0.0.1:11434/api/show',method:'POST',body:{model:'local:8b'}});
  assert.deepEqual(data.capabilities,['completion']);
  assert.equal(options.followRedirects,false);
  assert.equal(options.anon,true);
  assert.equal(options.logBodyLength,0);
  assert.equal(options.debug,false);
  assert.equal(options.successCodes,false);
});

test('transport rejects remote endpoints and redirects',async()=>{
  const {api,Zotero}=fixture();
  await assert.rejects(api.transport({url:'https://example.com/api/chat'}),/仅允许本机/);
  await assert.rejects(api.transport({url:'http://127.0.0.1:11434/api/chat?secret=1'}),/仅允许访问/);
  Zotero.HTTP.request=async()=>({status:302});
  await assert.rejects(api.transport({url:'http://127.0.0.1:11434/api/tags'}),/重定向/);
});

test('AbortSignal cancels native request and surfaces an AbortError',async()=>{
  const {api,Zotero}=fixture();
  const controller=new AbortController();
  let wasCancelled=false;
  Zotero.HTTP.request=(method,url,options)=>new Promise((resolve,reject)=>{
    options.cancellerReceiver(()=>{wasCancelled=true;reject(new Error('native cancelled'));});
  });
  const pending=api.transport({url:'http://127.0.0.1:11434/api/chat',signal:controller.signal});
  controller.abort();
  await assert.rejects(pending,error=>error.name==='AbortError');
  assert.equal(wasCancelled,true);
});
