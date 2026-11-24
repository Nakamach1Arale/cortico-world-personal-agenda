import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,existsSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocketServer} from './cortico-world-personal-agenda-local/vendor/ws/wrapper.mjs';
import {OneBotClient} from './cortico-world-personal-agenda-local/src/onebot-relay.mjs';
import {PersonalAgendaWorld} from './cortico-world-personal-agenda-local/src/index.mjs';
import {createAgendaLanguageModel} from './cortico-world-personal-agenda-local/src/agenda-deepseek.mjs';
import {DesktopWindow} from './shared/desktop-window.mjs';
import {agendaEvents,selectedEvent,remaining} from './cortico-world-personal-agenda-local/window/countdown-model.mjs';
import webui from './shared/webui.js';
const log={info(){},warn(){},error(){}};
const until=async check=>{for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}throw new Error('test state timed out');};
test('direct OneBot client authenticates, calls APIs, and dispatches matching messages without running a local relay',async()=>{
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0,verifyClient:info=>info.req.headers.authorization==='Bearer test-token'});await once(upstream,'listening');let remote;const handled=[],actions=[];
  upstream.on('connection',socket=>{remote=socket;socket.on('message',raw=>{const j=JSON.parse(raw);actions.push(j.action);socket.send(JSON.stringify({status:'ok',retcode:0,echo:j.echo,data:j.action==='get_login_info'?{user_id:99999,nickname:'test'}:{message_id:53}}));});});
  const client=new OneBotClient({upstreamUrl:`ws://127.0.0.1:${upstream.address().port}`,token:'test-token',ownerQQ:()=>12345,onMessage:async ev=>{handled.push(ev.message_id);return ev.raw_message==='/日程';},log});
  try{
    await client.start();await until(()=>client.ready);
    const own=await client.callApi('send_private_msg',{user_id:12345,message:[]});assert.equal(own.message_id,53);
    const ev=(id,user,text)=>({post_type:'message',message_type:'private',self_id:99999,user_id:user,message_id:id,raw_message:text});
    remote.send(JSON.stringify(ev(1,12345,'/日程')));remote.send(JSON.stringify(ev(2,12345,'你好')));remote.send(JSON.stringify(ev(3,22222,'/日程')));
    remote.send(JSON.stringify({post_type:'message',message_type:'group',group_id:42,message_id:4}));
    await until(()=>handled.length===2);
    assert.deepEqual(handled,[1,2]);
    assert.deepEqual(actions,['get_login_info','send_private_msg']);
  }finally{await client.stop();for(const s of upstream.clients)s.terminate();await new Promise(r=>upstream.close(r));}
});
function fixture(){
  const world=new PersonalAgendaWorld({cfg:{privateQQ:12345,corePort:17788,upstreamUrl:'ws://127.0.0.1:3001'},dataDir:'unused'});let paused=false;const sent=[],events=[];
  world.stopped=false;world.host={isPaused:()=>paused,log,store:{range:()=>[]},pushEvent:async e=>events.push(e)};
  world.relay={ready:true,selfId:99999,nickname:'test',callApi:async(a,p)=>{sent.push({a,p});return {message_id:88};}};
  world.service={status:()=>({events:1}),command:()=> '日程总览',natural:async text=>text==='添加提醒'?'已保存':null,chatContext:()=>''};
  return {world,sent,events,setPaused:v=>{paused=v;}};
}
const event=(text,user=12345,id=7)=>({post_type:'message',message_type:'private',self_id:99999,user_id:user,message_id:id,message:[{type:'text',data:{text}}]});
test('independent agenda preserves owner-only command handling and does not send duplicate replies',async()=>{
  const {world,sent,events}=fixture();assert.equal(await world.handleMessage(event('/日程')),true);assert.equal(await world.handleMessage(event('/日程')),true);assert.equal(sent.length,1);
  assert.equal(events[0].type,'qq.agenda_request');assert.equal(events[1].meta.message_id,88);assert.equal(events[1].source,'qq');
  assert.equal(await world.handleMessage(event('/日程',22222,8)),false);assert.equal(await world.handleMessage({...event('/日程',12345,9),message_type:'group'}),false);
  assert.equal(await world.handleMessage(event('你好',12345,10)),false);assert.equal(sent.length,1);
});
test('reminders fail closed on pause, wrong recipient and missing receipt',async()=>{
  const {world,sent,setPaused}=fixture();setPaused(true);await assert.rejects(world.send(12345,'test'));setPaused(false);await assert.rejects(world.send(22222,'test'));assert.equal(sent.length,0);
  world.relay.callApi=async()=>({});await assert.rejects(world.send(12345,'test'));
});
test('real Core status pause boundary is read rather than assuming an optional host hook exists',async()=>{
  const {world}=fixture();delete world.host.isPaused;
  await world.refreshPause(async()=>({ok:true,json:async()=>({loop:{paused:false}})}));assert.equal(world.isPaused(),false);
  await world.refreshPause(async()=>({ok:true,json:async()=>({loop:{paused:true}})}));assert.equal(world.isPaused(),true);
  await world.refreshPause(async()=>{throw new Error('offline');});assert.equal(world.isPaused(),true);
});
test('packaged countdown retains shared agenda selection',()=>{
  const now=Date.now();
  const events=agendaEvents({schema_version:1,events:[{id:'event',title:'Shared',start:new Date(now+60000).toISOString(),enabled:true,status:'confirmed'}]});
  assert.equal(selectedEvent(events,{},now).id,'event');assert.ok(remaining(events[0].start,now));
});
test('webUi and QQ mutations immediately notify the desktop countdown widget to refresh',async()=>{
  const {world}=fixture();const commands=[];
  world.editor={snapshot:()=>({events:[]}),save:()=>({event:{id:'1'}}),setEnabled:()=>({event:{id:'1'}})};
  world.window={status:()=>({running:true}),command:async action=>{commands.push(action);}};
  await world.webUi().invoke('agenda','save-event',[{}]);
  await world.webUi().invoke('agenda','set-event-enabled',[{}]);
  await world.handleMessage(event('/日程'));
  assert.deepEqual(commands,['refresh','refresh','refresh']);
});
test('release exposes the agenda panel only',()=>{assert.equal(typeof webui.panels.agenda.mount,'function');assert.deepEqual(Object.keys(webui.panels),['agenda']);});
test('language adapter uses only this World own OpenAI-compatible config, ctx.secret, and own reminder style',async()=>{
  const requests=[],usages=[];
  const llm=createAgendaLanguageModel({
    getConfig:()=>({baseUrl:'https://api.example.com/v1/',model:'custom-model',style:'简洁干练的提醒口吻'}),
    getApiKey:()=>'world-own-secret',
    reportUsage:(u,meta)=>usages.push({u,meta}),
    fetcher:async(url,opts)=>{
      const body=JSON.parse(opts.body);
      requests.push({url,auth:opts.headers.Authorization,body});
      const text=body.messages[0].content.includes('JSON')?'{"action":"ignore"}':'快到时间啦。';
      return {ok:true,json:async()=>({choices:[{message:{content:text}}],usage:{prompt_tokens:20,completion_tokens:5}})};
    },
  });
  assert.deepEqual(await llm.interpret({text:'hi'}),{action:'ignore'});
  assert.equal(await llm.generate({kind:'reminder',facts:{title:'音乐会'}}),'快到时间啦。');
  assert.equal(requests[0].url,'https://api.example.com/v1/chat/completions');
  assert.equal(requests[0].auth,'Bearer world-own-secret');
  assert.equal(requests[0].body.model,'custom-model');
  assert.match(requests[1].body.messages[0].content,/简洁干练的提醒口吻/);
  assert.equal(usages.length,2);
});
test('desktop widget never silently copies Coopanion.exe on start without explicit user confirmation',async t=>{
  const root=mkdtempSync(join(tmpdir(),'agenda-win-consent-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const botDir=join(root,'data','deployments','companion');
  const win=new DesktopWindow({entry:join(root,'main.cjs'),dataDir:join(botDir,'data'),botDir,repoRoot:root,log});
  writeFileSync(join(root,'Coopanion.exe'),'stub');
  await win.start();
  assert.equal(win.running,false);
  assert.equal(existsSync(win.executable),false);
  assert.equal(win.status().runtime.installed,false);
  assert.equal(win.status().runtime.canInstall,true);
});
