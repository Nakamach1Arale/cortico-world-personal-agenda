import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import WebSocket,{WebSocketServer} from './cortico-world-personal-agenda-local/vendor/ws/wrapper.mjs';
import {OneBotRelay} from './cortico-world-personal-agenda-local/src/onebot-relay.mjs';
import {PersonalAgendaWorld} from './cortico-world-personal-agenda-local/src/index.mjs';
import {createAgendaDeepSeek} from './cortico-world-personal-agenda-local/src/agenda-deepseek.mjs';
import {agendaEvents,selectedEvent,remaining} from './cortico-world-personal-agenda-local/window/countdown-model.mjs';
import webui from './shared/webui.js';
const log={info(){},warn(){},error(){}};
const until=async check=>{for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}throw new Error('test state timed out');};
test('OneBot relay authenticates, preserves API echoes, intercepts owner agenda only and forwards ordinary events',async()=>{
  const upstream=new WebSocketServer({host:'127.0.0.1',port:0});await once(upstream,'listening');let remote;const handled=[],actions=[];
  upstream.on('connection',socket=>{remote=socket;socket.on('message',raw=>{const j=JSON.parse(raw);actions.push(j.action);socket.send(JSON.stringify({status:'ok',retcode:0,echo:j.echo,data:j.action==='get_login_info'?{user_id:99999,nickname:'test'}:{message_id:53}}));});});
  const relay=new OneBotRelay({port:0,upstreamUrl:`ws://127.0.0.1:${upstream.address().port}`,token:'test-token',ownerQQ:()=>12345,onMessage:async ev=>{handled.push(ev.message_id);return ev.raw_message==='/日程';},log});
  let downstream;
  try{
    await relay.start();await until(()=>relay.ready);
    assert.equal(relay.authorized({headers:{authorization:'Bearer wrong'},url:'/'}),false);
    downstream=new WebSocket(`ws://127.0.0.1:${relay.status().port}`,{headers:{Authorization:'Bearer test-token'}});await once(downstream,'open');
    const messages=[];downstream.on('message',raw=>messages.push(JSON.parse(raw)));
    downstream.send(JSON.stringify({action:'get_login_info',params:{},echo:'original-echo'}));await until(()=>messages.some(m=>m.echo==='original-echo'));
    assert.equal(messages.find(m=>m.echo==='original-echo').data.user_id,99999);
    const own=await relay.callApi('send_private_msg',{user_id:12345,message:[]});assert.equal(own.message_id,53);
    const ev=(id,user,text)=>({post_type:'message',message_type:'private',self_id:99999,user_id:user,message_id:id,raw_message:text});
    remote.send(JSON.stringify(ev(1,12345,'/日程')));remote.send(JSON.stringify(ev(2,12345,'你好')));remote.send(JSON.stringify(ev(3,22222,'/日程')));
    remote.send(JSON.stringify({post_type:'message',message_type:'group',group_id:42,message_id:4}));
    await until(()=>messages.filter(x=>x.post_type==='message').length===3);
    assert.deepEqual(handled,[1,2]);assert.deepEqual(messages.filter(x=>x.post_type==='message').map(x=>x.message_id).sort(),[2,3,4]);
    assert.deepEqual(actions.slice(0,3),['get_login_info','get_login_info','send_private_msg']);
  }finally{downstream?.terminate();await relay.stop();for(const s of upstream.clients)s.terminate();await new Promise(r=>upstream.close(r));}
});
function fixture(){
  const world=new PersonalAgendaWorld({cfg:{privateQQ:12345,corePort:17788,relayPort:3002,upstreamUrl:'ws://127.0.0.1:3001'},dataDir:'unused'});let paused=false;const sent=[],events=[];
  world.stopped=false;world.host={isPaused:()=>paused,log,store:{range:()=>[]},pushEvent:async e=>events.push(e)};
  world.relay={ready:true,selfId:99999,nickname:'test',callApi:async(a,p)=>{sent.push({a,p});return {message_id:88};}};
  world.service={status:()=>({events:1}),command:()=> '日程总览',natural:async text=>text==='添加提醒'?'已保存':null,chatContext:()=>''};
  return {world,sent,events,setPaused:v=>{paused=v;}};
}
const event=(text,user=12345,id=7)=>({post_type:'message',message_type:'private',self_id:99999,user_id:user,message_id:id,message:[{type:'text',data:{text}}]});
test('independent agenda preserves owner-only command handling and does not forward or send duplicate replies',async()=>{
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
test('agenda deactivation restores QQ directly and reactivation adopts the relay without changing credentials',async()=>{
  const {world}=fixture();const calls=[];let current='ws://127.0.0.1:3002';
  const fetcher=async(url,opts)=>{const method=url.split('/').at(-1),body=JSON.parse(opts.body);calls.push({method,args:body.args});return {ok:true,json:async()=>({enabled:true,wsUrl:current})};};
  world.stopped=true;assert.equal(await world.switchQQRoute('ws://127.0.0.1:3001',fetcher),true);assert.deepEqual(calls[1],{method:'setConnection',args:['ws://127.0.0.1:3001','']});
  calls.length=0;current='ws://127.0.0.1:3001';world.stopped=false;
  assert.equal(await world.switchQQRoute('ws://127.0.0.1:3002',fetcher),true);assert.deepEqual(calls[1].args,['ws://127.0.0.1:3002','']);
  calls.length=0;current='ws://127.0.0.1:3999';assert.equal(await world.switchQQRoute('ws://127.0.0.1:3002',fetcher),false);assert.equal(calls.length,1);
});
test('release exposes the agenda panel only',()=>{assert.equal(typeof webui.panels.agenda.mount,'function');assert.deepEqual(Object.keys(webui.panels),['agenda']);});
test('language adapter automatically prefers activeProvider from deployment config and falls back to other configured providers',async()=>{
  const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agenda-llm-')),deployment=path.join(root,'companion'),dataDir=path.join(deployment,'data');
  fs.mkdirSync(path.join(deployment,'workspace'),{recursive:true});fs.mkdirSync(dataDir,{recursive:true});
  fs.writeFileSync(path.join(deployment,'workspace','CONSTITUTION.md'),'Persona');
  fs.writeFileSync(path.join(deployment,'config.json'),JSON.stringify({activeProvider:'gemini'}));
  fs.mkdirSync(path.join(root,'providers','gemini'),{recursive:true});
  fs.writeFileSync(path.join(root,'providers','gemini','config.json'),JSON.stringify({kind:'coo',baseUrl:'https://generativelanguage.googleapis.com/v1beta',secret:'GEMINI_API_KEY',spec:{model:'gemini-3.8-flash'}}));
  fs.writeFileSync(path.join(root,'providers','gemini','.env'),'GEMINI_API_KEY=test-gemini-key\n');
  const calls=[];
  const llm=createAgendaDeepSeek({dataDir,repoRoot:root,providerFactory:{create:(name,entry,host)=>{
    calls.push({name,model:entry.spec.model,key:host.secret(entry.secret)});
    return {client:{respond:async()=>({attempts:[],response:{output:[{type:'message',content:[{type:'output_text',text:'{"action":"ignore"}'}]}]}})}};
  }}});
  assert.deepEqual(await llm.interpret({text:'hi'}),{action:'ignore'});
  assert.deepEqual(calls,[{name:'gemini',model:'gemini-3.8-flash',key:'test-gemini-key'}]);
  fs.rmSync(root,{recursive:true,force:true});
});
