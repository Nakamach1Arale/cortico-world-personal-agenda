import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createAgendaEditor} from './cortico-world-personal-agenda-local/src/agenda-editor.mjs';
import {connectionDraft} from './cortico-world-personal-agenda-local/src/qq-connection.mjs';
import {validateLlmDraft} from './cortico-world-personal-agenda-local/src/agenda-deepseek.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
let puppeteerPath;
try{puppeteerPath=createRequire(import.meta.url).resolve('puppeteer-core');}catch{
  if(!process.env.LOCALAPPDATA)throw new Error('请先安装开发依赖 puppeteer-core');
  const app=path.join(process.env.LOCALAPPDATA,'Programs/Coopanion');
  puppeteerPath=createRequire(path.join(fs.realpathSync(path.join(app,'data/extensions/node_modules/cortico-world-bilibili-video')),'package.json')).resolve('puppeteer-core');
}
const {default:puppeteer}=await import(pathToFileURL(puppeteerPath));
const dataDir=fs.mkdtempSync(path.join(tmpdir(),'agenda-ui-check-')),editor=createAgendaEditor({dataDir});
editor.save({event:{title:'周末一起看直播',start:'2031-04-18T20:00:00+08:00',status:'confirmed',enabled:true,reminders_minutes:[1440,30,0],notes:'留出一点时间，安心看完。'}});
editor.save({event:{title:'新资料片抢先体验',start:'2031-05-23T17:00:00+08:00',status:'tentative',enabled:true,reminders_minutes:[60,0],url:'https://example.com/event'}});
const chrome=process.env.CHROME_PATH??['C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].find(p=>fs.existsSync(p));
if(!chrome)throw new Error('请通过 CHROME_PATH 指定 Chrome 或 Chromium');
const browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-first-run','--no-default-browser-check'],userDataDir:fs.mkdtempSync(path.join(tmpdir(),'agenda-ui-chrome-'))});
const server=createServer((req,res)=>{
  if(req.url.startsWith('/countdown/')){const name=req.url.slice('/countdown/'.length);if(!['countdown.html','countdown.css','countdown-renderer.mjs','countdown-model.mjs','event-format.mjs','agenda-time.mjs'].includes(name)){res.writeHead(404).end();return;}res.setHeader('Content-Type',name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(here,'cortico-world-personal-agenda-local/window',name)));return;}
  if(req.url==='/webui.js'||req.url==='/webui.css'){res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':'text/css');res.end(fs.readFileSync(path.join(here,'shared',req.url.slice(1))));return;}
  res.setHeader('Content-Type','text/html');res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/webui.css"><body style="margin:0;padding:32px;background:#111613"><main id="root"></main><script type="module">import bundle from '/webui.js';const owned=[];const abort=new AbortController();bundle.panels.agenda.mount({panelId:'agenda',root:document.querySelector('#root'),signal:abort.signal,invoke:(...args)=>window.backendInvoke(...args),interval:(f,ms)=>{const t=setInterval(f,ms);owned.push({dispose:()=>clearInterval(t)});},own:r=>owned.push(r)});window.disposePanel=()=>{abort.abort();owned.forEach(r=>r.dispose());document.querySelector('#root').replaceChildren();};</script>`);
});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
let visible=true,runtimeInstalled=false,qqRemindersEnabled=true,connection={privateQQ:0,groupId:0,masterQQ:0,allowGroupAdd:false,groupAddByOwner:false,groupAddByAdmin:false,groupAddByGroupOwner:false,upstreamUrl:'ws://127.0.0.1:3001',corePort:17788,tokenSet:true,noToken:false,configured:false,connected:false,error:{code:'not_configured',message:'尚未填写接收 QQ 或群号'}},llm={configured:false,baseUrl:'',model:'',style:'',keySet:false},connectionChecks=0,connectionSaves=0,savedToken='',savedLlmKey='',runtimeSetups=0;
await page.exposeFunction('backendInvoke',async(method,args=[])=>{
  if(method==='save-event'||method==='set-event-enabled'){try{return {ok:true,...(method==='save-event'?editor.save(args[0]):editor.setEnabled(args[0]))};}catch(e){return {ok:false,error:e.message,code:e.code};}}
  if(method==='show')visible=true;if(method==='hide')visible=false;
  if(method==='set-qq-reminders')qqRemindersEnabled=args[0];
  if(method==='setup-widget-runtime'){if(args[0]?.confirmed!==true)return {ok:false,error:'需要确认'};runtimeSetups++;runtimeInstalled=true;visible=true;}
  if(method==='save-llm'){let draft;try{draft=validateLlmDraft(args[0],{llmBaseUrl:llm.baseUrl,llmModel:llm.model,llmStyle:llm.style});}catch(e){return {ok:false,error:e.message};}if(draft.clearKey)savedLlmKey='';else if(draft.apiKey)savedLlmKey=draft.apiKey;llm={configured:!!(draft.baseUrl&&draft.model),baseUrl:draft.baseUrl,model:draft.model,style:draft.style,keySet:!!savedLlmKey};}
  if(method==='test-connection'){connectionChecks++;return {ok:true,code:'connected',message:'连接正常（QQ 99999）'};}
  if(method==='save-connection'){const draft=args[0];let cfg;try{cfg=connectionDraft({cfg:connection},draft).cfg;}catch(e){return {ok:false,error:e.message};}connectionSaves++;if(draft.token)savedToken=draft.token;const configured=!!cfg.privateQQ||!!cfg.groupId;connection={...connection,...cfg,configured,connected:configured,error:null};}
  return {ok:true,qqRemindersEnabled,...editor.snapshot(),agenda:{events:editor.snapshot().events.filter(e=>e.enabled).length,paused:false},connection,llm,connected:connection.connected,window:{running:runtimeInstalled,visible,runtime:{installed:runtimeInstalled,canInstall:!runtimeInstalled,sourceDir:'C:\\Users\\Demo\\AppData\\Local\\Programs\\Coopanion',runtimeDir:'C:\\Users\\Demo\\AppData\\Local\\Programs\\Coopanion\\data\\runtime\\desktop-widgets',filesSummary:['Coopanion.exe（重命名为 electron.exe）','运行所需 .dll / .pak / .bin 文件','locales/ 语言资源目录']}}};
});
const output=path.join(here,'preview');fs.mkdirSync(output,{recursive:true});
try{
  await page.setViewport({width:1200,height:1000,deviceScaleFactor:1});await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForSelector('[data-event-id]');
  assert.equal(await page.$$('[data-event-id]').then(x=>x.length),2);assert.match(await page.$eval('.cw-connection-setting',n=>n.textContent),/尚未填写/);
  await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='启用桌面挂件').click());await page.waitForSelector('dialog[open]');
  assert.match(await page.$eval('dialog',n=>n.textContent),/Coopanion\.exe/);await page.click('dialog button[type=submit]');await page.waitForFunction(()=>!document.querySelector('dialog[open]'));assert.equal(runtimeSetups,1);assert.equal(runtimeInstalled,true);
  await page.click('.cw-llm-setting button');await page.waitForSelector('dialog[open]');
  await page.type('input[name=llmBaseUrl]','https://api.example.com/v1');await page.type('input[name=llmModel]','deepseek-chat');await page.type('input[name=llmApiKey]','sk-ui-fixture-secret');await page.type('textarea[name=llmStyle]','简短温和');
  await page.click('dialog button[type=submit]');await page.waitForFunction(()=>!document.querySelector('dialog[open]'));assert.equal(llm.configured,true);assert.equal(savedLlmKey,'sk-ui-fixture-secret');assert.equal(await page.evaluate(()=>document.body.textContent.includes('sk-ui-fixture-secret')),false);
  await page.click('.cw-connection-setting button');await page.waitForSelector('dialog[open]');assert.equal(await page.$('select[name=qqMode]'),null);assert.equal(await page.$eval('input[name=qqToken]',n=>n.value),'');
  for(const name of ['privateQQ','groupId','masterQQ'])assert.equal(await page.$eval(`input[name=${name}]`,n=>n.value),'');for(const name of ['allowGroupAdd','groupAddByOwner','groupAddByAdmin','groupAddByGroupOwner'])assert.equal(await page.$eval(`input[name=${name}]`,n=>n.checked),false);assert.equal(await page.evaluate(()=>document.body.textContent.includes('复用官方')),false);
  await page.evaluate(()=>[...document.querySelectorAll('dialog button')].find(b=>b.textContent==='检测连接').click());await page.waitForFunction(()=>document.querySelector('.cw-setup-result')?.textContent.includes('连接正常'));assert.equal(connectionChecks,1);assert.equal(connectionSaves,0);
  await page.type('input[name=privateQQ]','12');await page.click('button[type=submit]');await page.waitForFunction(()=>document.querySelector('.cw-form-error')?.textContent.includes('有效'));assert.equal(connectionSaves,0);
  await page.$eval('input[name=privateQQ]',n=>{n.value='12345';});await page.type('input[name=groupId]','54321');await page.click('input[name=allowGroupAdd]');await page.click('input[name=groupAddByOwner]');await page.click('input[name=groupAddByAdmin]');await page.click('input[name=groupAddByGroupOwner]');await page.type('input[name=masterQQ]','12345');await page.type('input[name=qqToken]','ui-private-fixture');await page.click('button[type=submit]');await page.waitForFunction(()=>!document.querySelector('dialog[open]'));assert.equal(connection.privateQQ,12345);assert.equal(connection.groupId,54321);assert.equal(connection.masterQQ,12345);assert.equal(connection.groupAddByAdmin,true);assert.equal(connection.groupAddByGroupOwner,true);assert.equal(savedToken,'ui-private-fixture');assert.equal(editor.snapshot().events.length,2);
  await page.click('.cw-connection-setting button');await page.waitForSelector('dialog[open]');assert.equal(await page.$eval('input[name=qqToken]',n=>n.value),'');assert.match(await page.$eval('input[name=qqToken]',n=>n.placeholder),/已保存/);assert.equal(await page.evaluate(()=>document.body.textContent.includes('ui-private-fixture')),false);
  assert.equal(await page.$eval('input[name=masterQQ]',n=>n.required),true);assert.equal(await page.$eval('input[name=masterQQ]',n=>n.parentElement.querySelector('.cw-field-requirement').textContent),'必填');await page.screenshot({path:path.join(output,'qq-connection.png'),fullPage:true});await page.evaluate(()=>document.querySelector('dialog .cw-dialog-footer button').click());
  await page.click('.cw-connection-setting button');await page.waitForSelector('dialog[open]');await page.$eval('input[name=privateQQ]',n=>{n.value='';});await page.$eval('input[name=groupId]',n=>{n.value='';});await page.click('input[name=allowGroupAdd]');await page.click('button[type=submit]');await page.waitForFunction(()=>!document.querySelector('dialog[open]'));assert.equal(connection.connected,false);assert.equal(connection.privateQQ,0);assert.equal(connection.groupId,0);
  await page.click('.cw-connection-setting button');await page.waitForSelector('dialog[open]');await page.type('input[name=groupId]','54321');await page.click('input[name=allowGroupAdd]');await page.click('input[name=groupAddByOwner]');await page.click('input[name=groupAddByGroupOwner]');await page.click('button[type=submit]');await page.waitForFunction(()=>!document.querySelector('dialog[open]'));assert.equal(connection.privateQQ,0);assert.equal(connection.groupId,54321);assert.equal(connection.groupAddByAdmin,true);assert.equal(connection.groupAddByOwner,false);assert.equal(connection.connected,true);
  await page.screenshot({path:path.join(output,'agenda-desktop.png'),fullPage:true});
  await page.click('[role=switch]');await page.waitForFunction(()=>document.querySelector('[role=switch]')?.getAttribute('aria-checked')==='false');assert.equal(qqRemindersEnabled,false);assert.equal(editor.snapshot().events.length,2);
  await page.click('[role=switch]');await page.waitForFunction(()=>document.querySelector('[role=switch]')?.getAttribute('aria-checked')==='true');assert.equal(qqRemindersEnabled,true);
  const originalStarts=editor.snapshot().events.map(e=>e.start);assert.equal(await page.$('select[aria-label="日程时区"]'),null);
  await page.setViewport({width:1200,height:1200,deviceScaleFactor:1});
  await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes('新增日程')).click());await page.waitForSelector('dialog[open]');
  assert.equal(await page.$eval('select[name=timezone]',n=>n.value),'local');await page.select('select[name=timezone]','America/New_York');
  await page.type('input[name=title]','夏日专场音乐会');await page.type('input[name=subtitle]','和朋友一起看线上直播');await page.type('input[name=remark]','演出 · 线上直播');await page.type('textarea[name=details]','提前 10 分钟进场候播。');await page.$eval('input[name=start]',n=>{n.value='2031-07-02T19:30';});await page.type('input[name=reminders]','10, 60');await page.$eval('dialog',n=>{n.scrollTop=0;});
  await page.screenshot({path:path.join(output,'agenda-editor.png'),fullPage:true});
  await page.click('button[type=submit]');await page.waitForFunction(()=>!document.querySelector('dialog[open]'));assert.equal(editor.snapshot().events.length,3);
  let added=editor.snapshot().events.find(e=>e.title==='夏日专场音乐会');assert.deepEqual(added.reminders_minutes,[1440,60,30,10,0]);assert.equal(added.remark,'演出 · 线上直播');assert.equal(added.details,'提前 10 分钟进场候播。');assert.equal(added.subtitle,'和朋友一起看线上直播');
  assert.equal(added.start,'2031-07-02T19:30:00-04:00');
  assert.equal(added.timezone,'America/New_York');assert.deepEqual(editor.snapshot().events.slice(0,2).map(e=>e.start),originalStarts);
  await page.$eval(`[data-event-id="${added.id}"]`,n=>[...n.querySelectorAll('button')].find(b=>b.textContent==='编辑').click());await page.waitForSelector('dialog[open]');
  await page.select('select[name=timezone]','Asia/Tokyo');assert.equal(await page.$eval('input[name=start]',n=>n.value),'2031-07-03T08:30');await page.select('select[name=timezone]','America/New_York');assert.equal(await page.$eval('input[name=start]',n=>n.value),'2031-07-02T19:30');
  editor.save({event:{...added,title:'QQ 同时修改'},expectedRevision:added.revision});await page.click('button[type=submit]');await page.waitForFunction(()=>document.querySelector('.cw-form-error')?.textContent.includes('新改动'));
  assert.equal(editor.snapshot().events.find(e=>e.id===added.id).title,'QQ 同时修改');
  await page.evaluate(()=>document.querySelector('dialog').querySelector('.cw-dialog-footer button').click());
  await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='刷新').click());await page.waitForFunction(()=>document.body.textContent.includes('QQ 同时修改'));
  await page.$eval(`[data-event-id="${added.id}"]`,n=>[...n.querySelectorAll('button')].find(b=>b.textContent==='编辑').click());await page.waitForSelector('dialog[open]');await page.select('select[name=timezone]','Asia/Tokyo');await page.click('button[type=submit]');await page.waitForFunction(()=>!document.querySelector('dialog[open]'));assert.equal(editor.snapshot().events.find(e=>e.id===added.id).start,added.start);assert.equal(editor.snapshot().events.find(e=>e.id===added.id).timezone,'Asia/Tokyo');
  await page.$eval(`[data-event-id="${added.id}"]`,n=>[...n.querySelectorAll('button')].find(b=>b.textContent==='取消日程').click());await page.waitForSelector('dialog[open]');await page.evaluate(()=>[...document.querySelectorAll('dialog button')].find(b=>b.textContent==='确认取消').click());await page.waitForFunction(()=>!document.querySelector('dialog[open]'));
  assert.equal(editor.snapshot().events.find(e=>e.id===added.id).enabled,false);
  await page.setViewport({width:390,height:844,deviceScaleFactor:1});await page.screenshot({path:path.join(output,'agenda-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile must not overflow');
  await page.click('.cw-connection-setting button');await page.waitForSelector('dialog[open]');await page.click('input[name=groupAddByOwner]');await page.$eval('input[name=masterQQ]',n=>{n.value='12345';});await page.click('input[name=groupAddByGroupOwner]');
  assert.equal(await page.$eval('dialog',n=>n.scrollWidth<=n.clientWidth),true,'group setup must not overflow on mobile');
  await page.screenshot({path:path.join(output,'qq-connection-mobile.png'),fullPage:true});await page.$eval('dialog',n=>{n.scrollTop=n.scrollHeight;});assert.equal(await page.$eval('button[type=submit]',n=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),true,'save button must be reachable by scrolling');await page.evaluate(()=>document.querySelector('dialog .cw-dialog-footer button').click());
  await page.setViewport({width:1200,height:1200,deviceScaleFactor:1});
  await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes('新增日程')).click());await page.waitForSelector('dialog[open]');
  await page.select('select[name=timezone]','America/New_York');await page.type('input[name=title]','夏令时重复时段');await page.$eval('input[name=start]',n=>{n.value='2031-11-02T01:30';});await page.click('button[type=submit]');
  await page.waitForFunction(()=>!document.querySelector('select[name=occurrence]').parentElement.hidden);assert.match(await page.$eval('.cw-form-error',n=>n.textContent),/出现两次/);
  await page.select('select[name=occurrence]','later');await page.click('button[type=submit]');await page.waitForFunction(()=>!document.querySelector('dialog[open]'));assert.equal(editor.snapshot().events.find(e=>e.title==='夏令时重复时段').start,'2031-11-02T01:30:00-05:00');
  await page.evaluate(()=>window.disposePanel());assert.equal(await page.$$('#root>*').then(x=>x.length),0);assert.deepEqual(errors,[]);
  const widget=await browser.newPage();widget.on('pageerror',e=>errors.push(String(e)));await widget.setViewport({width:360,height:460,deviceScaleFactor:2});
  const evening=new Date(Date.now()+3*86400_000);evening.setUTCHours(12,0,0,0);
  const widgetSnapshot={events:[{id:'widget-preview',title:'夏日专场音乐会',subtitle:'和朋友一起看线上直播',remark:'演出 · 线上直播',stream:'https://live.bilibili.com/12345',start:evening.toISOString(),timezone:'Asia/Shanghai',status:'confirmed',enabled:true},{id:'widget-next',title:'每周例行复盘',start:new Date(evening.getTime()+6*86400_000).toISOString(),timezone:'Asia/Shanghai',status:'tentative',enabled:true}],preferences:{visible:true,collapsed:false,topmost:true,selectedId:null}};
  await widget.evaluateOnNewDocument(snapshot=>{window.countdown={get:async()=>snapshot,action:async()=>{},subscribe:fn=>{window.pushCountdown=fn;return()=>{};}};},widgetSnapshot);
  await widget.goto(`http://127.0.0.1:${server.address().port}/countdown/countdown.html`);await widget.waitForFunction(()=>document.querySelector('#target').textContent.includes('Asia/Shanghai'));
  const card=await widget.$('#card');await card.screenshot({path:path.join(output,'countdown-widget.png')});
  const snapshot={events:[{id:'timezone-fixture',title:'Timezone example',start:'2031-07-02T19:30:00-04:00',timezone:'America/New_York',status:'confirmed',enabled:true}],preferences:{visible:true,collapsed:false,topmost:false,selectedId:null}};
  await widget.evaluate(snapshot=>window.pushCountdown(snapshot),snapshot);await widget.waitForFunction(()=>document.querySelector('#target').textContent.includes('America/New_York'));assert.match(await widget.$eval('#target',n=>n.textContent),/19:30/);
  await widget.evaluate(snapshot=>window.pushCountdown({...snapshot,events:snapshot.events.map(e=>({...e,timezone:'Asia/Tokyo'}))}),snapshot);assert.match(await widget.$eval('#target',n=>n.textContent),/08:30.*Asia\/Tokyo/);assert.deepEqual(errors,[]);await widget.close();
  console.log(JSON.stringify({passed:true,checks:['empty private/group/master defaults','group role permissions','group-only setup','read-only connection check','secret non-disclosure','QQ reminder switch','timezone switching','DST repeat choice','countdown timezone rendering','create','custom reminders','conflict protection','cancel','mobile layout and QQ setup scrolling','unmount'],screenshots:5,realAgendaChanged:false}));
}finally{await browser.close();await new Promise(r=>server.close(r));}
