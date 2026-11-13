const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../addon/content/core.js');
const { create, PREF, readStyleRemark, updateStyleRemark } = require('../addon/content/zotero-adapter.js');

function fixture() {
  const saved = [];
  const prefs = new Map();
  const fields = {title:'Paper',abstractNote:'Abstract',extra:''};
  let noteSequence = 77;
  const item = {
    id: 15, libraryID: 2, deleted: false,
    tags: [{ tag: 'Existing', type: 1 }],
    isRegularItem: () => true,
    isEditable: () => true,
    getField: field => fields[field] || '',
    setField(field,value) { fields[field]=value; },
    getCreators: () => [{firstName:'Ada', lastName:'Lovelace'}],
    getTags() { return this.tags.map(tag => ({...tag})); },
    getAttachments: () => [30, 31],
    addTag(tag, type) { this.tags.push({tag,type}); },
    async save() { saved.push({type:'item', tags:this.getTags(), fields:{...fields}}); return 15; }
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
      async save() { saved.push(this); return noteSequence++; }
    },
    HTTP: {request: async()=>({status:200,responseText:'{}'})}
  };
  return {api:create({Zotero,core}),Zotero,item,library,saved,prefs,fields};
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
  assert.deepEqual(result,{addedTags:['New'],noteID:77,overviewNoteID:null,styleRemarkUpdated:false});
  assert.equal(saved[1].parentID,15);
  assert.equal(saved[1].libraryID,2);
  assert.match(saved[1].html,/A useful short note/);
});

test('Style remark helpers preserve every unrelated Extra line and its original line endings',()=>{
  const extra='Citation Key: Ada2026\r\nremark: Existing remark\r\nDOI: 10.123/中文\r\n\r\nArchive:  Keep spaces  \r\n';
  assert.equal(readStyleRemark(extra),'Existing remark');
  assert.equal(updateStyleRemark(extra,'New\n brief\ttext'),
    'Citation Key: Ada2026\r\nremark: New brief text\r\nDOI: 10.123/中文\r\n\r\nArchive:  Keep spaces  \r\n');
  const without='DOI: 10.123/文献\r\nCitation Key: Stable\r\n';
  assert.equal(readStyleRemark(without),null);
  assert.equal(updateStyleRemark(without,'First brief'),'remark: First brief\r\n'+without);
  assert.equal(updateStyleRemark('','Brief'),'remark: Brief');
  assert.throws(()=>updateStyleRemark(extra,' \n '),/为空/);
});

test('duplicate remark fields are explicit and never silently merged or removed',async()=>{
  const {api,item,fields,saved}=fixture();
  fields.extra='remark: First\nDOI: 10.1/test\nRemark: Second';
  assert.throws(()=>readStyleRemark(fields.extra),/多条/);
  assert.throws(()=>updateStyleRemark(fields.extra,'Replacement'),/多条/);
  const context=await api.collectContext(item,{includeFulltext:false});
  assert.equal(context.styleRemarkAmbiguous,true);
  assert.match(context.sourceWarnings.join(' '),/多条/);
  await assert.rejects(api.saveResult(15,{note:'New brief'},context,{briefTarget:'style-and-note'},'note'),/多条/);
  assert.equal(saved.length,0);
  assert.equal(fields.extra,'remark: First\nDOI: 10.1/test\nRemark: Second');
  await api.saveResult(15,{note:'Independent brief'},context,{},'note');
  assert.equal(saved.length,1);
  assert.match(saved[0].html,/Independent brief/);
});

test('default brief save creates a child note without changing Extra or Style remark',async()=>{
  const {api,item,fields,saved}=fixture();
  fields.extra='remark: Hand-written original\nDOI: 10.1/example';
  const context=await api.collectContext(item,{});
  assert.equal(context.styleRemark,'Hand-written original');
  const result=await api.saveResult(15,{note:'Generated brief'},context,{},'note');
  assert.equal(result.styleRemarkUpdated,false);
  assert.equal(fields.extra,'remark: Hand-written original\nDOI: 10.1/example');
  assert.equal(saved.length,1);
  assert.equal(saved[0].parentID,15);
});

