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
  assert.equal(settings.contextTokens, 8192);
  assert.equal(settings.profile,'fast');
  assert.equal(settings.provider,'ollama');
  assert.equal(settings.cacheEnabled,true);
  assert.equal(settings.briefTarget, 'note');
  assert.equal(core.normalizeSettings({briefTarget:'style-and-note'}).briefTarget,'style-and-note');
  assert.equal(core.normalizeSettings({briefTarget:'overwrite-extra'}).briefTarget,'note');
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
  assert.deepEqual(result, {tags:['Deep learning','Graph'],note:'结果。',overview:null});
  assert.deepEqual(core.parseGeneration('{"note":"Note"}', 'note'), {tags:[],note:'Note',overview:null});
  assert.deepEqual(core.parseGeneration('{"tags":["Tag"]}', 'tags'), {tags:['Tag'],note:'',overview:null});
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

test('generation verifies local model and sends streaming JSON chat request', async () => {
  const calls=[];
  const transport=async request=>{
    calls.push(request);
    return request.url.endsWith('/api/show') ? {details:{family:'qwen3'}} : {message:{content:'{"tags":["A"],"note":"Evidence note."}'},model:'local:8b',done:true};
  };
  const result=await core.generate(transport,{title:'Paper',abstract:'Evidence'},'both',{model:'local:8b'});
  assert.equal(calls.length,2);
  assert.equal(calls[0].url,'http://127.0.0.1:11434/api/show');
  assert.equal(calls[1].body.stream,true);
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
    },{title:'Example'},'tags',{model:'local',profile:'custom',contextTokens:16384});
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
  },{title:'Paper',fulltext:'Evidence '.repeat(10000)},'note',{model:'local',profile:'custom',contextTokens:16384});
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

const overview = () => ({
  background:'摘要关注本地模型辅助文献管理。',
  question:'本地模型能否为文献生成可用标签？',
  methods:'材料未提供。',
  findings:'摘要说明可生成候选标签，未提供定量验证结果。',
  limitations:'仅有摘要，实验、样本量和误差数据均未提供。',
  relevance:'可作为本地文献整理工具的设计参考，效果仍需验证。',
});

test('modes select exactly the requested outputs and keep the legacy both meaning', () => {
  const expected = {
    tags:['tags'],note:['note'],both:['tags','note'],overview:['overview'],all:['tags','note','overview'],
  };
  for(const [mode, parts] of Object.entries(expected)) {
    assert.deepEqual(['tags','note','overview'].filter(part=>core.modeIncludes(mode,part)),parts);
    const prompt=core.buildMessages({title:'Title only'},mode)[0].content;
    const schema=JSON.parse(prompt.match(/Required schema: (.+)\. Include only the requested fields\./)[1]);
    assert.deepEqual(Object.keys(schema),parts);
    if(parts.includes('note'))assert.match(prompt,/15–40 Chinese characters/);
    if(parts.includes('overview')) {
      assert.deepEqual(Object.keys(schema.overview),core.OVERVIEW_FIELDS.map(field=>field.key));
      assert.match(prompt,/材料未提供/);
      assert.match(prompt,/single paper/);
    }
  }
  assert.throws(()=>core.modeIncludes('collection','overview'),/未知生成模式/);
  assert.throws(()=>core.modeIncludes('all','extra'),/未知生成内容/);
});

test('overview and all parse into explicit distinct outputs and ignore unrequested extras', () => {
  const value=overview();
  assert.deepEqual(core.parseGeneration(JSON.stringify({overview:value,tags:['unrequested'],note:'unrequested'}),'overview'),{tags:[],note:'',overview:value});
  assert.deepEqual(core.parseGeneration(JSON.stringify({overview:value,tags:['AI','ai'],note:' Short brief. '}),'all'),{tags:['AI'],note:'Short brief.',overview:value});
  assert.deepEqual(core.parseGeneration(JSON.stringify({overview:value,note:'brief'}),'note'),{tags:[],note:'brief',overview:null});
  assert.deepEqual(core.parseGeneration(JSON.stringify({overview:value,tags:['topic']}),'tags'),{tags:['topic'],note:'',overview:null});
});

test('incomplete, empty, non-text and active-markup overviews cannot become saved content', () => {
  for(const malformed of [null,[],{},'A summary',{...overview(),methods:''},{...overview(),question:42},{...overview(),findings:'<img src=x onerror=alert(1)>'},{...overview(),background:'x'.repeat(20001)}]) {
    assert.throws(()=>core.parseGeneration(JSON.stringify({overview:malformed}),'overview'));
  }
  for(const field of core.OVERVIEW_FIELDS) {
    const missing=overview();delete missing[field.key];
    assert.throws(()=>core.parseGeneration(JSON.stringify({overview:missing}),'overview'),/概览缺少/);
  }
  assert.throws(()=>core.parseGeneration(JSON.stringify({overview:overview(),note:'brief'}),'all'),/tags/);
  assert.throws(()=>core.parseGeneration(JSON.stringify({overview:overview(),tags:['topic']}),'all'),/简记/);
});

