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
    .replace(/<(textarea|select|span)([^>]*?)\/>/g,'<$1$2></$1>')
    .replace('src="icon.svg"','src="data:image/svg+xml;base64,'+fs.readFileSync(path.join(root,'icon.svg')).toString('base64')+'"');
  await page.setContent('<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"/></head><body style="margin:0">'+markup+'</body></html>');
  await page.addStyleTag({path:path.join(root,'dialog.css')});
  await page.addScriptTag({path:path.join(root,'core.js')});
  await page.evaluate(({mode})=>{
    const core=window.OllamaLocalCore;
    let settings=core.normalizeSettings({model:'qwen3:8b'});
    window.TEST={saves:[],requests:[],block:false,failSave:false};
    const adapter={
      loadSettings:()=>({...settings}),saveSettings:raw=>(settings=core.normalizeSettings(raw)),
      getItem:async id=>({id}),
      collectContext:async item=>({title:'文献 '+item.id,abstract:'研究使用本地语言模型整理文献。',authors:['张三'],existingTags:['文献管理'],fulltext:'',sourceWarnings:['仅使用标题和摘要。']}),
      transport:async request=>{
        window.TEST.requests.push(request);
        if(request.url.endsWith('/api/tags'))return {models:[{name:'qwen3:8b'},{name:'cloud:cloud'}]};
        if(request.url.endsWith('/api/show'))return {capabilities:['completion','thinking'],thinking:{values:[true,false]}};
        if(window.TEST.block)await new Promise((resolve,reject)=>{
          if(request.signal.aborted)return reject(new Error('cancelled'));
          request.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});
        });
        return {model:'qwen3:8b',done:true,message:{content:JSON.stringify({tags:['本地模型','文献管理'],note:'研究问题：本地语言模型如何辅助文献整理。\n\n方法与发现：摘要未提供具体实验数据，需结合全文核对。'})}};
      },
      saveResult:async (...args)=>{
        if(window.TEST.failSave)throw new Error('模拟只读或暂时写入失败');
        window.TEST.saves.push(args);return {addedTags:args[1].tags,noteID:100+args[0]};
      }
    };
    window.arguments=[{core,adapter,version:'0.1.0',mode,settingsPage:false,items:[{id:1,title:'本地语言模型与文献整理'},{id:2,title:'学术标签生成的可靠性研究'}]}];
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
