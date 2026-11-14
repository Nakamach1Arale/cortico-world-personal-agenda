import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startAgendaService} from './cortico-world-personal-agenda-local/src/agenda-service.mjs';
import {PersonalAgendaWorld} from './cortico-world-personal-agenda-local/src/index.mjs';
const initial=Date.parse('2030-01-01T00:00:00Z');
const log={warn(){},info(){},error(){}};
function setup(){
  const dataDir=mkdtempSync(join(tmpdir(),'qq-reminders-switch-'));let time=initial,enabled=false;
  writeFileSync(join(dataDir,'personal-agenda.json'),JSON.stringify({schema_version:1,events:[{id:'fixture',title:'Reminder',start:'2030-01-01T08:01:00+08:00',status:'confirmed',enabled:true,reminders_minutes:[0]}]}));
  const sent=[],options={dataDir,ownerQQ:()=>12345,connected:()=>true,paused:()=>false,remindersEnabled:()=>enabled,clock:()=>time,autoStart:false,log,send:async(id,text)=>{sent.push({id,text});return {message_id:42};}};
  return {dataDir,sent,options,time:v=>{time=v;},enable:v=>{enabled=v;}};
}
test('disabled reminders leave the ledger untouched, and reenable resumes a useful reminder once',async()=>{
  const x=setup(),service=startAgendaService(x.options);x.time(initial+60000);
  await service.poll();assert.equal(x.sent.length,0);assert.equal(existsSync(join(x.dataDir,'personal-agenda-delivery.json')),false);
  assert.equal(service.status().reminders_enabled,false);assert.match(service.command('/日程'),/Reminder/);
  x.enable(true);await service.poll();await service.poll();assert.equal(x.sent.length,1);await service.stop();
});
test('switching off during generation prevents a reminder without writing retry state',async()=>{
  const x=setup();x.enable(true);let release;const service=startAgendaService({...x.options,generate:()=>new Promise(r=>{release=r;})});x.time(initial+60000);
  const work=service.poll();await new Promise(r=>setTimeout(r,0));x.enable(false);release('提醒');await work;
  assert.equal(x.sent.length,0);assert.equal(existsSync(join(x.dataDir,'personal-agenda-delivery.json')),false);await service.stop();
});
test('notification setting persists independently of window settings and still permits requested replies',async()=>{
  const x=setup(),cfg={privateQQ:12345,qqRemindersEnabled:true};
  const settings=join(x.dataDir,'settings.json'),ctx={cfg,dataDir:x.dataDir,persist:patch=>{Object.assign(cfg,patch);writeFileSync(settings,JSON.stringify(cfg));}};
  const world=new PersonalAgendaWorld(ctx);world.stopped=false;world.host={isPaused:()=>false,log,pushEvent:async()=>{}};
  world.relay={ready:true,selfId:99999,nickname:'fixture',status:()=>({ready:true}),callApi:async()=>({message_id:43})};
  const api=world.webUi().invoke;assert.equal((await api('agenda','set-qq-reminders',[false])).ok,true);
  assert.equal(JSON.parse(readFileSync(settings,'utf8')).qqRemindersEnabled,false);assert.equal(world.state().window.visible,true);
  await assert.rejects(world.send(12345,'automatic',{reminder:true}),/已关闭/);assert.equal((await world.send(12345,'requested reply')).message_id,43);
  const restarted=new PersonalAgendaWorld({...ctx,cfg:JSON.parse(readFileSync(settings,'utf8'))});assert.equal(restarted.remindersEnabled(),false);
  assert.equal((await api('agenda','set-qq-reminders',['false'])).ok,false);assert.equal((await api('agenda','set-qq-reminders',[true])).ok,true);
});