test('overview notes have six labeled sections and preserve escaped evidence provenance', () => {
  const value={...overview(),findings:'Reported A < B & C.\nNext line.'};
  const result={overview:value,model:'model<img src=x>',sourceInfo:{hasAbstract:true,hasFulltext:true,truncated:true,fulltextSource:'Paper <draft>.pdf'}};
  const html=core.renderOverviewNote(result,{title:'Paper',sourceWarnings:['Only <partial> PDF index available.']},{},{createdAt:'2026-11-12'});
  assert.match(html,/<h1>AI 概览<\/h1>/);
  assert.equal((html.match(/<h2>/g)||[]).length,6);
  assert.match(html,/Reported A &lt; B &amp; C\.<br \/>Next line\./);
  assert.match(html,/Paper &lt;draft&gt;.pdf/);
  assert.match(html,/Only &lt;partial&gt; PDF index available/);
  assert.match(html,/输入已截断/);
  assert.ok(!html.includes('<img'));
  const english=core.renderOverviewNote({overview:overview()},{title:'Paper'},{language:'en'});
  assert.match(english,/<h1>AI Overview<\/h1>/);
  assert.match(english,/<h2>Research question<\/h2>/);
  assert.throws(()=>core.renderOverviewNote({overview:null},{title:'Paper'},{}),/概览/);
});

test('overview generation uses local JSON chat with detailed output budget and evidence bounds', async () => {
  for(const mode of ['overview','all']) {
    const calls=[];
    const payload=mode==='all'?{tags:['local AI'],note:'A short evidence-based brief.',overview:overview()}:{overview:overview()};
    const result=await core.generate(async request=>{
      calls.push(request);
      return request.url.endsWith('/api/show')?{capabilities:['completion'],model_info:{'example.context_length':16384}}:{message:{content:JSON.stringify(payload)},model:'local:8b'};
    },{title:'Paper',abstract:'Only abstract evidence is available.',fulltext:'','sourceWarnings':['No PDF fulltext.']},mode,{model:'local:8b',profile:'custom',contextTokens:16384});
    assert.equal(calls.length,2);
    assert.equal(calls[1].body.options.num_predict,4096);
    assert.equal(calls[1].body.options.num_ctx,16384);
    assert.equal(calls[1].body.format,'json');
    assert.equal(calls[1].body.stream,true);
    assert.deepEqual(result.overview,overview());
    assert.equal(result.sourceInfo.hasFulltext,false);
    assert.equal(result.sourceInfo.hasAbstract,true);
    assert.deepEqual(result.sourceInfo.sourceWarnings,['No PDF fulltext.']);
    assert.ok(Buffer.byteLength(calls[1].body.messages.map(message=>message.content).join('\n'))+calls[1].body.options.num_predict+64<=16384);
    if(mode==='overview'){assert.deepEqual(result.tags,[]);assert.equal(result.note,'');}
  }
});

test('task presets lower local memory and input work while custom values remain explicit', () => {
  for(const mode of ['tags','note','both']) {
    const value=core.effectiveSettings({contextTokens:32768,maxInputChars:90000,includeFulltext:true},mode);
    assert.equal(value.contextTokens,4096);
    assert.equal(value.maxInputChars,4000);
    assert.equal(value.includeFulltext,false);
    assert.deepEqual(core.effectiveSettings(value,mode),value);
  }
  for(const mode of ['overview','all']) {
    const value=core.effectiveSettings({},mode);
    assert.equal(value.contextTokens,8192);
    assert.equal(value.maxInputChars,8000);
    assert.equal(value.includeFulltext,false);
  }
  assert.equal(core.effectiveSettings({profile:'balanced'},'tags').includeFulltext,true);
  assert.equal(core.effectiveSettings({profile:'balanced'},'tags').maxInputChars,12000);
  const custom=core.effectiveSettings({profile:'custom',contextTokens:32768,maxInputChars:10000,includeFulltext:true},'note');
  assert.equal(custom.contextTokens,32768);
  assert.equal(custom.maxInputChars,10000);
  assert.equal(custom.includeFulltext,true);
  const cloud=core.normalizeSettings({provider:'chatgpt',chatgptModel:' selected ',cacheEnabled:'false',keepAliveMinutes:100});
  assert.equal(cloud.provider,'chatgpt');assert.equal(cloud.chatgptModel,'selected');
  assert.equal(cloud.cacheEnabled,false);assert.equal(cloud.keepAliveMinutes,30);
});

