const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../addon/content/core.js');

test('endpoint only accepts literal loopback origins', () => {
  assert.equal(core.validateEndpoint('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434');
  assert.equal(core.validateEndpoint('https://LOCALHOST:11434'), 'https://localhost:11434');
  assert.equal(core.validateEndpoint('http://[::1]:11434'), 'http://[::1]:11434');
  for (const endpoint of ['https://example.org', 'http://127.1:11434', 'http://2130706433:11434', 'http://127.0.0.1.evil.test', 'file:///tmp/models', 'http://localhost/a', 'http://a@localhost', 'http://localhost?model=x', 'http://localhost#x', 'http://localhost\\@evil.test']) {
    assert.throws(() => core.validateEndpoint(endpoint), undefined, endpoint);
  }
});

test('settings normalize bounds and preserve explicit preferences', () => {
  const settings = core.normalizeSettings({ maxTags: 1000, maxInputChars: -1, timeoutSeconds: Infinity, includeFulltext: false, temperature: -1, model: ' qwen3:8b ', language: 'en' });
  assert.equal(settings.maxTags, 20);
  assert.equal(settings.maxInputChars, 2000);
  assert.equal(settings.timeoutSeconds, 180);
  assert.equal(settings.includeFulltext, false);
  assert.equal(settings.temperature, 0);
  assert.equal(settings.model, 'qwen3:8b');
  assert.equal(settings.language, 'en');
  assert.equal(settings.contextTokens, 16384);
  assert.equal(core.normalizeSettings({contextTokens:1024}).contextTokens,4096);
  assert.equal(core.normalizeSettings({contextTokens:999999}).contextTokens,131072);
});

test('messages preserve evidence boundaries and report truncated input', () => {
  const messages = core.buildMessages({title:'Example',abstract:'a'.repeat(1000),fulltext:'b'.repeat(4000),existingTags:['Known']}, 'both', {maxInputChars:2000});
  const prompt = JSON.parse(messages[1].content);
  assert.equal(prompt.evidence.truncated, true);
  assert.equal(prompt.evidence.hasAbstract, true);
  assert.equal(prompt.evidence.hasFulltext, true);
  assert.equal(prompt.evidence.inputChars, 2000);
  assert.equal(prompt.document.abstract.length, 1000);
  assert.ok(messages[0].content.includes('untrusted source'));
  assert.ok(messages[0].content.includes('简体中文'));
});

test('fulltext is omitted when disabled and metadata-only evidence is explicit', () => {
  const prompt = JSON.parse(core.buildMessages({title:'Test',fulltext:'secret fulltext'}, 'tags', {includeFulltext:false})[1].content);
  assert.equal(prompt.document.fulltext, '');
  assert.equal(prompt.evidence.hasFulltext, false);
  assert.equal(prompt.evidence.hasAbstract, false);
  assert.throws(() => core.buildMessages({}, 'note'));
  assert.throws(() => core.buildMessages({title:'a'}, 'wrong'));
});

test('model results accept fenced JSON and deduplicate tags', () => {
  const result = core.parseGeneration('<think>ignored private reasoning</think>\n```json\n{"tags":[" Deep learning ","deep LEARNING","Graph","Other"],"note":"结果。"}\n```','both',{maxTags:2});
  assert.deepEqual(result, {tags:['Deep learning','Graph'],note:'结果。'});
  assert.deepEqual(core.parseGeneration('{"note":"Note"}', 'note'), {tags:[],note:'Note'});
  assert.deepEqual(core.parseGeneration('{"tags":["Tag"]}', 'tags'), {tags:['Tag'],note:''});
});

test('invalid or dangerous model results never become successful empty writes', () => {
  for (const output of ['', '[]', 'null', '{}', 'prefix {"tags":["a"]}', '{"tags":[1]}', '{"tags":[]}', '{"tags":["<img src=x>"]}']) {
    assert.throws(() => core.parseGeneration(output,'tags'));
  }
  for (const output of ['{"note":""}', '{"note":7}', '{"note":"<script>alert(1)</script>"}']) assert.throws(() => core.parseGeneration(output,'note'));
});

test('rendered notes escape model text and provenance without adding active markup', () => {
  const html = core.renderNote({note:'A & B < C\nnext\n\nSecond',model:'model<img src=x>'},{title:'X',abstract:'a'}, {}, {createdAt:'2026-11-12',sourceInfo:{hasAbstract:true,truncated:true}});
  assert.ok(html.includes('A &amp; B &lt; C<br />next'));
  assert.ok(html.includes('model&lt;img src=x&gt;'));
  assert.ok(html.includes('输入已截断'));
  assert.ok(html.includes('标题、元数据及摘要'));
  assert.ok(!html.includes('<img'));
});

test('PDF index coverage warnings and attachment names survive in prompts and notes', () => {
  const context={title:'X',fulltext:'Cache text',fulltextSource:'本地 PDF：Paper <draft>.pdf',sourceWarnings:['PDF 索引可能仅涵盖部分页；检查 <all> 页。']};
  const settings={model:'local'};
  const evidence=JSON.parse(core.buildMessages(context,'note',settings)[1].content).evidence;
  assert.equal(evidence.fulltextSource,context.fulltextSource);
  assert.deepEqual(evidence.sourceWarnings,context.sourceWarnings);
  const note=core.renderNote({note:'A reading note',sourceInfo:evidence},context,settings);
  assert.match(note,/附件来源：本地 PDF：Paper &lt;draft&gt;.pdf/);
  assert.match(note,/索引可能仅涵盖部分页/);
  assert.ok(note.includes('&lt;all&gt;'));
  assert.ok(!note.includes('<all>'));
});

test('tag merging preserves existing values and removes case/fullwidth duplicates', () => {
  assert.deepEqual(core.mergeTags([{tag:'Existing',type:0},{tag:'ＡＩ'}],['existing','AI','New']), ['Existing','AI','New']);
});

test('model listing filters cloud models and aliases with remote metadata', async () => {
  const calls=[];
  const models=await core.listModels(async request => { calls.push(request); return {models:[{name:'qwen3:8b',size:10},{name:'foo:cloud'},{name:'alias',remote_host:'https://ollama.com'},{name:'alias2',details:{remote_model:'big'}},{name:123}]}; });
  assert.deepEqual(models.map(model=>model.name),['qwen3:8b']);
  assert.equal(calls[0].url,'http://127.0.0.1:11434/api/tags');
  assert.equal(calls[0].method,'GET');
});

test('generation verifies local model and sends nonstreaming JSON chat request', async () => {
  const calls=[];
  const transport=async request=>{
    calls.push(request);
    return request.url.endsWith('/api/show') ? {details:{family:'qwen3'}} : {message:{content:'{"tags":["A"],"note":"Evidence note."}'},model:'local:8b',done:true};
  };
  const result=await core.generate(transport,{title:'Paper',abstract:'Evidence'},'both',{model:'local:8b'});
  assert.equal(calls.length,2);
  assert.equal(calls[0].url,'http://127.0.0.1:11434/api/show');
  assert.equal(calls[1].body.stream,false);
  assert.equal(calls[1].body.format,'json');
  assert.equal(calls[1].body.model,'local:8b');
  assert.equal(result.note,'Evidence note.');
  assert.equal(result.sourceInfo.hasAbstract,true);
});

test('cloud models, cancellations and truncated generations fail before applying data', async () => {
  let calls=0;
  await assert.rejects(()=>core.generate(async()=>{calls++;return {};},{title:'A'},'note',{model:'foo:cloud'}), /本地模型/);
  assert.equal(calls,0);
  await assert.rejects(()=>core.generate(async()=>({remote_model:'big'}),{title:'A'},'note',{model:'alias'}), /云端/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(()=>core.generate(async()=>({}),{title:'A'},'note',{model:'local'},controller.signal), {name:'AbortError'});
  await assert.rejects(()=>core.generate(async r=>r.url.endsWith('/api/show')?{}:{message:{content:'{"note":"partial"}'},done_reason:'length'},{title:'A'},'note',{model:'local'}), /长度上限/);
});

test('thinking controls use advertised supported values and legacy Qwen3 capabilities', async () => {
  for (const [show, expected, budget] of [
    [{capabilities:['completion','thinking'],thinking:{values:[true,false]}},false,512],
    [{capabilities:['completion','thinking'],thinking:{values:['low','medium','high']}},'low',4096],
    [{capabilities:['completion','thinking'],thinking:{values:[true]},details:{family:'qwen3'}},undefined,4096],
    [{capabilities:['completion','thinking'],details:{family:'qwen3'}},false,512],
    [{capabilities:['completion','thinking'],details:{family:'gptoss'}},undefined,4096],
    [{capabilities:['completion']},undefined,512],
  ]) {
    let sent;
    await core.generate(async request=>{
      if(request.url.endsWith('/api/show')) return show;
      sent=request.body;
      return {message:{content:'{"tags":["topic"]}'}};
    },{title:'Example'},'tags',{model:'local'});
    assert.equal(sent.think,expected);
    assert.equal(sent.options.num_predict,budget);
  }
});

test('context requests respect the model advertised limit and cap reasoning output', async () => {
  let sent;
  const result=await core.generate(async request=>{
    if(request.url.endsWith('/api/show')) return {capabilities:['completion','thinking'],thinking:{values:[true]},model_info:{'general.architecture':'example','example.context_length':4096}};
    sent=request.body;
    return {message:{content:'{"note":"Note"}'}};
  },{title:'Paper',fulltext:'Evidence '.repeat(10000)},'note',{model:'local',contextTokens:16384});
  assert.equal(sent.options.num_ctx,4096);
  assert.ok(sent.options.num_predict<=Math.max(512,Math.floor(4096/3)));
  assert.equal(result.sourceInfo.contextTokens,4096);
  assert.equal(result.sourceInfo.requestedContextTokens,16384);
  assert.equal(result.sourceInfo.truncated,true);
  assert.ok(Buffer.byteLength(sent.messages.map(message=>message.content).join(''))+sent.options.num_predict<=4096);
});

test('UTF-8 source budget bounds Chinese, emoji and JSON escapes without cutting codepoints', () => {
  const messages=core.buildMessages({title:'汉😀abc',abstract:'汉字'.repeat(100)},'note',{},10);
  const payload=JSON.parse(messages[1].content);
  assert.equal(payload.document.title,'汉😀abc');
  assert.equal(payload.document.abstract,'');
  assert.equal(payload.evidence.inputBytes,10);
  assert.equal(payload.evidence.truncated,true);
  const escaped=JSON.parse(core.buildMessages({title:'"\\\n'.repeat(50)},'note',{},13)[1].content);
  assert.ok(Buffer.byteLength(JSON.stringify(escaped.document.title))-2<=13);
});

test('small advertised contexts remain usable and oversized writing instructions fail clearly', async () => {
  let sent;
  const transport=async request=>{
    if(request.url.endsWith('/api/show')) return {model_info:{'example.context_length':2048}};
    sent=request.body;
    return {message:{content:'{"note":"Note"}'}};
  };
  await core.generate(transport,{title:'Paper'},'note',{model:'local'});
  assert.equal(sent.options.num_ctx,2048);
  assert.equal(sent.options.num_predict,512);
  assert.ok(Buffer.byteLength(sent.messages.map(message=>message.content).join(''))+512<=2048);
  await core.generate(transport,{title:'P',existingTags:Array.from({length:50},(_,index)=>String(index))},'note',{model:'local'});
  assert.ok(Buffer.byteLength(sent.messages.map(message=>message.content).join('\n'))+sent.options.num_predict+64<=2048);
  await assert.rejects(()=>core.generate(transport,{title:'Paper'},'note',{model:'local',instructions:'额外要求'.repeat(1000)}),/上下文不足/);
});
