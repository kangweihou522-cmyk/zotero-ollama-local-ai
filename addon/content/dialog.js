/* SPDX-License-Identifier: MIT */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const bridge = window.arguments?.[0];
  if (!bridge?.engine) { $("notice").textContent = "请重启 Zotero，从 Ollama 本地 AI 菜单打开新版窗口。"; return; }
  const { core, adapter, engine } = bridge;
  const initial = adapter.loadSettings();
  const modelNames = { ollama: initial.model, chatgpt: initial.chatgptModel };
  const entries = bridge.items.map(item => ({ ...item, state:"pending", context:null, result:null, mode:bridge.mode, error:"", allowStyleOverwrite:false, liveText:"" }));
  let selected = entries.length ? 0 : -1;
  let activeProvider = initial.provider || "ollama";
  let busy = false, busyKind = "", controller = null, closing = false;
  let accountStatus = { connected:false, accounts:[] };

  function notice(message, kind="") { $("notice").textContent=message; $("notice").className="notice"+(kind?" "+kind:""); }
  function page(settings) { $("panel-settings").hidden=!settings; $("panel-generate").hidden=settings; $("tab-settings").classList.toggle("active",settings); $("tab-generate").classList.toggle("active",!settings); }
  function formSettings() {
    modelNames[activeProvider] = $("model").value;
    return core.normalizeSettings({
      ...adapter.loadSettings(), provider:activeProvider, model:modelNames.ollama, chatgptModel:modelNames.chatgpt,
      profile:$("profile").value, endpoint:$("endpoint").value, language:$("language").value,
      maxTags:Number($("max-tags").value), maxInputChars:Number($("max-input").value),
      timeoutSeconds:Number($("timeout").value), contextTokens:Number($("context-tokens").value),
      includeFulltext:$("include-fulltext").checked, instructions:$("instructions").value,
      briefTarget:$("brief-target").value, cacheEnabled:$("cache-enabled").checked
    });
  }
  function option(value,label) { const node=document.createElementNS("http://www.w3.org/1999/xhtml","option");node.value=value;node.textContent=label;return node; }
  function resetModelPicker() {
    $("model").replaceChildren(option("","请先检测连接并选择模型"));
    const value=modelNames[activeProvider];
    if(value){$("model").append(option(value,value+"（检测连接以确认）"));$("model").value=value;}
  }
  function providerViews() {
    const cloud=activeProvider==="chatgpt";
    $("ollama-settings").hidden=cloud;$("chatgpt-settings").hidden=!cloud;
    $("model-label").textContent=cloud?"账户可用模型":"已安装模型";
    $("connection-status").textContent=cloud?"先在官方页面登录授权，再检测可用模型。":"请确认 Ollama 运行，再检测本地模型。";
    modelSummary();
  }
  function modelSummary() {
    const model=modelNames[activeProvider];
    $("model-summary").textContent=(activeProvider==="chatgpt"?"ChatGPT：":"Ollama：")+(model||"尚未选择模型");
  }
  function fillSettings(settings) {
    $("provider").value=activeProvider;$("profile").value=settings.profile||"fast";
    $("endpoint").value=settings.endpoint;$("language").value=settings.language;$("max-tags").value=settings.maxTags;
    $("max-input").value=settings.maxInputChars;$("timeout").value=settings.timeoutSeconds;$("context-tokens").value=String(settings.contextTokens);
    $("include-fulltext").checked=settings.includeFulltext;$("instructions").value=settings.instructions;
    $("brief-target").value=settings.briefTarget||"note";$("cache-enabled").checked=settings.cacheEnabled!==false;
    resetModelPicker();providerViews();
  }
  function applyProfile() {
    const settings=core.effectiveSettings(formSettings(),$("mode").value);
    if($("profile").value!=="custom") {
      $("context-tokens").value=String(settings.contextTokens);$("max-input").value=settings.maxInputChars;$("include-fulltext").checked=settings.includeFulltext;
    }
    $("preset-summary").textContent=`${settings.profile==="fast"?"快速":settings.profile==="balanced"?"均衡":"自定义"} · ${settings.contextTokens} tokens · ${settings.includeFulltext?"可用 PDF 索引":"仅元数据／摘要"}`;
    updateControls();
  }
  function updateControls() {
    const fields=["generate","mode","items","save-settings","refresh-models","endpoint","model","language","max-tags","max-input","timeout","context-tokens","include-fulltext","instructions","brief-target","provider","profile","cache-enabled","force-refresh","clear-cache","runtime-info","chatgpt-login","chatgpt-other-account","chatgpt-account"];
    for(const id of fields)$(id).disabled=busy||(id==="generate"&&!entries.length);
    const preset=$("profile").value!=="custom";
    for(const id of ["max-input","context-tokens","include-fulltext"])$(id).disabled=busy||preset;
    $("chatgpt-logout").disabled=busy||!accountStatus.connected;
    $("cancel").disabled=!busy||busyKind==="save"||!controller;
    $("cancel-login").hidden=!(busy&&busyKind==="login");
    $("chatgpt-account").disabled=busy||(accountStatus.accounts||[]).length<2;
  }
  function setBusy(value,kind="") { busy=value;busyKind=value?kind:"";updateControls();renderCurrent(); }
  function renderList() {
    const marks={pending:"○",generating:"…",ready:"●",saved:"✓",error:"!"};
    $("items").replaceChildren(...entries.map((entry,index)=>option(String(index),`${marks[entry.state]} ${entry.title}`)));
    $("items").value=String(selected);$("item-count").textContent=`${entries.length} 篇`;
  }
  function persistEdits() {
    const entry=entries[selected];if(!entry||entry.state!=="ready")return;
    entry.result.tags=$("result-tags").value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    entry.result.note=$("result-note").value;entry.allowStyleOverwrite=$("allow-style-overwrite").checked;
    if(core.modeIncludes(entry.mode,"overview"))entry.result.overview=Object.fromEntries(core.OVERVIEW_FIELDS.map(({key})=>[key,$("overview-"+key).value]));
  }
  function sourceText(entry) {
    if(!entry.context)return "生成前将读取本地元数据和预设允许的 PDF 索引。";
    const evidence=entry.result?.sourceInfo;
    const hasFulltext=evidence?evidence.hasFulltext:Boolean(entry.context.fulltext);
    const source=hasFulltext?"元数据 + 本地 PDF 索引":"仅标题／摘要等元数据，未使用 PDF 正文";
    const budget=evidence?`实际输入 ${evidence.inputChars} 字符${evidence.contextTokens?`；上下文 ${evidence.contextTokens} tokens`:""}${evidence.truncated?"；输入已截断":""}`:"";
    const provider=entry.result?(entry.result.provider==="chatgpt"||entry.settings?.provider==="chatgpt"?"ChatGPT 订阅":"本地 Ollama"):"";
    return [provider,source,budget,...(entry.context.sourceWarnings||[])].filter(Boolean).join("\n");
  }
  function statsText(result) {
    if(!result)return "";
    const stats=result.stats||{};const fields=[];
    if(result.cacheHit)fields.push("缓存命中");
    if(Number.isFinite(stats.elapsedMs))fields.push(`耗时 ${(stats.elapsedMs/1000).toFixed(1)} 秒`);
    if(!result.cacheHit&&Number.isFinite(stats.tokensPerSecond)&&stats.tokensPerSecond>0)fields.push(`${stats.tokensPerSecond.toFixed(1)} token/秒`);
    return fields.join(" · ");
  }
  // Tolerate an unfinished JSON string while rendering human-readable progress.
  // Only the final parsed result is ever editable or saved.
  function partialString(text,start) {
    let result="";
    for(let i=start;i<text.length;i++) {
      const char=text[i];if(char==='"')break;
      if(char!=="\\"){result+=char;continue;}
      const escape=text[++i];if(escape===undefined)break;
      if(escape==="u"){const hex=text.slice(i+1,i+5);if(!/^[0-9a-f]{4}$/i.test(hex))break;result+=String.fromCharCode(parseInt(hex,16));i+=4;}
      else result+=({n:"\n",r:"\r",t:"\t",b:"\b",f:"\f"})[escape]??escape;
    }
    return result;
  }
  function readableProgress(text) {
    const rows=[];
    const tags=/"tags"\s*:\s*\[([^\]]*)/.exec(text);
    if(tags){const values=[];const pattern=/"/g;let match;while((match=pattern.exec(tags[1]))){values.push(partialString(tags[1],match.index+1));let end=match.index+1;while(end<tags[1].length){if(tags[1][end]==="\\"){end+=2;continue;}if(tags[1][end++]==='"')break;}pattern.lastIndex=end;}if(values.length)rows.push("标签："+values.join("、"));}
    const fields=[{key:"note",label:"简记"},...core.OVERVIEW_FIELDS];
    for(const {key,label} of fields){const found=new RegExp('"'+key+'"\\s*:\\s*"').exec(text);if(found)rows.push(label+"："+partialString(text,found.index+found[0].length));}
    return rows.join("\n\n").slice(0,20000)||"正在等待首段内容…";
  }
  function renderCurrent() {
    const entry=entries[selected];const mode=entry?.result?entry.mode:$("mode").value;
    for(const part of ["tags","note","overview"])$(part+"-area").hidden=!core.modeIncludes(mode,part);
    $("item-title").textContent=entry?.title||"请先在文献库选中文献";
    $("source-info").textContent=entry?sourceText(entry):"关闭窗口，在文献库选中文献后重新打开。";
    $("result-tags").value=entry?.result?.tags.join("\n")||"";$("result-note").value=entry?.result?.note||"";
    for(const {key} of core.OVERVIEW_FIELDS)$("overview-"+key).value=entry?.result?.overview?.[key]||"";
    const editable=entry?.state==="ready"&&!busy;
    for(const id of ["result-tags","result-note",...core.OVERVIEW_FIELDS.map(({key})=>"overview-"+key)])$(id).disabled=!editable;
    $("style-preview").hidden=$("brief-target").value!=="style-and-note";
    $("existing-style-remark").textContent=entry?.context?.styleRemarkAmbiguous?"Extra 中存在多条 remark，请先整理后再写入 Style 简记栏。":entry?.context?.styleRemark?"已有 Style 简记："+entry.context.styleRemark:"保存时将新增 Extra 的 remark 行，其他字段保留。";
    $("style-overwrite-label").hidden=!entry?.context?.styleRemark;$("allow-style-overwrite").checked=Boolean(entry?.allowStyleOverwrite);$("allow-style-overwrite").disabled=!editable;
    $("save-current").disabled=!editable;$("save-all").disabled=busy||!entries.some(item=>item.state==="ready");
    const labels={pending:"待生成",generating:"正在生成…",ready:"待保存 · 可编辑",saved:"已保存到 Zotero",error:"生成失败 · 可重试"};
    $("item-status").textContent=entry?[entry.error||labels[entry.state],statsText(entry.result)].filter(Boolean).join(" · "):"";
    $("live-area").hidden=!(entry&&entry.state==="generating");
    $("live-output").textContent=entry?readableProgress(entry.liveText):"";
  }
  async function refreshAccountStatus() {
    accountStatus=await engine.status();
    $("chatgpt-status").textContent=accountStatus.connected?"已授权："+(accountStatus.accountLabel||"ChatGPT 账户"):"尚未授权 ChatGPT 订阅额度。";
    const accounts=accountStatus.accounts||[];
    $("chatgpt-account").replaceChildren(...(accounts.length?accounts.map(account=>option(account.id,account.label+(account.connected?"":"（需重新登录）"))):[option("","尚未登录")]));
    $("chatgpt-account").value=accountStatus.accountId||"";updateControls();
  }
  async function detectModels(settings,signal) {
    const current=modelNames[activeProvider]||$("model").value;
    const models=await engine.listModels(settings,signal);
    $("model").replaceChildren(option("",models.length?"请选择模型":"没有可用模型"),...models.map(model=>option(model.name,model.label||model.name)));
    $("model").value=models.some(model=>model.name===current)?current:(models[0]?.name||"");
    modelNames[activeProvider]=$("model").value;modelSummary();
    $("connection-status").textContent=`连接成功，发现 ${models.length} 个${activeProvider==="chatgpt"?"账户可用":"本地"}模型。`;
    return models;
  }
  async function refreshModels() {
    persistEdits();controller=new AbortController();setBusy(true,"detect");
    try {notice(activeProvider==="chatgpt"?"正在检测官方订阅模型目录…":"正在连接本机 Ollama…");const models=await detectModels(formSettings(),controller.signal);notice(models.length?"连接成功。选择模型并保存设置，即可生成。":"已连接，但没有可用模型。",models.length?"":"warn");}
    catch(error){$("connection-status").textContent=error.message;notice(error.message,"error");}
    finally{controller=null;setBusy(false);}
  }
  async function loginChatGPT(newAccount=false) {
    persistEdits();controller=new AbortController();setBusy(true,"login");
    try {notice("正在打开 OpenAI 官方授权页面…");await engine.login({newAccount,signal:controller.signal,onStatus:message=>notice(message)});await refreshAccountStatus();const models=await detectModels(formSettings(),controller.signal);notice(models.length?"ChatGPT 授权完成。选择模型并保存设置；开始生成时会使用订阅额度。":"已授权，但没有可用模型，请检查账户和应用额度设置。",models.length?"":"warn");}
    catch(error){notice(error.name==="AbortError"?"已取消 ChatGPT 登录。":error.message,error.name==="AbortError"?"":"error");}
    finally{controller=null;setBusy(false);await refreshAccountStatus().catch(()=>{});}
  }
  async function logoutChatGPT() {
    persistEdits();setBusy(true,"logout");
    try{const status=await engine.logout();await refreshAccountStatus();notice(status.message||"已退出 ChatGPT 登录并清空生成缓存。");}
    catch(error){notice(error.message,"error");}finally{setBusy(false);}
  }
  async function runtimeInfo() {
    persistEdits();controller=new AbortController();setBusy(true,"diagnose");
    try {const info=await adapter.getRuntimeInfo(formSettings(),controller.signal);const model=info.selectedModel;$("runtime-status").textContent=!model?"当前模型尚未载入。先生成一次，再检查驻留情况。":model.processor==="gpu"?"模型已完全驻留 GPU。此数据表示驻留位置，不是 GPU 利用率。":model.processor==="cpu"?"模型当前驻留 CPU。可检查显卡支持或尝试较小模型。":model.processor==="mixed"?`模型分布于 CPU/GPU，GPU 驻留约 ${Math.round(model.gpuFraction*100)}%。可尝试快速预设，减少显存压力。`:"服务未报告明确的模型驻留位置。";notice($("runtime-status").textContent);}
    catch(error){$("runtime-status").textContent=error.message;notice(error.message,"error");}
    finally{controller=null;setBusy(false);}
  }
  function saveSettings() {
    persistEdits();
    try {const settings=formSettings();if(!(settings.provider==="chatgpt"?settings.chatgptModel:settings.model))throw new Error("请先检测连接并选择可用模型。");adapter.saveSettings(settings);modelSummary();notice("设置已保存。回到文献整理即可开始生成。");}
    catch(error){notice(error.message,"error");}
  }
  async function generate() {
    persistEdits();const pending=entries.filter(entry=>entry.state==="pending"||entry.state==="error");
    if(!pending.length){notice("所有文献都已有结果。请预览保存；重新打开窗口可复用缓存，或勾选忽略缓存重新请求。");return;}
    try {
      const settings=formSettings();const model=settings.provider==="chatgpt"?settings.chatgptModel:settings.model;
      if(!model){page(true);throw new Error("请先检测连接并选择模型。");}
      adapter.saveSettings(settings);modelSummary();controller=new AbortController();setBusy(true,"generate");
      notice(settings.provider==="chatgpt"?"正在确认 ChatGPT 授权与模型…":"正在确认本地模型…");
      const models=await detectModels(settings,controller.signal);
      if(!models.some(item=>item.name===model)){page(true);throw new Error("所选模型当前不可用，请重新选择。");}
      let completed=0;
      for(const entry of pending) {
        if(controller.signal.aborted||closing)break;
        selected=entries.indexOf(entry);entry.mode=$("mode").value;entry.state="generating";entry.error="";entry.liveText="";entry.allowStyleOverwrite=false;
        renderList();renderCurrent();notice(`正在生成 ${completed+1} / ${pending.length}：${entry.title}`);
        try {
          const effective=core.effectiveSettings(settings,entry.mode);const item=await adapter.getItem(entry.id);entry.context=await adapter.collectContext(item,effective);
          if(controller.signal.aborted||closing){entry.state="pending";break;}
          let painted=0;
          entry.result=await engine.generate(entry.context,entry.mode,effective,controller.signal,{forceRefresh:$("force-refresh").checked,onProgress:event=>{
            if(closing||controller?.signal.aborted)return;
            if(event.stage!=="streaming"&&event.stage!=="complete")return;
            const firstContent=!entry.liveText&&Boolean(event.text);
            if(typeof event.text==="string")entry.liveText=event.text;
            if(firstContent||Date.now()-painted>100||event.stage==="complete"||event.stage==="cache-hit"){$("live-output").textContent=readableProgress(entry.liveText);painted=Date.now();}
          }});
          entry.settings={...effective};entry.state="ready";
        } catch(error){if(controller.signal.aborted||closing){entry.state="pending";break;}entry.state="error";entry.error=error.message;}
        completed++;renderList();renderCurrent();
      }
      const ready=entries.filter(entry=>entry.state==="ready").length,errors=entries.filter(entry=>entry.state==="error").length;
      notice(`${controller.signal.aborted?"已停止。":"生成结束。"}${ready} 篇待保存，${errors} 篇失败。请检查结果后保存。`,errors?"warn":"");
    }catch(error){notice(error.message,"error");}finally{controller=null;setBusy(false);renderList();}
  }
  async function saveEntries(all) {
    persistEdits();const targets=all?entries.filter(entry=>entry.state==="ready"):[entries[selected]].filter(entry=>entry?.state==="ready");if(!targets.length)return;
    setBusy(true,"save");let saved=0;const errors=[];
    for(const entry of targets){try{notice(`正在保存 ${saved+1} / ${targets.length}：${entry.title}`);const parsed=core.parseGeneration(JSON.stringify({tags:entry.result.tags,note:entry.result.note,overview:entry.result.overview}),entry.mode,entry.settings);const result={...entry.result,...parsed};await adapter.saveResult(entry.id,result,entry.context,{...entry.settings,briefTarget:$("brief-target").value},entry.mode,{allowStyleOverwrite:entry.allowStyleOverwrite});entry.result=result;entry.state="saved";entry.error="";saved++;}catch(error){entry.error="保存失败："+error.message;errors.push(entry.title+"："+error.message);}renderList();renderCurrent();}
    setBusy(false);notice(`已保存 ${saved} 篇。${errors.length?"\n"+errors.join("\n"):"所选结果已写入 Zotero。"}`,errors.length?"error":"");
  }

  $("version").textContent="v"+bridge.version+" · Zotero "+(bridge.hostVersion||"10");
  $("mode").value=bridge.mode||"both";fillSettings(initial);applyProfile();renderList();setBusy(false);page(Boolean(bridge.settingsPage));
  notice(entries.length?`已选中 ${entries.length} 篇文献。默认快速生成标签与简记，概览可按需选择。`:"请先配置生成引擎；从文献库选中文献后重新打开即可生成。");
  $("tab-settings").addEventListener("click",()=>page(true));$("tab-generate").addEventListener("click",()=>page(false));
  $("items").addEventListener("change",()=>{persistEdits();selected=Number($("items").value);renderCurrent();});
  $("mode").addEventListener("change",()=>{persistEdits();applyProfile();renderCurrent();});
  $("profile").addEventListener("change",()=>{persistEdits();try{applyProfile();renderCurrent();}catch(error){notice(error.message,"error");}});
  $("provider").addEventListener("change",()=>{persistEdits();modelNames[activeProvider]=$("model").value;activeProvider=$("provider").value;resetModelPicker();providerViews();refreshAccountStatus().catch(error=>notice(error.message,"error"));});
  $("model").addEventListener("change",()=>{modelNames[activeProvider]=$("model").value;modelSummary();});
  $("brief-target").addEventListener("change",()=>{persistEdits();try{adapter.saveSettings(formSettings());renderCurrent();}catch(error){notice(error.message,"error");}});
  $("chatgpt-account").addEventListener("change",async()=>{persistEdits();setBusy(true,"account");try{await engine.selectAccount($("chatgpt-account").value);modelNames.chatgpt="";resetModelPicker();await refreshAccountStatus();notice("已切换账户，请重新检测可用模型。");}catch(error){notice(error.message,"error");}finally{setBusy(false);}});
  $("refresh-models").addEventListener("click",refreshModels);$("save-settings").addEventListener("click",saveSettings);$("generate").addEventListener("click",generate);
  $("cancel").addEventListener("click",()=>controller?.abort());$("cancel-login").addEventListener("click",()=>controller?.abort());
  $("chatgpt-login").addEventListener("click",()=>loginChatGPT());$("chatgpt-other-account").addEventListener("click",()=>loginChatGPT(true));$("chatgpt-logout").addEventListener("click",logoutChatGPT);$("runtime-info").addEventListener("click",runtimeInfo);
  $("clear-cache").addEventListener("click",()=>{engine.clearCache();notice("已清空本次运行的生成缓存。");});
  $("save-current").addEventListener("click",()=>saveEntries(false));$("save-all").addEventListener("click",()=>saveEntries(true));
  window.addEventListener("unload",()=>{closing=true;controller?.abort();},{once:true});
  refreshAccountStatus().catch(error=>{if(activeProvider==="chatgpt")notice(error.message,"error");});
})();