test('in-memory cache clones data, expires entries and evicts the least-recently-used value', () => {
  let time=10;
  const cache=core.createGenerationCache({maxEntries:2,ttlMs:20,now:()=>time});
  const original={tags:['A'],overview:{methods:'Evidence'}};
  cache.set('a',original);original.tags.push('mutation');
  assert.deepEqual(cache.get('a').tags,['A']);
  const retrieved=cache.get('a');retrieved.overview.methods='mutation';
  assert.equal(cache.get('a').overview.methods,'Evidence');
  cache.set('b',{note:'B'});cache.get('a');cache.set('c',{note:'C'});
  assert.equal(cache.get('b'),undefined);
  assert.equal(cache.size,2);
  time=30;
  assert.equal(cache.get('a'),undefined);assert.equal(cache.size,0);
  cache.set('d',{note:'D'});cache.clear();assert.equal(cache.size,0);
});

test('cache keys separate providers, model, evidence, mode and writing preferences without storing credentials', () => {
  const context={title:'Paper',abstract:'Original abstract',styleRemark:'Private previous remark',existingTags:['A']};
  const settings={model:'local',profile:'custom'};
  const key=core.generationCacheKey(context,'both',settings);
  for(const modified of [{...settings,model:'other'},{...settings,provider:'chatgpt',chatgptModel:'other'},
    {...settings,instructions:'different'},{...settings,language:'en'},{...settings,maxTags:2},
    {...settings,contextTokens:4096},{...settings,includeFulltext:false}]) {
    assert.notEqual(core.generationCacheKey(context,'both',modified),key);
  }
  assert.notEqual(core.generationCacheKey({...context,abstract:'Changed'},'both',settings),key);
  assert.notEqual(core.generationCacheKey({...context,existingTags:['B']},'both',settings),key);
  assert.notEqual(core.generationCacheKey(context,'note',settings),key);
  assert.equal(core.generationCacheKey({...context,styleRemark:'Changed write state'},'both',settings),key);
  assert.equal(core.generationCacheKey(context,'both',{...settings,accessToken:'sensitive-token',refreshToken:'private-refresh'}),key);
  assert.ok(!key.includes('Private previous remark'));
  assert.equal(core.generationCacheKey({...context,fulltext:'excluded A'},'note',{model:'local'}),
    core.generationCacheKey({...context,fulltext:'excluded B'},'note',{model:'local'}));
});

function streamText(content, metrics={}) {
  return [JSON.stringify({model:'local',message:{role:'assistant',thinking:'Do not reveal this reasoning',content:content.slice(0,9)},done:false}),
    JSON.stringify({model:'local',message:{role:'assistant',content:content.slice(9)},done:false}),
    JSON.stringify({model:'local',message:{role:'assistant',content:''},done:true,done_reason:'stop',...metrics})].join('\r\n')+'\n';
}

test('stream decoder handles arbitrary chunk boundaries and keeps reasoning out of answer text', () => {
  const answer=JSON.stringify({note:'中文😀简记，包含换行转义\n与引号"。'});
  const raw=streamText(answer);
  const previews=[];
  const decoder=core.createOllamaStreamDecoder(frame=>previews.push(frame.text));
  for(let index=0;index<raw.length;index+=3)decoder.push(raw.slice(index,index+3));
  assert.equal(decoder.finish().message.content,answer);
  assert.ok(previews.every(value=>!value.includes('Do not reveal')));
  assert.equal(decoder.frameCount,3);
});

test('stream decoder refuses errors, malformed lines, remote responses and incomplete output', () => {
  for(const raw of [
    '{"message":{"content":"partial"},"done":false}\n',
    '{broken}\n',
    '{"error":"bad model"}\n',
    '{"remote_host":"https://remote","done":true,"message":{"content":"x"}}\n',
    '{"done":true,"done_reason":"length","message":{"content":"x"}}\n',
    '{"done":true,"message":{"content":""}}\n',
    '{"done":true,"message":{"content":"x"}}\n{"done":true}\n',
  ]) {
    const decoder=core.createOllamaStreamDecoder();
    assert.throws(()=>{decoder.push(raw);decoder.finish();},undefined,raw);
  }
});

