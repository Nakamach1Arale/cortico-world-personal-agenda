import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {WebSocketServer} from './cortico-world-personal-agenda-local/vendor/ws/wrapper.mjs';
import definition,{PersonalAgendaWorld} from './cortico-world-personal-agenda-local/src/index.mjs';
import {OneBotClient} from './cortico-world-personal-agenda-local/src/onebot-relay.mjs';
import {probeOneBot} from './cortico-world-personal-agenda-local/src/qq-connection.mjs';
import {startAgendaService} from './cortico-world-personal-agenda-local/src/agenda-service.mjs';
const {readAgendaDocument}=createRequire(import.meta.url)('./cortico-world-personal-agenda-local/window/countdown.cjs');
const log={info(){},warn(){},error(){}};
function setup(t,patch={},options={}){
  const dir=mkdtempSync(join(tmpdir(),'qq-setup-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const cfg={...definition.defaults(),...patch},secrets=new Map();let writes=0,secretWrites=0,windows=0,runtimeInstalls=0;const relays=[];
  const ctx={cfg,dataDir:dir,botDir:dir,repoRoot:dir,secret:key=>secrets.get(key)??'',storeSecret:(key,value)=>{secretWrites++;secrets.set(key,value);},persist:patch=>{writes++;Object.assign(cfg,patch);writeFileSync(join(dir,'settings.json'),JSON.stringify(cfg));}};
  const world=new PersonalAgendaWorld(ctx,{probe:options.probe,makeRelay:options.makeRelay??(settings=>{const relay={settings,ready:false,stops:0,async start(){this.ready=true;},async stop(){this.ready=false;this.stops++;},status(){return {connected:this.ready,lastError:null};}};relays.push(relay);return relay;}),makeWindow:()=>{windows++;let installed=options.runtimeInstalled!==false;return {running:false,async start(){if(installed)this.running=true;},async installRuntime(){runtimeInstalls++;installed=true;this.running=true;},async stop(){this.running=false;},status(){return {running:this.running,runtime:{installed,canInstall:!installed,sourceDir:'C:/Coopanion',runtimeDir:join(dir,'runtime'),filesSummary:['Coopanion.exe']}};},async command(){}};}});
  const host={isPaused:()=>false,log,store:{range:()=>[]},pushEvent:async()=>{},reportUsage(){}};
  t.after(()=>world.stop());return {ctx,cfg,secrets,relays,world,dir,host,start:async()=>{await world.start(host);await world.connectionTask;},counts:()=>({writes,secretWrites,windows,runtimeInstalls})};
}
test('fresh install without any QQ settings starts the calendar and countdown and permits editing',async t=>{
  const x=setup(t);await x.start();const state=x.world.state();assert.equal(state.window.running,true);assert.equal(state.agenda.enabled,true);assert.equal(state.connected,false);assert.equal(state.connection.error.code,'not_configured');assert.equal(x.relays.length,0);
  const result=await x.world.webUi().invoke('agenda','save-event',[{event:{title:'Offline event',start:'2031-01-01T20:00:00Z',status:'confirmed',enabled:true,reminders_minutes:[]}}]);assert.equal(result.ok,true);assert.equal(x.world.state().events.length,1);
});
test('a missing first-install agenda file renders empty rather than a read error; corruption is preserved',t=>{
  const x=setup(t),file=join(x.dir,'personal-agenda.json');assert.deepEqual(readAgendaDocument(file),{schema_version:1,events:[]});assert.equal(existsSync(file),false);
  writeFileSync(file,'broken');assert.throws(()=>readAgendaDocument(file));assert.equal(readFileSync(file,'utf8'),'broken');
});
test('upgrading a legacy owner leaves recipients empty without opting anyone in',async t=>{
  const x=setup(t,{ownerQQ:12345,upstreamUrl:'ws://127.0.0.1:3901'});await x.start();
  const state=x.world.state();for(const key of ['privateQQ','groupId','masterQQ'])assert.equal(state.connection[key],0);
  assert.equal(state.connected,false);assert.equal(x.relays.length,0);assert.equal(state.window.running,true);
});
test('connection checks only inspect a draft and never save a secret or change live settings',async t=>{
  let checked;const x=setup(t,{}, {probe:async settings=>{checked=settings;return {ok:true,message:'connected'};}});await x.start();
  const before=x.counts();const result=await x.world.testConnection({privateQQ:'12345',upstreamUrl:'ws://127.0.0.1:3901',token:'draft-private-token'});
  assert.equal(result.ok,true);assert.equal(checked.token,'draft-private-token');assert.deepEqual(x.counts(),before);assert.equal(x.cfg.privateQQ,0);assert.equal(JSON.stringify(result).includes('draft-private-token'),false);
});
test('direct OneBot connection settings persist a secret reference, not the token, and leave calendar data intact',async t=>{
  const x=setup(t);await x.start();writeFileSync(join(x.dir,'personal-agenda.json'),JSON.stringify({schema_version:1,events:[]}));writeFileSync(join(x.dir,'personal-agenda-delivery.json'),'unchanged');const original=readFileSync(join(x.dir,'personal-agenda.json'),'utf8');
  const result=await x.world.saveConnection({privateQQ:'12345',upstreamUrl:'ws://127.0.0.1:3901',token:'manual-private-token',noToken:false});
  assert.equal(result.ok,true);assert.equal(result.connected,true);assert.equal(x.ctx.secret(x.cfg.tokenSecretKey),'manual-private-token');assert.equal(readFileSync(join(x.dir,'settings.json'),'utf8').includes('manual-private-token'),false);assert.equal(JSON.stringify(result).includes('manual-private-token'),false);
  assert.equal(readFileSync(join(x.dir,'personal-agenda.json'),'utf8'),original);assert.equal(readFileSync(join(x.dir,'personal-agenda-delivery.json'),'utf8'),'unchanged');assert.equal(x.counts().windows,1);
});
test('invalid values cannot change live settings or store tokens, and failed persistence restores the live configuration',async t=>{
  const x=setup(t);await x.start();
  for(const change of [{privateQQ:'abc'},{corePort:80},{corePort:70000},{upstreamUrl:'https://example.com'},{upstreamUrl:'ws://user:secret@127.0.0.1:3901'},{upstreamUrl:'ws://127.0.0.1:3901?access_token=secret'},{token:'not a token'}]){
    const result=await x.world.saveConnection({privateQQ:12345,upstreamUrl:'ws://127.0.0.1:3901',...change});assert.equal(result.ok,false);assert.equal(x.cfg.privateQQ,0);
  }
  assert.equal(x.counts().secretWrites,0);const old={...x.cfg};x.ctx.persist=patch=>{Object.assign(x.cfg,patch);throw new Error('private failing token');};
  const failed=await x.world.saveConnection({privateQQ:12345,upstreamUrl:'ws://127.0.0.1:3901',token:'new-private-token'});assert.equal(failed.code,'save_failed');assert.deepEqual(x.cfg,old);assert.ok(!JSON.stringify(failed).includes('private failing token'));assert.equal(x.world.window.running,true);
});
test('LLM settings persist secret reference via ctx.storeSecret without echoing key and allow clearing',async t=>{
  const x=setup(t);await x.start();
  const bad=await x.world.webUi().invoke('agenda','save-llm',[{baseUrl:'https://api.example.com/v1',model:''}]);assert.equal(bad.ok,false);
  const saved=await x.world.webUi().invoke('agenda','save-llm',[{baseUrl:'https://api.example.com/v1/',model:'deepseek-chat',apiKey:'sk-world-only',style:'温和简短'}]);
  assert.equal(saved.ok,true);assert.equal(saved.llm.configured,true);assert.equal(saved.llm.keySet,true);assert.equal(saved.llm.model,'deepseek-chat');assert.equal(saved.llm.style,'温和简短');
  assert.equal(x.ctx.secret(x.cfg.llmSecretKey),'sk-world-only');assert.equal(JSON.stringify(saved).includes('sk-world-only'),false);
  const cleared=await x.world.webUi().invoke('agenda','save-llm',[{baseUrl:'',model:'',clearKey:true,style:''}]);
  assert.equal(cleared.ok,true);assert.equal(cleared.llm.configured,false);assert.equal(cleared.llm.keySet,false);
});
test('widget runtime setup RPC requires explicit user confirmation before installing',async t=>{
  const x=setup(t,{},{runtimeInstalled:false});await x.start();
  assert.equal(x.world.state().window.running,false);assert.equal(x.counts().runtimeInstalls,0);
  const denied=await x.world.webUi().invoke('agenda','setup-widget-runtime',[{}]);assert.equal(denied.ok,false);assert.equal(x.counts().runtimeInstalls,0);
  const ok=await x.world.webUi().invoke('agenda','setup-widget-runtime',[{confirmed:true}]);assert.equal(ok.ok,true);assert.equal(ok.window.running,true);assert.equal(x.counts().runtimeInstalls,1);
});
async function oneBot(t,{token='',reply=true,loggedIn=true,nickname='Fixture'}={}){
  const actions=[],server=new WebSocketServer({host:'127.0.0.1',port:0,verifyClient:info=>!token||info.req.headers.authorization==='Bearer '+token});await once(server,'listening');
  server.on('connection',socket=>socket.on('message',raw=>{const req=JSON.parse(raw);actions.push(req.action);if(reply)socket.send(JSON.stringify({echo:req.echo,status:loggedIn?'ok':'failed',retcode:loggedIn?0:1,data:loggedIn?{user_id:99999,nickname}:null}));}));
  t.after(async()=>{for(const socket of server.clients)socket.terminate();await new Promise(r=>server.close(r));});return {url:`ws://127.0.0.1:${server.address().port}`,actions};
}
test('real OneBot probes report login, auth failure and timeout without sending any messages',async t=>{
  const normal=await oneBot(t,{token:'server-secret',nickname:'server-secret'}),success=await probeOneBot({upstreamUrl:normal.url,token:'server-secret'});assert.equal(success.ok,true);assert.equal(JSON.stringify(success).includes('server-secret'),false);assert.deepEqual(normal.actions,['get_login_info']);
  const failed=await probeOneBot({upstreamUrl:normal.url,token:'wrong'});assert.equal(failed.ok,false);assert.equal(failed.code,'auth_failed');
  const silent=await oneBot(t,{reply:false});assert.equal((await probeOneBot({upstreamUrl:silent.url,token:''},{timeoutMs:100})).code,'timeout');
  const loggedOut=await oneBot(t,{loggedIn:false});assert.equal((await probeOneBot({upstreamUrl:loggedOut.url,token:''})).code,'not_logged_in');
});
test('a local tokenless OneBot connection works directly',async t=>{
  const upstream=await oneBot(t);assert.equal((await probeOneBot({upstreamUrl:upstream.url,token:''})).ok,true);
  const client=new OneBotClient({upstreamUrl:upstream.url,token:'',ownerQQ:()=>12345,onMessage:async()=>false,log});t.after(()=>client.stop());await client.start();for(let i=0;i<100&&!client.ready;i++)await new Promise(r=>setTimeout(r,10));assert.equal(client.ready,true);
  const login=await client.callApi('get_login_info',{});assert.equal(login.user_id,99999);
});
test('changing recipient or connection while generation is in flight cannot send or save stale work',async t=>{
  const x=setup(t),start='2030-01-01T00:00:00Z',file=join(x.dir,'personal-agenda.json');writeFileSync(file,JSON.stringify({schema_version:1,events:[{id:'event',title:'Fixture',start,enabled:true,status:'confirmed',reminders_minutes:[0]}]}));
  let owner=12345,version=0,release;const sent=[];
  const service=startAgendaService({dataDir:x.dir,ownerQQ:()=>owner,deliveryVersion:()=>version,connected:()=>true,clock:()=>Date.parse(start),autoStart:false,log,generate:()=>new Promise(r=>{release=r;}),send:async(id,text)=>{sent.push(id);return {message_id:1};}});t.after(()=>service.stop());
  const pending=service.poll();await new Promise(r=>setTimeout(r,0));owner=98765;version++;release('Fixture');await pending;assert.deepEqual(sent,[]);assert.equal(existsSync(join(x.dir,'personal-agenda-delivery.json')),false);
  let resolveIntent;const natural=startAgendaService({dataDir:x.dir,ownerQQ:()=>owner,deliveryVersion:()=>version,connected:()=>true,autoStart:false,log,interpret:()=>new Promise(r=>{resolveIntent=r;}),send:async()=>{throw new Error('must not send');}});t.after(()=>natural.stop());const before=readFileSync(file,'utf8');
  const request=natural.natural('取消刚才那项日程');await new Promise(r=>setTimeout(r,0));owner=12345;version++;resolveIntent({action:'cancel',id:'event'});assert.equal(await request,null);assert.equal(readFileSync(file,'utf8'),before);assert.equal(existsSync(join(x.dir,'personal-agenda-dialogue.json')),false);
});