test('Style opt-in creates a missing remark and still saves a normal child note',async()=>{
  const {api,item,fields,saved}=fixture();
  fields.extra='DOI: 10.1/stable\r\nCitation Key: Existing\r\n';
  const settings={briefTarget:'style-and-note'};
  const context=await api.collectContext(item,settings);
  assert.equal(context.styleRemark,null);
  const result=await api.saveResult(15,{note:'Brief\nwith a second line'},context,settings,'note');
  assert.equal(fields.extra,'remark: Brief with a second line\r\nDOI: 10.1/stable\r\nCitation Key: Existing\r\n');
  assert.equal(result.styleRemarkUpdated,true);
  assert.equal(result.noteID,77);
  assert.equal(saved.length,2);
  assert.equal(saved[1].parentID,15);
});

test('overwriting a nonempty Style remark requires explicit consent before any tags mutate',async()=>{
  const {api,item,fields,saved}=fixture();
  const original='remark: Carefully written brief\nDOI: 10.1/stable';
  fields.extra=original;
  const settings={briefTarget:'style-and-note'};
  const context=await api.collectContext(item,settings);
  const result={tags:['New tag'],note:'Replacement brief'};
  await assert.rejects(api.saveResult(15,result,context,settings,'both'),/勾选允许更新/);
  assert.equal(fields.extra,original);
  assert.equal(item.tags.length,1);
  assert.equal(saved.length,0);
  const savedResult=await api.saveResult(15,result,context,settings,'both',{allowStyleOverwrite:true});
  assert.equal(fields.extra,'remark: Replacement brief\nDOI: 10.1/stable');
  assert.equal(savedResult.styleRemarkUpdated,true);
  assert.equal(saved.filter(entry=>entry.type==='item').length,1);
  assert.deepEqual(item.tags,[{tag:'Existing',type:1},{tag:'New tag',type:0}]);
});

test('a concurrently edited Style remark blocks the entire save even with overwrite consent',async()=>{
  const {api,item,fields,saved}=fixture();
  fields.extra='remark: Initial\nDOI: 10.1/initial';
  const settings={briefTarget:'style-and-note'};
  const context=await api.collectContext(item,settings);
  fields.extra='remark: User edited after generation\nDOI: 10.1/updated';
  await assert.rejects(api.saveResult(15,{tags:['New'],note:'AI brief'},context,settings,'both',{allowStyleOverwrite:true}),/生成后已被修改/);
  assert.equal(fields.extra,'remark: User edited after generation\nDOI: 10.1/updated');
  assert.equal(item.tags.length,1);
  assert.equal(saved.length,0);
});

test('an unchanged remark needs no overwrite consent and preserves original formatting',async()=>{
  const {api,item,fields,saved}=fixture();
  fields.extra='  Remark: Same generated brief  \r\nDOI: 10.1/stable';
  const settings={briefTarget:'style-and-note'};
  const context=await api.collectContext(item,settings);
  const result=await api.saveResult(15,{note:'Same generated brief'},context,settings,'note');
  assert.equal(result.styleRemarkUpdated,false);
  assert.equal(fields.extra,'  Remark: Same generated brief  \r\nDOI: 10.1/stable');
  assert.equal(saved.length,1);
});

function overview() {
  return {background:'Background evidence.',question:'Question evidence.',methods:'Materials do not provide methods.',findings:'Findings from the provided abstract.',limitations:'Materials do not provide limitations.',relevance:'Useful for literature screening.'};
}

test('overview-only saves a separately titled child note without adding tags or a brief',async()=>{
  const {api,item,fields,saved}=fixture();
  fields.extra='DOI: 10.1/stable';
  const context=await api.collectContext(item,{});
  const result=await api.saveResult(15,{overview:overview(),model:'local'},context,{},'overview');
  assert.deepEqual(result,{addedTags:[],noteID:null,overviewNoteID:77,styleRemarkUpdated:false});
  assert.equal(saved.length,1);
  assert.equal(saved[0].parentID,15);
  assert.match(saved[0].html,/AI 概览/);
  assert.match(saved[0].html,/Question evidence/);
  assert.equal(fields.extra,'DOI: 10.1/stable');
  assert.equal(item.tags.length,1);
});