test('streamed local generation reports actual metrics and reduced fast-task budgets', async () => {
  const output=JSON.stringify({tags:['Topic'],note:'Evidence-based brief.'});
  const raw=streamText(output,{eval_count:20,eval_duration:500000000,load_duration:250000000,prompt_eval_count:60});
  const requests=[],events=[];
  const transport=async request=>{
    requests.push(request);
    if(request.url.endsWith('/api/show'))return {capabilities:['completion']};
    for(let index=0;index<raw.length;index+=5)request.onChunk(raw.slice(index,index+5));
    return raw;
  };
  const result=await core.generate(transport,{title:'Paper',abstract:'Evidence',fulltext:'ignored PDF'},'both',{model:'local'},undefined,{onProgress:event=>events.push(event)});
  assert.equal(requests[1].stream,true);
  assert.equal(requests[1].body.stream,true);
  assert.equal(requests[1].body.options.num_ctx,4096);
  assert.equal(requests[1].body.options.num_predict,512);
  assert.equal(requests[1].body.keep_alive,'10m');
  assert.equal(result.note,'Evidence-based brief.');
  assert.equal(result.sourceInfo.hasFulltext,false);
  assert.equal(result.stats.outputTokens,20);assert.equal(result.stats.inputTokens,60);
  assert.equal(result.stats.generationMs,500);assert.equal(result.stats.loadMs,250);
  assert.equal(result.stats.tokensPerSecond,40);assert.equal(result.cacheHit,false);
  assert.equal(result.provider,'ollama');
  assert.ok(events.some(event=>event.stage==='streaming'));
  assert.ok(events.every(event=>!JSON.stringify(event).includes('Do not reveal')));
});

test('final raw body supplies missing progress tail without duplicating streamed answer content', async () => {
  for(const prefixLength of [0,17]) {
    const raw=streamText('{"note":"Completed"}');
    const result=await core.generate(async request=>{
      if(request.url.endsWith('/api/show'))return {};
      if(prefixLength)request.onChunk(raw.slice(0,prefixLength));
      return raw;
    },{title:'Paper'},'note',{model:'local'});
    assert.equal(result.note,'Completed');
  }
});

test('identical successful generations are cached without model calls or editable-result mutation', async () => {
  let chats=0,shows=0;
  const transport=async request=>{
    if(request.url.endsWith('/api/show')){shows++;return {};}
    chats++;return streamText('{"tags":["Topic"],"note":"Original"}');
  };
  const context={title:'Cache paper'},settings={model:'local'};
  const first=await core.generate(transport,context,'both',settings);
  first.tags.push('Edited');first.note='User draft';
  const events=[];
  const second=await core.generate(transport,context,'both',settings,undefined,{onProgress:event=>events.push(event)});
  assert.equal(second.cacheHit,true);assert.equal(second.note,'Original');
  assert.deepEqual(second.tags,['Topic']);assert.equal(chats,1);assert.equal(shows,1);
  assert.ok(events.some(event=>event.stage==='cache-hit'));
  await core.generate(transport,{title:'Changed paper'},'both',settings);
  assert.equal(chats,2);assert.equal(shows,1,'model info may be reused briefly across document inputs');
  await core.generate(transport,context,'both',settings,undefined,{forceRefresh:true});
  assert.equal(chats,3);assert.equal(shows,2);
  core.clearCache();
  await core.generate(transport,context,'both',settings);
  assert.equal(chats,4);assert.equal(shows,3);
});

test('disabled, failed and cancelled generations do not populate reusable result cache', async () => {
  const cache=core.createGenerationCache();
  let chats=0;
  const transport=async request=>{
    if(request.url.endsWith('/api/show'))return {};
    chats++;return streamText('{"note":"OK"}');
  };
  for(let index=0;index<2;index++)await core.generate(transport,{title:'Disabled'},'note',{model:'local',cacheEnabled:false},undefined,{cache});
  assert.equal(chats,2);assert.equal(cache.size,0);
  await assert.rejects(()=>core.generate(async request=>request.url.endsWith('/api/show')?{}:'{"message":{"content":"partial"},"done":false}\n',{title:'Failed'},'note',{model:'local'},undefined,{cache}),/提前结束/);
  assert.equal(cache.size,0);
  const controller=new AbortController();
  await assert.rejects(()=>core.generate(async request=>{
    if(request.url.endsWith('/api/show'))return {};
    controller.abort();return streamText('{"note":"Aborted"}');
  },{title:'Cancelled'},'note',{model:'local'},controller.signal,{cache}),{name:'AbortError'});
  assert.equal(cache.size,0);
});

test('ChatGPT settings cannot silently enter local generation and provenance labels the selected engine', async () => {
  let calls=0;
  await assert.rejects(()=>core.generate(async()=>{calls++;return {};},{title:'Cloud'},'note',{provider:'chatgpt',chatgptModel:'selected',model:'local'}),/官方授权/);
  assert.equal(calls,0);
  const settings={provider:'chatgpt',chatgptModel:'selected'};
  const html=core.renderNote({note:'Cloud brief',provider:'chatgpt'},{title:'Paper'},settings);
  assert.match(html,/ChatGPT 订阅 · selected/);
  assert.ok(!html.includes('本地 Ollama'));
  assert.ok(!core.buildMessages({title:'Paper'},'note',settings)[0].content.includes('running locally'));
});
