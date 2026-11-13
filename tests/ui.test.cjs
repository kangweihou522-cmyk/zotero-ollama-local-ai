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
  await page.evaluate(({mode})=>{
    const core=window.OllamaLocalCore;
    let settings=core.normalizeSettings({model:'qwen3:8b'});
    window.TEST={saves:[],requests:[],block:false,failSave:false,remarks:{}};
    const adapter={
      loadSettings:()=>({...settings}),saveSettings:raw=>(settings=core.normalizeSettings(raw)),
      getItem:async id=>({id}),
      collectContext:async item=>({title:'文献 '+item.id,abstract:'研究使用本地语言模型整理文献。',authors:['张三'],existingTags:['文献管理'],fulltext:'',styleRemark:window.TEST.remarks[item.id]??null,sourceWarnings:['仅使用标题和摘要。']}),
      transport:async request=>{
        window.TEST.requests.push(request);
        if(request.url.endsWith('/api/tags'))return {models:[{name:'qwen3:8b'},{name:'cloud:cloud'}]};
        if(request.url.endsWith('/api/show'))return {capabilities:['completion','thinking'],thinking:{values:[true,false]}};
        if(window.TEST.block)await new Promise((resolve,reject)=>{
          if(request.signal.aborted)return reject(new Error('cancelled'));
          request.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});
        });
        return {model:'qwen3:8b',done:true,message:{content:JSON.stringify({tags:['本地模型','文献管理'],note:'本地语言模型辅助文献整理。',overview:{background:'文献数量增长带来整理需求。',question:'如何使用本地语言模型辅助文献整理？',methods:'材料未提供具体实验方法。',findings:'摘要只提出应用目标，没有给出实验数据。',limitations:'本次仅提供摘要，无法判断实验可靠性。',relevance:'可作为本地文献管理工具设计的参考。'}})}};
      },
      saveResult:async (...args)=>{
        if(window.TEST.failSave)throw new Error('模拟只读或暂时写入失败');
        if(core.modeIncludes(args[4],'note')&&args[3].briefTarget==='style-and-note'&&args[2].styleRemark&&!args[5]?.allowStyleOverwrite)throw new Error('已有 Style 简记，请勾选允许更新');
        window.TEST.saves.push(args);return {addedTags:args[1].tags,noteID:100+args[0]};
      }
    };
    window.arguments=[{core,adapter,version:'0.2.0',hostVersion:'10.0.8',mode,settingsPage:false,items:[{id:1,title:'本地语言模型与文献整理'},{id:2,title:'学术标签生成的可靠性研究'}]}];
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
