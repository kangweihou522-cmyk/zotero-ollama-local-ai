/* Chromium exercises the real dialog DOM, styles, scripts and core using a mocked Zotero bridge. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const root = path.resolve(__dirname,'../addon/content');

async function setup(t, mode='both') {
  const executablePath=process.env.CHROMIUM_PATH||(fs.existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined);
  const browser = await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
  t.after(()=>browser.close());
  const page = await browser.newPage({viewport:{width:1080,height:850}});
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  // Only the XUL outer window is replaced; controls are the shipped XHTML.
  const xml = fs.readFileSync(path.join(root,'dialog.xhtml'),'utf8');
  const markup = xml.match(/<h:main[\s\S]*<\/h:main>/)[0].replace(/(<\/?)(?:h:)/g,'$1')
    .replace(/<(textarea|select|span|p)([^>]*?)\/>/g,'<$1$2></$1>')
    .replace('src="icon.svg"','src="data:image/svg+xml;base64,'+fs.readFileSync(path.join(root,'icon.svg')).toString('base64')+'"');
  await page.setContent('<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"/></head><body style="margin:0">'+markup+'</body></html>');
  await page.addStyleTag({path:path.join(root,'dialog.css')});
  await page.addScriptTag({path:path.join(root,'core.js')});
  await page.addScriptTag({path:path.join(root,'engine.js')});
  await page.evaluate(({mode})=>{
    const core=window.OllamaLocalCore;
    let settings=core.normalizeSettings({model:'qwen3:4b'});
    window.TEST={saves:[],requests:[],contextSettings:[],block:false,failSave:false,remarks:{},loggedIn:false,cloudCalls:0,quota:false,pauseStream:false};
    const answer=()=>({tags:['本地模型','文献管理'],note:'本地语言模型辅助文献整理。',overview:{background:'文献数量增长带来整理需求。',question:'如何使用本地语言模型辅助文献整理？',methods:'材料未提供具体实验方法。',findings:'摘要只提出应用目标，没有给出实验数据。',limitations:'本次仅提供摘要，无法判断实验可靠性。',relevance:'可作为本地文献管理工具设计的参考。'}});
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const adapter={
      loadSettings:()=>({...settings}),saveSettings:raw=>(settings=core.normalizeSettings(raw)),
      getItem:async id=>({id}),
      collectContext:async(item,effective)=>{window.TEST.contextSettings.push(effective);return {title:window.TEST.sameSource?'相同材料':'文献 '+item.id,abstract:'研究使用本地语言模型整理文献。',authors:['张三'],existingTags:['文献管理'],fulltext:'',styleRemark:window.TEST.remarks[item.id]??null,sourceWarnings:['仅使用标题和摘要。']};},
      getRuntimeInfo:async()=>({isLoaded:true,selectedModel:{name:'qwen3:4b',processor:'gpu',gpuFraction:1}}),
      transport:async request=>{
        window.TEST.requests.push(request);
        if(request.url.endsWith('/api/tags'))return {models:[{name:'qwen3:4b'},{name:'cloud:cloud'}]};
        if(request.url.endsWith('/api/show'))return {capabilities:['completion','thinking'],thinking:{values:[true,false]}};
        if(window.TEST.block)await new Promise((resolve,reject)=>{
          if(request.signal.aborted)return reject(new Error('cancelled'));
          request.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});
        });
        const text=JSON.stringify(answer()),frames=[];
        for(let i=0;i<text.length;i+=55)frames.push({model:'qwen3:4b',message:{content:text.slice(i,i+55)},done:false});
        frames.push({model:'qwen3:4b',message:{content:''},done:true,done_reason:'stop',eval_count:100,eval_duration:2000000000,load_duration:100000000,prompt_eval_count:50});
        const lines=frames.map(frame=>JSON.stringify(frame)+'\n');
        for(let i=0;i<lines.length;i++){
          request.onChunk?.(lines[i]);
          if(i===0&&window.TEST.pauseStream){await new Promise(resolve=>{window.TEST.releaseStream=resolve;});window.TEST.pauseStream=false;}
          if(request.signal?.aborted){const error=new Error('cancelled');error.name='AbortError';throw error;}
          await wait(2);
        }
        return lines.join('');
      },
      saveResult:async(...args)=>{
        if(window.TEST.failSave)throw new Error('模拟只读或暂时写入失败');
        if(core.modeIncludes(args[4],'note')&&args[3].briefTarget==='style-and-note'&&args[2].styleRemark&&!args[5]?.allowStyleOverwrite)throw new Error('已有 Style 简记，请勾选允许更新');
        window.TEST.saves.push(args);return {addedTags:args[1].tags,noteID:100+args[0]};
      }
    };
    const status=async()=>({connected:window.TEST.loggedIn,accountId:window.TEST.loggedIn?'mock-account':'',accountLabel:'测试订阅账户',accounts:window.TEST.loggedIn?[{id:'mock-account',label:'测试订阅账户',connected:true}]:[]});
    const chatgpt={
      status,login:async()=>{await wait(10);window.TEST.loggedIn=true;return status();},logout:async()=>{window.TEST.loggedIn=false;return {...await status(),message:'已清除本地登录。'};},
      selectAccount:async()=>status(),dispose(){},
      listModels:async()=>{if(!window.TEST.loggedIn)throw new Error('请先登录');return [{id:'account-model',name:'账户可用模型'}];},
      generate:async request=>{window.TEST.cloudCalls++;if(window.TEST.quota)throw new Error('ChatGPT 订阅额度达到限制');const text=JSON.stringify(answer());for(let i=0;i<text.length;i+=60){request.onDelta?.(text.slice(i,i+60));await wait(2);}return {text,model:'account-model'};}
    };
    const engine=window.OllamaGenerationEngine.create({core,adapter,chatgpt});
    window.arguments=[{core,adapter,engine,version:'0.3.0',hostVersion:'10.0.8',mode,settingsPage:false,items:[{id:1,title:'本地语言模型与文献整理'},{id:2,title:'学术标签生成的可靠性研究'}]}];
    window.TEST.clearCache=()=>engine.clearCache();
  },{mode});
  await page.addScriptTag({path:path.join(root,'dialog.js')});
  return {page,errors};
}

test('generate, edit, switch items, save all and prevent duplicate saves',async t=>{
  const {page,errors}=await setup(t);
  await page.click('#generate');
  await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('2 篇待保存'));
  assert.equal(await page.locator('#save-all').isEnabled(),true);
  await page.selectOption('#items','0');
  await page.fill('#result-tags','自定义标签\n本地模型');
  await page.fill('#result-note','我核对后的简记。\n\n保留研究局限。');
  await page.selectOption('#items','1');
  await page.selectOption('#items','0');
  assert.match(await page.inputValue('#result-note'),/我核对后/);
  await page.click('#save-all');
  await page.waitForFunction(()=>document.getElementById('notice').textContent.startsWith('已保存 2 篇'));
  const saves=await page.evaluate(()=>window.TEST.saves);
  assert.equal(saves.length,2);
  assert.deepEqual(saves[0][1].tags,['自定义标签','本地模型']);
  assert.match(saves[0][1].note,/我核对后/);
  assert.equal(await page.locator('#save-all').isDisabled(),true);
  assert.deepEqual(errors,[]);
  if(process.env.UI_SCREENSHOT)await page.screenshot({path:process.env.UI_SCREENSHOT,fullPage:true});
});

test('connection/model settings and tags-only mode preserve selected mode',async t=>{
  const {page,errors}=await setup(t,'tags');
  assert.equal(await page.locator('#note-area').isVisible(),false);
  await page.click('#tab-settings');
  await page.click('#refresh-models');
  await page.waitForFunction(()=>document.getElementById('connection-status').textContent.includes('1 个本地模型'));
  await page.click('#save-settings');
  await page.click('#tab-generate');
  await page.click('#generate');
  await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('2 篇待保存'));
  await page.click('#save-current');
  await page.waitForFunction(()=>window.TEST.saves.length===1);
  assert.equal(await page.evaluate(()=>window.TEST.saves[0][4]),'tags');
  assert.equal(await page.locator('#note-area').isVisible(),false);
  assert.deepEqual(errors,[]);
});

test('cancelling generation aborts request, leaves library untouched and permits retry',async t=>{
  const {page,errors}=await setup(t);
  await page.evaluate(()=>{window.TEST.block=true;});
  await page.click('#generate');
  await page.waitForFunction(()=>window.TEST.requests.some(request=>request.url.endsWith('/api/chat')));
  await page.click('#cancel');
  await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('已停止'));
  assert.equal(await page.evaluate(()=>window.TEST.saves.length),0);
  assert.equal(await page.locator('#generate').isEnabled(),true);
  await page.evaluate(()=>{window.TEST.block=false;});
  await page.click('#generate');
  await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('2 篇待保存'));
  assert.deepEqual(errors,[]);
});

test('failed saves retain edited draft and can be retried',async t=>{
  const {page,errors}=await setup(t,'note');
  await page.click('#generate');
  await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('2 篇待保存'));
  await page.fill('#result-note','修改过且不应丢失的简记。');
  await page.evaluate(()=>{window.TEST.failSave=true;});
  await page.click('#save-current');
  await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('模拟只读'));
  assert.equal(await page.inputValue('#result-note'),'修改过且不应丢失的简记。');
  await page.evaluate(()=>{window.TEST.failSave=false;});
  await page.click('#save-current');
  await page.waitForFunction(()=>window.TEST.saves.length===1);
  assert.equal(await page.evaluate(()=>window.TEST.saves[0][1].note),'修改过且不应丢失的简记。');
  assert.deepEqual(errors,[]);
});

test('overview-only edits survive switching and save as overview without tags or brief',async t=>{
  const {page,errors}=await setup(t,'overview');
  assert.equal(await page.locator('#tags-area').isVisible(),false);
  assert.equal(await page.locator('#note-area').isVisible(),false);
  await page.click('#generate');
  await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('2 篇待保存'));
  await page.selectOption('#items','0');
  await page.fill('#overview-findings','我核对后的主要发现，不添加原文没有的数据。');
  await page.selectOption('#items','1');
  await page.selectOption('#items','0');
  assert.match(await page.inputValue('#overview-findings'),/我核对后/);
  await page.click('#save-current');
  await page.waitForFunction(()=>window.TEST.saves.length===1);
  const saved=await page.evaluate(()=>window.TEST.saves[0]);
  assert.equal(saved[4],'overview');
  assert.match(saved[1].overview.findings,/我核对后/);
  assert.deepEqual(saved[1].tags,[]);
  assert.equal(saved[1].note,'');
  assert.deepEqual(errors,[]);
});

test('all mode previews and saves three distinct outputs',async t=>{
  const {page,errors}=await setup(t,'all');
  await page.click('#generate');
  await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('2 篇待保存'));
  assert.equal(await page.locator('#tags-area').isVisible(),true);
  assert.equal(await page.locator('#note-area').isVisible(),true);
  assert.equal(await page.locator('#overview-area').isVisible(),true);
  assert.match(await page.inputValue('#overview-methods'),/材料未提供/);
  if(process.env.UI_SCREENSHOT)await page.screenshot({path:process.env.UI_SCREENSHOT,fullPage:true});
  await page.click('#save-all');
  await page.waitForFunction(()=>window.TEST.saves.length===2);
  const saved=await page.evaluate(()=>window.TEST.saves[0]);
  assert.equal(saved[4],'all');
  assert.equal(saved[1].tags.length,2);
  assert.match(saved[1].note,/本地语言模型/);
  assert.equal(Object.keys(saved[1].overview).length,6);
  assert.equal(saved[3].briefTarget,'note');
  assert.deepEqual(errors,[]);
});

test('Style integration is opt-in and overwrite permission is kept per item',async t=>{
  const {page,errors}=await setup(t,'note');
  await page.evaluate(()=>{window.TEST.remarks={1:'第一篇原有简记',2:'第二篇原有简记'};});
  await page.click('#generate');
  await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('2 篇待保存'));
  assert.equal(await page.locator('#style-preview').isVisible(),false);
  await page.selectOption('#brief-target','style-and-note');
  assert.match(await page.locator('#existing-style-remark').textContent(),/第二篇原有简记/);
  await page.click('#save-current');
  await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('勾选允许更新'));
  assert.equal(await page.evaluate(()=>window.TEST.saves.length),0);
  await page.check('#allow-style-overwrite');
  await page.selectOption('#items','0');
  assert.equal(await page.locator('#allow-style-overwrite').isChecked(),false);
  await page.selectOption('#items','1');
  assert.equal(await page.locator('#allow-style-overwrite').isChecked(),true);
  await page.click('#save-all');
  await page.waitForFunction(()=>window.TEST.saves.length===1);
  const saved=await page.evaluate(()=>window.TEST.saves[0]);
  assert.equal(saved[0],2);
  assert.equal(saved[3].briefTarget,'style-and-note');
  assert.equal(saved[5].allowStyleOverwrite,true);
  assert.deepEqual(errors,[]);
});

test('fast task presets reduce context before collecting evidence and custom settings remain editable',async t=>{
  const {page,errors}=await setup(t,'both');
  await page.click('#tab-settings');
  assert.equal(await page.inputValue('#context-tokens'),'4096');
  assert.equal(await page.inputValue('#max-input'),'4000');
  assert.equal(await page.locator('#include-fulltext').isChecked(),false);
  assert.equal(await page.locator('#context-tokens').isDisabled(),true);
  await page.selectOption('#profile','custom');
  assert.equal(await page.locator('#context-tokens').isEnabled(),true);
  await page.selectOption('#context-tokens','8192');
  await page.fill('#max-input','6000');await page.check('#include-fulltext');
  await page.click('#tab-generate');await page.click('#generate');
  await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('2 篇待保存'));
  const effective=await page.evaluate(()=>window.TEST.contextSettings[0]);
  assert.equal(effective.contextTokens,8192);assert.equal(effective.maxInputChars,6000);assert.equal(effective.includeFulltext,true);
  assert.deepEqual(errors,[]);
});

test('stream preview shows readable partial output before a result can be saved',async t=>{
  const {page,errors}=await setup(t,'both');
  await page.evaluate(()=>{window.TEST.pauseStream=true;});await page.click('#generate');
  await page.waitForFunction(()=>Boolean(window.TEST.releaseStream));
  assert.equal(await page.locator('#live-area').isVisible(),true);
  const preview=await page.locator('#live-output').textContent();
  assert.match(preview,/标签|简记/);assert.doesNotMatch(preview,/^\s*\{/);
  assert.equal(await page.locator('#save-current').isDisabled(),true);
  assert.equal(await page.inputValue('#result-note'),'');
  await page.evaluate(()=>window.TEST.releaseStream());
  await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('2 篇待保存'));
  assert.equal(await page.locator('#live-area').isVisible(),false);
  assert.deepEqual(errors,[]);
});

test('identical evidence uses the memory cache and force-refresh bypasses it',async t=>{
  const first=await setup(t,'tags');
  await first.page.evaluate(()=>{window.TEST.sameSource=true;});await first.page.click('#generate');
  await first.page.waitForFunction(()=>document.getElementById('notice').textContent.includes('2 篇待保存'));
  assert.equal(await first.page.evaluate(()=>window.TEST.requests.filter(request=>request.url.endsWith('/api/chat')).length),1);
  assert.match(await first.page.locator('#item-status').textContent(),/缓存命中/);
  const forced=await setup(t,'tags');
  await forced.page.evaluate(()=>{window.TEST.sameSource=true;});await forced.page.check('#force-refresh');await forced.page.click('#generate');
  await forced.page.waitForFunction(()=>document.getElementById('notice').textContent.includes('2 篇待保存'));
  assert.equal(await forced.page.evaluate(()=>window.TEST.requests.filter(request=>request.url.endsWith('/api/chat')).length),2);
  assert.deepEqual([...first.errors,...forced.errors],[]);
});

test('subscription UI requires explicit selection and mocked official login before cloud generation',async t=>{
  const {page,errors}=await setup(t,'both');
  assert.match(await page.locator('#provider-badge').textContent(),/本地推理/);
  await page.click('#tab-settings');await page.selectOption('#provider','chatgpt');
  assert.match(await page.locator('#provider-badge').textContent(),/ChatGPT 云端/);
  assert.match(await page.locator('#provider-subtitle').textContent(),/发送到 OpenAI/);
  assert.equal(await page.locator('#chatgpt-settings').isVisible(),true);
  assert.match(await page.locator('.cloud-disclosure').textContent(),/发送到 OpenAI/);
  assert.match(await page.locator('#chatgpt-status').textContent(),/尚未授权/);
  await page.click('#chatgpt-login');
  await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('授权完成'));
  assert.equal(await page.inputValue('#model'),'account-model');
  await page.click('#save-settings');await page.click('#tab-generate');await page.click('#generate');
  await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('2 篇待保存'));
  assert.equal(await page.evaluate(()=>window.TEST.cloudCalls),2);
  assert.equal(await page.evaluate(()=>window.TEST.requests.some(request=>request.url.endsWith('/api/chat'))),false);
  assert.match(await page.locator('#source-info').textContent(),/ChatGPT 订阅/);
  await page.click('#save-current');await page.waitForFunction(()=>window.TEST.saves.length===1);
  assert.equal(await page.evaluate(()=>window.TEST.saves[0][3].provider),'chatgpt');
  assert.deepEqual(errors,[]);
});

test('subscription quota failures preserve the selected engine and never silently use Ollama',async t=>{
  const {page,errors}=await setup(t,'note');
  await page.click('#tab-settings');await page.selectOption('#provider','chatgpt');await page.click('#chatgpt-login');
  await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('授权完成'));
  await page.evaluate(()=>{window.TEST.quota=true;});await page.click('#tab-generate');await page.click('#generate');
  await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('2 篇失败'));
  assert.match(await page.locator('#item-status').textContent(),/订阅额度/);
  assert.equal(await page.evaluate(()=>window.TEST.requests.length),0);
  assert.equal(await page.evaluate(()=>window.TEST.saves.length),0);
  await page.click('#tab-settings');await page.selectOption('#provider','ollama');
  assert.equal(await page.inputValue('#model'),'qwen3:4b');
  assert.match(await page.locator('#provider-badge').textContent(),/本地推理/);
  assert.match(await page.locator('#provider-subtitle').textContent(),/留在本机/);
  assert.deepEqual(errors,[]);
});

test('GPU diagnostics distinguish model residency from utilization and clearing cache reports completion',async t=>{
  const {page,errors}=await setup(t,'tags');await page.click('#tab-settings');await page.click('#runtime-info');
  await page.waitForFunction(()=>document.getElementById('runtime-status').textContent.includes('完全驻留 GPU'));
  assert.match(await page.locator('#runtime-status').textContent(),/不是 GPU 利用率/);
  await page.click('#clear-cache');assert.match(await page.locator('#notice').textContent(),/清空/);
  assert.deepEqual(errors,[]);
});
