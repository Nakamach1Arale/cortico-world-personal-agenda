import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import WebSocket,{WebSocketServer} from './cortico-world-personal-agenda-local/vendor/ws/wrapper.mjs';
import definition,{PersonalAgendaWorld} from './cortico-world-personal-agenda-local/src/index.mjs';
import {OneBotRelay} from './cortico-world-personal-agenda-local/src/onebot-relay.mjs';
import {probeOneBot,LEGACY_SECRET,resolveConnection} from './cortico-world-personal-agenda-local/src/qq-connection.mjs';
import {startAgendaService} from './cortico-world-personal-agenda-local/src/agenda-service.mjs';
const {readAgendaDocument}=createRequire(import.meta.url)('./cortico-world-personal-agenda-local/window/countdown.cjs');
const log={info(){},warn(){},error(){}};
function setup(t,patch={},options={}){
  const dir=mkdtempSync(join(tmpdir(),'qq-setup-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const cfg={...definition.defaults(),...patch},secrets=new Map();let writes=0,secretWrites=0,windows=0;const calls=[],relays=[];
  const ctx={cfg,dataDir:dir,botDir:dir,repoRoot:dir,secret:key=>secrets.get(key)??'',storeSecret:(key,value)=>{secretWrites++;secrets.set(key,value);},persist:patch=>{writes++;Object.assign(cfg,patch);writeFileSync(join(dir,'settings.json'),JSON.stringify(cfg));}};
  const official=options.official??null;
  const fetcher=async(url,opts)=>{const method=url.split('/').at(-1),args=JSON.parse(opts.body??'{}').args;calls.push({method,args});if(!official)return {ok:false,status:404,json:async()=>({})};if(method==='setConnection')official.wsUrl=args[0];return {ok:true,json:async()=>({enabled:official.enabled!==false,wsUrl:official.wsUrl})};};
  const world=new PersonalAgendaWorld(ctx,{readOfficial:()=>official,fetcher,probe:options.probe,makeRelay:options.makeRelay??(settings=>{const relay={settings,ready:false,clients:new Set(),stops:0,async start(){this.ready=true;},async stop(){this.ready=false;this.stops++;},status(){return {connected:this.ready,clients:0,port:settings.port,lastError:null};}};relays.push(relay);return relay;}),makeWindow:()=>{windows++;return {running:false,async start(){this.running=true;},async stop(){this.running=false;},status(){return {running:this.running};},async command(){}};}});
  const host={isPaused:()=>false,log,store:{range:()=>[]},pushEvent:async()=>{},reportUsage(){}};
  t.after(()=>world.stop());return {ctx,cfg,secrets,calls,relays,world,dir,host,start:async()=>{await world.start(host);await world.connectionTask;},counts:()=>({writes,secretWrites,windows})};
}
test('fresh install without any QQ settings starts the calendar and countdown and permits editing',async t=>{
  const x=setup(t);await x.start();const state=x.world.state();assert.equal(state.window.running,true);assert.equal(state.agenda.enabled,true);assert.equal(state.connected,false);assert.equal(state.connection.error.code,'not_configured');assert.equal(x.relays.length,0);
  const result=await x.world.webUi().invoke('agenda','save-event',[{event:{title:'Offline event',start:'2031-01-01T20:00:00Z',status:'confirmed',enabled:true,reminders_minutes:[]}}]);assert.equal(result.ok,true);assert.equal(x.world.state().events.length,1);assert.equal(x.calls.length,0);
});
test('a missing first-install agenda file renders empty rather than a read error; corruption is preserved',t=>{
  const x=setup(t),file=join(x.dir,'personal-agenda.json');assert.deepEqual(readAgendaDocument(file),{schema_version:1,events:[]});assert.equal(existsSync(file),false);
  writeFileSync(file,'broken');assert.throws(()=>readAgendaDocument(file));assert.equal(readFileSync(file,'utf8'),'broken');
});

test('upgrading a legacy owner restores ordinary QQ without selecting any reminder destinations',async t=>{
  const official={enabled:true,wsUrl:'ws://127.0.0.1:3902',token:'private-fixture',privates:[{id:12345,enabled:true}],groups:[{id:54321,enabled:true}]};
  const x=setup(t,{ownerQQ:12345,managedQQRoute:true,relayPort:3902,upstreamUrl:'ws://127.0.0.1:3901'},{official});await x.start();
  const state=x.world.state();for(const key of ['privateQQ','groupId','masterQQ'])assert.equal(state.connection[key],0);
  assert.equal(state.connected,false);assert.equal(x.relays.length,0);assert.equal(state.window.running,true);assert.equal(official.wsUrl,'ws://127.0.0.1:3901');assert.equal(official.token,'private-fixture');assert.equal(x.cfg.managedQQRoute,false);assert.equal('suggestedOwnerQQ' in state.connection,false);
});
test('missing official configuration is reported without taking down the calendar or countdown',async t=>{
  const x=setup(t,{privateQQ:12345});await x.start();assert.equal(x.world.state().connection.error.code,'official_missing');assert.equal(x.world.state().window.running,true);assert.equal(x.world.service.status().enabled,true);
});
test('official QQ settings are reused privately and route changes preserve the original token',async t=>{
  const official={enabled:true,wsUrl:'ws://127.0.0.1:3901',token:'official-private-token',privates:[{id:98765,enabled:true}]};
  const x=setup(t,{privateQQ:12345},{official});await x.start();assert.equal(x.relays[0].settings.token,official.token);assert.equal(x.relays[0].settings.upstreamUrl,'ws://127.0.0.1:3901/');
  const state=x.world.state();assert.equal(state.connected,true);assert.equal(state.connection.privateQQ,12345);assert.equal(x.counts().secretWrites,0);assert.equal(JSON.stringify(state).includes(official.token),false);assert.ok(x.calls.some(c=>c.method==='setConnection'&&c.args[1]===''));
  await x.world.stop();assert.equal(official.wsUrl,'ws://127.0.0.1:3901/');assert.equal(official.token,'official-private-token');
});
test('connection checks only inspect a draft and never save a secret or change the live route',async t=>{
  let checked;const x=setup(t,{}, {probe:async settings=>{checked=settings;return {ok:true,message:'connected'};}});await x.start();
  const before=x.counts();const result=await x.world.testConnection({mode:'manual',privateQQ:'12345',upstreamUrl:'ws://127.0.0.1:3901',relayPort:3902,token:'draft-private-token'});
  assert.equal(result.ok,true);assert.equal(checked.token,'draft-private-token');assert.deepEqual(x.counts(),before);assert.equal(x.calls.length,0);assert.equal(x.cfg.privateQQ,0);assert.equal(JSON.stringify(result).includes('draft-private-token'),false);
});
test('manual connection settings persist a secret reference, not the token, and leave calendar data intact',async t=>{
  const x=setup(t);await x.start();writeFileSync(join(x.dir,'personal-agenda.json'),JSON.stringify({schema_version:1,events:[]}));writeFileSync(join(x.dir,'personal-agenda-delivery.json'),'unchanged');const original=readFileSync(join(x.dir,'personal-agenda.json'),'utf8');
  const result=await x.world.saveConnection({mode:'manual',privateQQ:'12345',upstreamUrl:'ws://127.0.0.1:3901',relayPort:3902,token:'manual-private-token',noToken:false});
  assert.equal(result.ok,true);assert.equal(result.connected,true);assert.equal(x.ctx.secret(x.cfg.tokenSecretKey),'manual-private-token');assert.equal(readFileSync(join(x.dir,'settings.json'),'utf8').includes('manual-private-token'),false);assert.equal(JSON.stringify(result).includes('manual-private-token'),false);
  assert.equal(readFileSync(join(x.dir,'personal-agenda.json'),'utf8'),original);assert.equal(readFileSync(join(x.dir,'personal-agenda-delivery.json'),'utf8'),'unchanged');assert.equal(x.counts().windows,1);
});
test('invalid values cannot change live settings or store tokens, and failed persistence restores the live configuration',async t=>{
  const x=setup(t);await x.start();
  for(const change of [{privateQQ:'abc'},{relayPort:80},{relayPort:70000},{upstreamUrl:'https://example.com'},{upstreamUrl:'ws://user:secret@127.0.0.1:3901'},{upstreamUrl:'ws://127.0.0.1:3901?access_token=secret'},{token:'not a token'}]){
    const result=await x.world.saveConnection({mode:'manual',privateQQ:12345,relayPort:3902,upstreamUrl:'ws://127.0.0.1:3901',...change});assert.equal(result.ok,false);assert.equal(x.cfg.privateQQ,0);
  }
  assert.equal(x.counts().secretWrites,0);const old={...x.cfg};x.ctx.persist=patch=>{Object.assign(x.cfg,patch);throw new Error('private failing token');};
  const failed=await x.world.saveConnection({mode:'manual',privateQQ:12345,relayPort:3902,upstreamUrl:'ws://127.0.0.1:3901',token:'new-private-token'});assert.equal(failed.code,'save_failed');assert.deepEqual(x.cfg,old);assert.ok(!JSON.stringify(failed).includes('private failing token'));assert.equal(x.world.window.running,true);
});
test('changing the local relay port restores the old route before adopting the new one without restarting the countdown',async t=>{
  const official={enabled:true,wsUrl:'ws://127.0.0.1:3901',token:''};const x=setup(t,{privateQQ:12345,relayPort:3902},{official});await x.start();x.calls.length=0;
  const result=await x.world.saveConnection({mode:'official',privateQQ:12345,relayPort:3903});assert.equal(result.connected,true);assert.deepEqual(x.calls.filter(c=>c.method==='setConnection').map(c=>c.args[0]),['ws://127.0.0.1:3901/','ws://127.0.0.1:3903']);assert.equal(x.relays[0].stops,1);assert.equal(x.counts().windows,1);
  const disabled=await x.world.saveConnection({mode:'official',privateQQ:'',relayPort:3903});assert.equal(disabled.ok,true);assert.equal(disabled.connected,false);assert.equal(disabled.window.running,true);assert.equal(official.wsUrl,'ws://127.0.0.1:3901/');
});
test('official endpoints cannot accidentally point the relay back into itself',()=>{
  assert.throws(()=>resolveConnection({connectionMode:'official',privateQQ:12345,relayPort:3902},{official:{wsUrl:'ws://127.0.0.1:3902',token:''}}),e=>e.code==='relay_loop');
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
test('a local tokenless OneBot connection works and a busy relay port remains an optional QQ error',async t=>{
  const upstream=await oneBot(t);assert.equal((await probeOneBot({upstreamUrl:upstream.url,token:''})).ok,true);
  const relay=new OneBotRelay({port:0,upstreamUrl:upstream.url,token:'',ownerQQ:()=>12345,onMessage:async()=>false,log});t.after(()=>relay.stop());await relay.start();for(let i=0;i<100&&!relay.ready;i++)await new Promise(r=>setTimeout(r,10));assert.equal(relay.ready,true);
  const downstream=new WebSocket(`ws://127.0.0.1:${relay.status().port}`);t.after(()=>downstream.terminate());await once(downstream,'open');const response=once(downstream,'message');downstream.send(JSON.stringify({action:'get_login_info',params:{},echo:'native-no-token'}));const [raw]=await response;assert.equal(JSON.parse(raw).echo,'native-no-token');
  const busy=createServer();await new Promise(r=>busy.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>busy.close(r)));
  const x=setup(t,{connectionMode:'manual',privateQQ:12345,upstreamUrl:upstream.url,relayPort:busy.address().port,useToken:false},{makeRelay:options=>new OneBotRelay(options)});await x.start();assert.equal(x.world.state().connection.error.code,'port_in_use');assert.equal(x.world.state().window.running,true);assert.equal(x.world.service.status().enabled,true);
});
test('changing recipient or connection while generation is in flight cannot send or save stale work',async t=>{
  const x=setup(t),start='2030-01-01T00:00:00Z',file=join(x.dir,'personal-agenda.json');writeFileSync(file,JSON.stringify({schema_version:1,events:[{id:'event',title:'Fixture',start,enabled:true,status:'confirmed',reminders_minutes:[0]}]}));
  let owner=12345,version=0,release;const sent=[];
  const service=startAgendaService({dataDir:x.dir,ownerQQ:()=>owner,deliveryVersion:()=>version,connected:()=>true,clock:()=>Date.parse(start),autoStart:false,log,generate:()=>new Promise(r=>{release=r;}),send:async(id,text)=>{sent.push(id);return {message_id:1};}});t.after(()=>service.stop());
  const pending=service.poll();await new Promise(r=>setTimeout(r,0));owner=98765;version++;release('Fixture');await pending;assert.deepEqual(sent,[]);assert.equal(existsSync(join(x.dir,'personal-agenda-delivery.json')),false);
  let resolveIntent;const natural=startAgendaService({dataDir:x.dir,ownerQQ:()=>owner,deliveryVersion:()=>version,connected:()=>true,autoStart:false,log,interpret:()=>new Promise(r=>{resolveIntent=r;}),send:async()=>{throw new Error('must not send');}});t.after(()=>natural.stop());const before=readFileSync(file,'utf8');
  const request=natural.natural('取消刚才那项日程');await new Promise(r=>setTimeout(r,0));owner=12345;version++;resolveIntent({action:'cancel',id:'event'});assert.equal(await request,null);assert.equal(readFileSync(file,'utf8'),before);assert.equal(existsSync(join(x.dir,'personal-agenda-dialogue.json')),false);
});
