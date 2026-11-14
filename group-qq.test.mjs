import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import definition,{PersonalAgendaWorld} from './cortico-world-personal-agenda-local/src/index.mjs';
import {agendaRequest,reminderTargets} from './cortico-world-personal-agenda-local/src/qq-targets.mjs';
import {connectionDraft} from './cortico-world-personal-agenda-local/src/qq-connection.mjs';
import {startAgendaService} from './cortico-world-personal-agenda-local/src/agenda-service.mjs';
import {OneBotRelay} from './cortico-world-personal-agenda-local/src/onebot-relay.mjs';
import WebSocket,{WebSocketServer} from './cortico-world-personal-agenda-local/vendor/ws/wrapper.mjs';
const log={info(){},warn(){},error(){}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async check=>{for(let i=0;i<200;i++){if(check())return;await sleep(10);}throw new Error('Timed out waiting for fixture');};
const group=(role='member',user=12345,id=1,groupId=54321,text='/日程 添加 2031-11-10 20:00 群内事项')=>({post_type:'message',message_type:'group',self_id:99999,user_id:user,group_id:groupId,message_id:id,raw_message:text,sender:{role,nickname:'Fixture'}});
const privateMessage=(user=12345,text='/日程')=>({post_type:'message',message_type:'private',self_id:99999,user_id:user,message_id:11,raw_message:text});
test('empty defaults and legacy owner/official chat lists never opt anyone into reminders or commands',()=>{
  const cfg=definition.defaults();assert.equal(cfg.privateQQ,0);assert.equal(cfg.groupId,0);assert.equal(cfg.masterQQ,0);
  for(const key of ['allowGroupAdd','groupAddByOwner','groupAddByAdmin','groupAddByGroupOwner'])assert.equal(cfg[key],false);
  const old={...cfg,ownerQQ:12345,masterQQ:12345};assert.deepEqual(reminderTargets(old),[]);assert.equal(agendaRequest(old,privateMessage()),null);assert.equal(agendaRequest(old,group('owner')),null);
});
test('three group identities are independent, require the target group and master switch, and never allow self events',()=>{
  const base={...definition.defaults(),groupId:54321,masterQQ:12345,allowGroupAdd:true};
  for(const [key,allowed,denied]of [['groupAddByOwner',group('member',12345),group('member',23456)],['groupAddByAdmin',group('admin',23456),group('owner',23456)],['groupAddByGroupOwner',group('owner',23456),group('admin',23456)]]){
    const cfg={...base,[key]:true};assert.ok(agendaRequest(cfg,allowed));assert.equal(agendaRequest(cfg,denied),null);
    assert.equal(agendaRequest({...cfg,allowGroupAdd:false},allowed),null);assert.equal(agendaRequest({...cfg,groupId:65432},allowed),null);assert.equal(agendaRequest(cfg,{...allowed,user_id:99999}),null);
    for(const text of ['/日程','/日程 取消 old','/日程 修改 old 2031-11-10 20:00 标题','明天提醒我','聊天里提到 /日程 添加'])assert.equal(agendaRequest(cfg,{...allowed,raw_message:text}),null);
  }
});
test('private filtering uses the explicitly entered private target, independently from master and group roles',()=>{
  const cfg={...definition.defaults(),privateQQ:12345,masterQQ:23456,groupId:54321,allowGroupAdd:true,groupAddByOwner:true};
  assert.ok(agendaRequest(cfg,privateMessage(12345)));assert.equal(agendaRequest(cfg,privateMessage(23456)),null);assert.ok(agendaRequest(cfg,group('member',23456)));
  assert.equal(agendaRequest({...cfg,privateQQ:0},privateMessage(12345)),null);
});
test('connection drafts validate all target and role fields without inferring any numbers',()=>{
  const ctx={cfg:definition.defaults()},empty=connectionDraft(ctx,{}).cfg;assert.equal(empty.privateQQ,0);assert.equal(empty.groupId,0);assert.equal(empty.masterQQ,0);
  for(const data of [{privateQQ:'abc'},{groupId:'123'},{masterQQ:'not-qq'},{allowGroupAdd:'true'},{groupAddByAdmin:1},{groupId:54321,allowGroupAdd:true},{allowGroupAdd:true,groupAddByAdmin:true},{groupId:54321,allowGroupAdd:true,groupAddByOwner:true}])assert.throws(()=>connectionDraft(ctx,data));
  const cfg=connectionDraft(ctx,{groupId:'54321',allowGroupAdd:true,groupAddByAdmin:true}).cfg;assert.equal(cfg.privateQQ,0);assert.equal(cfg.masterQQ,0);assert.equal(cfg.groupId,54321);
});
function senderFixture(cfg={}){
  const dataDir=mkdtempSync(join(tmpdir(),'agenda-group-send-')),world=new PersonalAgendaWorld({dataDir,cfg:{...definition.defaults(),...cfg}}),sent=[],events=[];
  world.stopped=false;world.host={isPaused:()=>false,log,pushEvent:async e=>events.push(e),store:{range:()=>[]}};world.relay={ready:true,selfId:99999,nickname:'Fixture',callApi:async(action,params)=>{sent.push({action,params});return {message_id:sent.length};}};
  return {world,sent,events};
}
test('sending uses the correct private/group APIs and rejects unconfigured recipients, including the master',async()=>{
  const {world,sent,events}=senderFixture({privateQQ:12345,groupId:54321,masterQQ:23456});await world.send({kind:'private',id:12345},'Private');await world.send({kind:'group',id:54321},'Group');
  assert.deepEqual(sent.map(s=>s.action),['send_private_msg','send_group_msg']);assert.equal(sent[0].params.user_id,12345);assert.equal(sent[1].params.group_id,54321);assert.equal(events[1].meta.conv.kind,'group');
  for(const target of [{kind:'private',id:23456},{kind:'private',id:54321},{kind:'group',id:12345},{kind:'unknown',id:54321}])await assert.rejects(world.send(target,'Invalid'));
  assert.equal(sent.length,2);world.ctx.cfg.privateQQ=0;world.ctx.cfg.groupId=0;await assert.rejects(world.send(23456,'Master'));assert.equal(sent.length,2);
});
const now=Date.parse('2030-01-01T00:00:00Z');

test('revoking group permission while a reply awaits pause status prevents the send',async()=>{
  const {world,sent}=senderFixture({groupId:54321,allowGroupAdd:true,groupAddByAdmin:true});let release;
  world.refreshPause=()=>new Promise(resolve=>{release=resolve;});
  const work=world.send({kind:'group',id:54321},'Stale reply',{request:group('admin')});world.ctx.cfg.groupAddByAdmin=false;release();await assert.rejects(work);assert.deepEqual(sent,[]);
});
function reminders(options={}){
  const dataDir=mkdtempSync(join(tmpdir(),'agenda-group-delivery-'));let time=now;
  writeFileSync(join(dataDir,'personal-agenda.json'),JSON.stringify({schema_version:1,announcement_id:'old-setup',events:[{id:'fixture',title:'Shared fixture',start:'2030-01-01T00:00:00Z',enabled:true,status:'confirmed',reminders_minutes:[0]}]}));
  const opts={dataDir,ownerQQ:()=>12345,clock:()=>time,targets:()=>[],connected:()=>true,send:async()=>{throw new Error('unexpected send');},autoStart:false,log,...options};
  return {dataDir,opts,time:value=>{time=value;},service:startAgendaService(opts)};
}
test('empty explicit targets send nothing, even with a legacy owner and setup announcement',async()=>{
  const x=reminders();await x.service.poll();assert.equal(existsSync(join(x.dataDir,'personal-agenda-delivery.json')),false);await x.service.stop();
});
test('private and group reminders retain separate receipts, retries and deduplication after restart',async()=>{
  let groupAttempts=0;const sent=[],targets=[{kind:'private',id:12345},{kind:'group',id:54321}];
  const x=reminders({targets:()=>targets,send:async(target,text)=>{sent.push({target,text});if(target.kind==='group'&&++groupAttempts===1)throw new Error('group temporarily offline');return {message_id:sent.length};}});
  await x.service.poll();await x.service.poll();assert.equal(sent.length,2);assert.ok(sent.every(s=>!s.text.includes('日程提醒已接入')));
  x.time(now+30000);await x.service.poll();assert.equal(sent.length,3);assert.equal(sent.filter(s=>s.target.kind==='private').length,1);await x.service.stop();
  const again=startAgendaService(x.opts);await again.poll();await again.stop();assert.equal(sent.length,3);const state=JSON.parse(readFileSync(join(x.dataDir,'personal-agenda-delivery.json'),'utf8'));assert.equal(Object.values(state.deliveries).filter(d=>d.status==='sent').length,2);
});
test('removing or changing targets during reminder generation cannot send stale work',async()=>{
  let targets=[{kind:'group',id:54321}],version=0,release;const sent=[];const x=reminders({targets:()=>targets,deliveryVersion:()=>version,generate:()=>new Promise(r=>{release=r;}),send:async t=>{sent.push(t);return {message_id:1};}});
  const work=x.service.poll();await sleep(0);targets=[{kind:'group',id:65432}];version++;release('Fixture');await work;assert.deepEqual(sent,[]);assert.equal(existsSync(join(x.dataDir,'personal-agenda-delivery.json')),false);await x.service.stop();
});

test('matching numeric private and group IDs still have independent delivery receipts',async()=>{
  const sent=[],x=reminders({targets:()=>[{kind:'private',id:12345},{kind:'group',id:12345}],send:async target=>{sent.push(target);return {message_id:sent.length};}});
  await x.service.poll();await x.service.poll();await x.service.stop();assert.deepEqual(sent,[{kind:'private',id:12345},{kind:'group',id:12345}]);
  const state=JSON.parse(readFileSync(join(x.dataDir,'personal-agenda-delivery.json'),'utf8'));assert.equal(Object.values(state.deliveries).filter(d=>d.status==='sent').length,2);
});
test('a legacy private receipt does not suppress a newly configured group reminder',async()=>{
  const sent=[],x=reminders({legacyOwnerQQ:12345,targets:()=>[{kind:'private',id:12345},{kind:'group',id:54321}],send:async target=>{sent.push(target);return {message_id:1};}});await x.service.stop();
  writeFileSync(join(x.dataDir,'personal-agenda-delivery.json'),JSON.stringify({schema_version:1,deliveries:{[`event:fixture:${now}:0`]:{status:'sent',message_id:'old-private-receipt'}}}));
  const again=startAgendaService(x.opts);await again.poll();await again.stop();assert.deepEqual(sent,[{kind:'group',id:54321}]);
});
test('group-only relay processes an authorized add once and forwards unrelated messages without leaking another schedule',async t=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');let remote;const actions=[];
  server.on('connection',socket=>{remote=socket;socket.on('message',raw=>{const req=JSON.parse(raw);actions.push(req);socket.send(JSON.stringify({echo:req.echo,status:'ok',retcode:0,data:req.action==='get_login_info'?{user_id:99999,nickname:'Fixture'}:{message_id:actions.length}}));});});
  const dataDir=mkdtempSync(join(tmpdir(),'agenda-group-relay-')),cfg={...definition.defaults(),connectionMode:'manual',useToken:false,upstreamUrl:`ws://127.0.0.1:${server.address().port}`,groupId:54321,allowGroupAdd:true,groupAddByAdmin:true};
  writeFileSync(join(dataDir,'personal-agenda.json'),JSON.stringify({schema_version:1,events:[{id:'other',title:'Unrelated private fixture',start:'2031-12-01T00:00:00Z',enabled:true,status:'confirmed',reminders_minutes:[]}]}));
  const ctx={dataDir,botDir:dataDir,repoRoot:dataDir,cfg,secret:()=>'',persist:patch=>Object.assign(cfg,patch)},world=new PersonalAgendaWorld(ctx,{fetcher:async()=>({ok:false,json:async()=>({})}),readOfficial:()=>null,makeRelay:options=>new OneBotRelay({...options,port:0}),makeWindow:()=>({start:async()=>{},stop:async()=>{},status:()=>({running:true})})});let client;
  t.after(async()=>{client?.terminate();await world.stop();for(const socket of server.clients)socket.terminate();await new Promise(r=>server.close(r));});
  await world.start({isPaused:()=>false,log,store:{range:()=>[]},pushEvent:async()=>{},reportUsage(){}});await world.connectionTask;assert.equal(world.state().connected,true);assert.equal(cfg.privateQQ,0);
  client=new WebSocket(`ws://127.0.0.1:${world.relay.status().port}`);await once(client,'open');const forwarded=[];client.on('message',raw=>forwarded.push(JSON.parse(raw)));
  const allowed=group('admin',23456,1);remote.send(JSON.stringify(allowed));remote.send(JSON.stringify(allowed));remote.send(JSON.stringify(group('member',34567,2)));remote.send(JSON.stringify(group('admin',23456,3,65432)));remote.send(JSON.stringify(group('admin',23456,4,54321,'普通聊天')));remote.send(JSON.stringify(privateMessage(12345)));
  await until(()=>actions.filter(a=>a.action==='send_group_msg').length===1&&forwarded.length===4);const replies=actions.filter(a=>a.action==='send_group_msg');assert.equal(replies[0].params.group_id,54321);assert.match(replies[0].params.message[0].data.text,/群内事项/);assert.doesNotMatch(replies[0].params.message[0].data.text,/Unrelated private fixture/);assert.equal(actions.filter(a=>a.action==='send_private_msg').length,0);assert.equal(world.editor.snapshot().events.length,2);assert.deepEqual(forwarded.map(e=>e.message_id).sort((a,b)=>a-b),[2,3,4,11]);
});
