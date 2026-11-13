const {test}=require('node:test');
const assert=require('node:assert/strict');
const core=require('../addon/content/core.js');
const {create}=require('../addon/content/engine.js');

function fixture() {
  let account={connected:true,accountId:'account-1',accountLabel:'Test account'};
  let calls=0;
  const chatgpt={
    status:async()=>({...account}),listModels:async()=>[{id:'model-test',name:'Available model'}],
    generate:async request=>{calls++;request.onDelta?.('{"tags":["');request.onDelta?.('测试"]}');return {text:'{"tags":["测试"]}',model:'model-test'};},
    login:async()=>({...account}),logout:async()=>{account={connected:false,accountId:null};return {...account};},dispose(){}
  };
  const adapter={transport:async()=>{throw new Error('Unexpected local transport');}};
  return {engine:create({core,adapter,chatgpt}),chatgpt,setAccount:value=>{account=value;},calls:()=>calls};
}
const settings={provider:'chatgpt',chatgptModel:'model-test',profile:'fast'};
const context={title:'测试文献',abstract:'这是一份测试摘要。',existingTags:[],fulltext:''};

test('cloud engine streams, validates and scopes cached results to the account and source',async()=>{
  const f=fixture(),progress=[];
  const first=await f.engine.generate(context,'tags',settings,null,{onProgress:event=>progress.push(event)});
  assert.equal(first.provider,'chatgpt');assert.equal(first.cacheHit,false);assert.deepEqual(first.tags,['测试']);
  assert.ok(progress.some(event=>event.stage==='streaming'));
  first.tags.push('edited preview');
  const cached=await f.engine.generate(context,'tags',settings);
  assert.equal(cached.cacheHit,true);assert.deepEqual(cached.tags,['测试']);assert.equal(f.calls(),1);
  await f.engine.generate({...context,abstract:'Changed evidence'},'tags',settings);assert.equal(f.calls(),2);
  f.setAccount({connected:true,accountId:'account-2'});
  await f.engine.generate(context,'tags',settings);assert.equal(f.calls(),3);
});

test('force refresh, disabled cache and explicit clearing bypass cached results',async()=>{
  const f=fixture();
  await f.engine.generate(context,'tags',settings);
  await f.engine.generate(context,'tags',settings,null,{forceRefresh:true});
  await f.engine.generate(context,'tags',{...settings,cacheEnabled:false});
  f.engine.clearCache();await f.engine.generate(context,'tags',settings);assert.equal(f.calls(),4);
});

test('subscription failures never fall back to local or separately billed API requests',async()=>{
  const f=fixture();f.setAccount({connected:false,accountId:null});
  await assert.rejects(f.engine.listModels(settings),/登录/);
  await assert.rejects(f.engine.generate(context,'tags',settings),/登录/);
  f.setAccount({connected:true,accountId:'account-1'});
  f.chatgpt.generate=async()=>{throw new Error('subscription quota reached');};
  await assert.rejects(f.engine.generate(context,'tags',settings),/quota/);assert.equal(f.calls(),0);
});

test('signout, malformed output and cancellation cannot become successful cached generations',async()=>{
  const f=fixture();
  f.chatgpt.generate=async()=>{f.setAccount({connected:false,accountId:null});return {text:'{"tags":["x"]}'};};
  await assert.rejects(f.engine.generate(context,'tags',settings),/账户/);
  f.setAccount({connected:true,accountId:'account-1'});f.chatgpt.generate=async()=>({text:'not json'});
  await assert.rejects(f.engine.generate(context,'tags',settings),/格式/);
  const abort=new AbortController();abort.abort();
  await assert.rejects(f.engine.generate(context,'tags',settings,abort.signal),{name:'AbortError'});
});

test('subscription model names are separate from the configured Ollama model',async()=>{
  const f=fixture();assert.deepEqual(await f.engine.listModels(settings),[{name:'model-test',label:'Available model'}]);
  await assert.rejects(f.engine.generate(context,'tags',{...settings,chatgptModel:''}),/选择/);
});