test('all mode saves parent changes once plus distinct brief and overview notes',async()=>{
  const {api,item,saved}=fixture();
  const settings={briefTarget:'style-and-note'};
  const context=await api.collectContext(item,settings);
  const result=await api.saveResult(15,{tags:['New'],note:'Brief only.',overview:overview()},context,settings,'all');
  assert.deepEqual(result,{addedTags:['New'],noteID:77,overviewNoteID:78,styleRemarkUpdated:true});
  assert.equal(saved.filter(entry=>entry.type==='item').length,1);
  assert.equal(saved.length,3);
  assert.match(saved[1].html,/AI 简记/);
  assert.match(saved[2].html,/AI 概览/);
  assert.equal(saved[1].parentID,15);
  assert.equal(saved[2].libraryID,2);
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

function progressXHR(status=200) {
  const listeners=new Set();
  return {
    status,responseText:'',listeners,
    addEventListener(type,fn){assert.equal(type,'progress');listeners.add(fn);},
    removeEventListener(type,fn){assert.equal(type,'progress');listeners.delete(fn);},
    progress(text){this.responseText=text;for(const fn of [...listeners])fn();}
  };
}

test('streaming emits incremental UTF-8 text once and flushes the final unread suffix',async()=>{
  const {api,Zotero}=fixture();
  const xhr=progressXHR();
  const text='{"message":{"content":"本地😀"}}\n{"done":true}\n';
  const chunks=[];
  let finalResolve;
  Zotero.HTTP.request=(method,url,options)=>new Promise(resolve=>{
    assert.equal(options.followRedirects,false);
    assert.equal(options.anon,true);
    assert.equal(options.logBodyLength,0);
    assert.equal(options.headers.Accept,'application/x-ndjson');
    options.requestObserver(xhr);
    options.cancellerReceiver(()=>assert.fail('should not cancel a successful stream'));
    xhr.progress(text.slice(0,10));
    xhr.progress(text.slice(0,26));
    xhr.progress(text.slice(0,26)); // repeated events must not repeat output
    finalResolve=()=>{xhr.responseText=text;resolve(xhr);};
  });
  const pending=api.transport({url:'http://127.0.0.1:11434/api/chat',method:'POST',stream:true,onChunk:chunk=>chunks.push(chunk)});
  assert.equal(chunks.length,2,'progress must arrive before final load');
  finalResolve();
  assert.equal(await pending,text);
  assert.equal(chunks.join(''),text);
  assert.equal(chunks.length,3);
  assert.equal(xhr.listeners.size,0,'settled requests release their native progress listener');
});

test('streaming without native progress still returns and emits the complete body',async()=>{
  const {api,Zotero}=fixture();
  const text='{"message":{"content":"A"},"done":true}\n';
  const chunks=[];
  Zotero.HTTP.request=async()=>({status:200,responseText:text});
  assert.equal(await api.transport({url:'http://127.0.0.1:11434/api/chat',stream:true,onChunk:chunk=>chunks.push(chunk)}),text);
  assert.deepEqual(chunks,[text]);
});

test('a stream parser exception cancels native IO and is returned to the caller',async()=>{
  const {api,Zotero}=fixture();
  const xhr=progressXHR();
  let cancelled=false;
  const parserError=new Error('Malformed NDJSON frame');
  Zotero.HTTP.request=(method,url,options)=>new Promise((resolve,reject)=>{
    options.requestObserver(xhr);
    options.cancellerReceiver(()=>{cancelled=true;reject(new Error('native cancelled'));});
    xhr.progress('{broken frame}\n');
  });
  await assert.rejects(api.transport({url:'http://127.0.0.1:11434/api/chat',stream:true,onChunk:()=>{throw parserError;}}),error=>error===parserError);
  assert.equal(cancelled,true);
  assert.equal(xhr.listeners.size,0);
});

test('streaming cancellation removes progress listeners and never emits after abort',async()=>{
  const {api,Zotero}=fixture();
  const xhr=progressXHR();
  const controller=new AbortController();
  const chunks=[];
  Zotero.HTTP.request=(method,url,options)=>new Promise((resolve,reject)=>{
    options.requestObserver(xhr);
    options.cancellerReceiver(()=>reject(new Error('native aborted')));
    xhr.progress('initial');
  });
  const pending=api.transport({url:'http://127.0.0.1:11434/api/chat',stream:true,signal:controller.signal,onChunk:chunk=>chunks.push(chunk)});
  controller.abort();
  xhr.progress('initial must not be emitted');
  await assert.rejects(pending,error=>error.name==='AbortError');
  assert.deepEqual(chunks,['initial']);
  assert.equal(xhr.listeners.size,0);
});

test('HTTP failure and redirect bodies never become streamed model output',async()=>{
  const {api,Zotero}=fixture();
  const chunks=[];
  let status=500;
  Zotero.HTTP.request=async(method,url,options)=>{
    const xhr=progressXHR(status);
    options.requestObserver(xhr);
    xhr.progress('{"error":"model not available"}');
    return xhr;
  };
  await assert.rejects(api.transport({url:'http://127.0.0.1:11434/api/chat',stream:true,onChunk:chunk=>chunks.push(chunk)}),/HTTP 500.*model not available/);
  status=302;
  await assert.rejects(api.transport({url:'http://127.0.0.1:11434/api/chat',stream:true,onChunk:chunk=>chunks.push(chunk)}),/重定向/);
  assert.deepEqual(chunks,[]);
});

test('oversized streams cancel before exposing the large body',async()=>{
  const {api,Zotero}=fixture();
  let cancelled=false;
  Zotero.HTTP.request=(method,url,options)=>new Promise((resolve,reject)=>{
    const xhr=progressXHR();
    options.requestObserver(xhr);
    options.cancellerReceiver(()=>{cancelled=true;reject(new Error('native cancelled'));});
    xhr.progress('x'.repeat(4*1024*1024+1));
  });
  await assert.rejects(api.transport({url:'http://127.0.0.1:11434/api/chat',stream:true,onChunk:()=>assert.fail('oversized body must not be exposed')}),/响应过大/);
  assert.equal(cancelled,true);
});

test('runtime diagnostics identify GPU, CPU, mixed residency and unloaded selected models',async()=>{
  const {api,Zotero}=fixture();
  Zotero.HTTP.request=async(method,url,options)=>{
    assert.equal(method,'GET');
    assert.equal(url,'http://127.0.0.1:11434/api/ps');
    assert.equal(options.timeout,10000);
    return {status:200,responseText:JSON.stringify({models:[
      {name:'gpu:4b',size:100,size_vram:100,context_length:8192},
      {name:'cpu:4b',size:100,size_vram:0},
      {name:'mixed:4b',size:100,size_vram:60,expires_at:'2026-11-13T00:00:00Z'},
      {model:'unknown:4b'},
      {name:'invalid:4b',size:-20,size_vram:'100'},
      null
    ]})};
  };
  const data=await api.getRuntimeInfo({model:'mixed:4b'});
  assert.deepEqual(data.models.map(model=>model.processor),['gpu','cpu','mixed','unknown','unknown']);
  assert.equal(data.selectedModel.name,'mixed:4b');
  assert.equal(data.selectedModel.gpuFraction,0.6);
  assert.equal(data.selectedModel.cpuBytes,40);
  assert.equal(data.models[0].contextTokens,8192);
  assert.equal(data.isLoaded,true);
  const unloaded=await api.getRuntimeInfo({model:'other:4b'});
  assert.equal(unloaded.isLoaded,false);
  assert.equal(unloaded.selectedModel,null);
});

test('malformed runtime diagnostics and non-loopback addresses are rejected',async()=>{
  const {api,Zotero}=fixture();
  Zotero.HTTP.request=async()=>({status:200,responseText:'{"models":null}'});
  await assert.rejects(api.getRuntimeInfo({model:'local'}),/运行状态响应格式/);
  await assert.rejects(api.getRuntimeInfo({endpoint:'https://remote.example',model:'local'}),/仅允许本机/);
});
