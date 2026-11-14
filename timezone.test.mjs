import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {resolveTimezone,systemTimezone,eventTimezone,localInput,localToISO,validISO} from './cortico-world-personal-agenda-local/window/agenda-time.mjs';
import {createAgendaEditor} from './cortico-world-personal-agenda-local/src/agenda-editor.mjs';
import {startAgendaService} from './cortico-world-personal-agenda-local/src/agenda-service.mjs';
import {dateLabel,shortDateLabel,remaining,agendaEvents} from './cortico-world-personal-agenda-local/window/countdown-model.mjs';
const now=Date.parse('2026-01-01T00:00:00Z');
const log={info(){},warn(){},error(){}};
function fixture(t,timezone){
  const dataDir=mkdtempSync(join(tmpdir(),'agenda-timezone-'));t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
  const file=join(dataDir,'personal-agenda.json');writeFileSync(file,JSON.stringify({schema_version:1,...(timezone?{timezone}:{}),events:[]}));
  return {dataDir,file,editor:createAgendaEditor({dataDir,clock:()=>now})};
}
const event={title:'Fixture',start:'2030-02-01T20:00:59+08:00',enabled:true,status:'confirmed',reminders_minutes:[0]};
test('unspecified zone follows the runtime system and explicit zones work independently of it',()=>{
  assert.equal(resolveTimezone(),systemTimezone());assert.equal(resolveTimezone('local'),systemTimezone());assert.throws(()=>resolveTimezone('not/a-zone'));
  const script="console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)";
  assert.equal(execFileSync(process.execPath,['-e',script],{env:{...process.env,TZ:'America/New_York'},encoding:'utf8'}).trim(),'America/New_York');
  assert.equal(localInput('2030-01-01T00:00:00Z','Asia/Tokyo'),'2030-01-01T09:00');
  assert.equal(localInput('2030-01-01T00:00:00Z','America/New_York'),'2029-12-31T19:00');
});
test('wall-time conversion uses the offset at the event date, including quarter-hour zones',()=>{
  assert.equal(localToISO('2030-07-01T20:00','America/New_York'),'2030-07-01T20:00:00-04:00');
  assert.equal(localToISO('2030-01-01T20:00','America/New_York'),'2030-01-01T20:00:00-05:00');
  assert.equal(localToISO('2030-01-01T20:00','Asia/Kathmandu'),'2030-01-01T20:00:00+05:45');
  assert.equal(localToISO('2030-01-01T20:00','UTC'),'2030-01-01T20:00:00Z');
  for(const value of ['2030-02-30T20:00','2030-01-01T24:00'])assert.throws(()=>localToISO(value,'UTC'));
  assert.equal(validISO('2030-02-30T20:00:00Z'),false);
});
test('DST gaps are rejected and repeated hours require an explicit occurrence',()=>{
  assert.throws(()=>localToISO('2027-03-14T02:30','America/New_York'),e=>e.code==='invalid-time');
  assert.throws(()=>localToISO('2027-11-07T01:30','America/New_York'),e=>e.code==='ambiguous-time');
  const early=localToISO('2027-11-07T01:30','America/New_York','earlier'),late=localToISO('2027-11-07T01:30','America/New_York','later');
  assert.equal(early,'2027-11-07T01:30:00-04:00');assert.equal(late,'2027-11-07T01:30:00-05:00');assert.equal(Date.parse(late)-Date.parse(early),3600000);
  const a=localToISO('2027-04-04T01:45','Australia/Lord_Howe','earlier'),b=localToISO('2027-04-04T01:45','Australia/Lord_Howe','later');assert.equal(Date.parse(b)-Date.parse(a),1800000);
});
test('each event persists its own zone without changing its instant, sibling events or receipts',t=>{
  const x=fixture(t,'Europe/London'),saved=x.editor.save({event:{...event,timezone:'America/New_York'}}).event;
  const sibling=x.editor.save({event:{...event,title:'Sibling',timezone:'Asia/Tokyo'}}).event;writeFileSync(join(x.dataDir,'personal-agenda-delivery.json'),'receipt unchanged');
  const edited=x.editor.save({event:{id:saved.id,timezone:'Asia/Tokyo'},expectedRevision:saved.revision}).event;assert.equal(edited.start,event.start);
  assert.deepEqual(JSON.parse(readFileSync(x.file)).events.find(e=>e.id===sibling.id),((({revision,...e})=>e)(sibling)));
  assert.equal(readFileSync(join(x.dataDir,'personal-agenda-delivery.json'),'utf8'),'receipt unchanged');
  const restarted=createAgendaEditor({dataDir:x.dataDir,clock:()=>now});assert.equal(restarted.snapshot().events.find(e=>e.id===saved.id).timezoneSetting,'Asia/Tokyo');
  assert.throws(()=>restarted.save({event:{id:saved.id,timezone:'UTC'},expectedRevision:saved.revision}),e=>e.code==='conflict');
});
test('browser local input is resolved on the backend, with DST and concurrent zone-change protection',t=>{
  const x=fixture(t,'America/New_York');
  const data={event:{...event,start:undefined,timezone:'America/New_York'},localStart:'2027-11-07T01:30',timezone:'America/New_York'};
  assert.throws(()=>x.editor.save(data),e=>e.code==='ambiguous-time');
  const saved=x.editor.save({...data,occurrence:'later'}).event;assert.equal(saved.start,'2027-11-07T01:30:00-05:00');
  x.editor.save({event:{id:saved.id,timezone:'Asia/Tokyo'},expectedRevision:saved.revision});
  assert.throws(()=>x.editor.save({...data,occurrence:'earlier',event:{...saved},expectedRevision:saved.revision}),e=>e.code==='conflict');
  assert.equal(x.editor.snapshot().events[0].start,saved.start);
});
test('QQ commands and natural edits use each event zone, while new unspecified items follow the system',async t=>{
  const x=fixture(t,'America/New_York');let time=Date.parse('2030-06-30T00:00:00Z'),context;const sent=[];
  let intent={action:'add',title:'Natural',timezone:'America/New_York',start:'2030-07-02T20:00:00-04:00',time_text:'20:00',reminders_minutes:[0]};
  const service=startAgendaService({dataDir:x.dataDir,ownerQQ:()=>12345,connected:()=>true,clock:()=>time,autoStart:false,log,
    interpret:async ctx=>{context=ctx;return intent;},
    send:async(id,text)=>{sent.push(text);return {message_id:sent.length};}});t.after(()=>service.stop());
  assert.match(service.command('/日程 添加 2030-07-01 20:00 @America/New_York Command'),/已保存/);
  assert.equal(service.list()[0].start,'2030-07-01T20:00:00-04:00');
  await service.natural('纽约7月2日20:00提醒我 Natural');assert.equal(context.timezone,systemTimezone());assert.equal(context.events[0].timezone,'America/New_York');assert.equal(context.events[0].local_start,'2030-07-01 20:00');
  assert.equal(service.list()[1].start,'2030-07-02T20:00:00-04:00');
  intent={action:'update',id:service.list()[1].id,start:'2030-07-02T21:00:00-04:00',time_text:'21:00'};await service.natural('改到21:00');assert.equal(service.list()[1].timezone,'America/New_York');assert.equal(service.list()[1].start,'2030-07-02T21:00:00-04:00');
  assert.match(service.command('/日程 添加 2030-07-03 20:00 System default'),/已保存/);assert.equal(service.list()[2].timezone,'local');
  time=Date.parse(service.list()[0].start);await service.poll();assert.equal(sent.length,1);assert.match(sent[0],/2030-07-01 20:00/);assert.match(sent[0],/America\/New_York/);await service.poll();assert.equal(sent.length,1);
});
test('a zone change during model generation invalidates stale reminder wording without changing its instant',async t=>{
  const x=fixture(t);const e=x.editor.save({event:{...event,timezone:'America/New_York'}}).event;let release,count=0;const sent=[];
  const service=startAgendaService({dataDir:x.dataDir,ownerQQ:()=>12345,connected:()=>true,clock:()=>Date.parse(e.start),autoStart:false,log,
    generate:()=>++count===1?new Promise(r=>{release=r;}):'Reminder',send:async(id,text)=>{sent.push(text);return {message_id:1};}});t.after(()=>service.stop());
  const work=service.poll();await new Promise(r=>setTimeout(r,0));x.editor.save({event:{id:e.id,timezone:'Asia/Tokyo'},expectedRevision:e.revision});release('Old');await work;assert.equal(sent.length,0);
  await service.poll();assert.equal(sent.length,1);assert.match(sent[0],/Asia\/Tokyo/);assert.match(sent[0],/21:00/);assert.equal(x.editor.snapshot().events[0].start,e.start);
});
test('legacy items retain their old zone and new items ignore the legacy document default',t=>{
  const x=fixture(t,'America/New_York'),doc=JSON.parse(readFileSync(x.file));doc.events=[{...event,id:'legacy'}];writeFileSync(x.file,JSON.stringify(doc));
  assert.equal(x.editor.snapshot().events[0].resolvedTimezone,'America/New_York');assert.equal(eventTimezone(doc.events[0],doc),'America/New_York');
  const created=x.editor.save({event:{...event,title:'New'}}).event;assert.equal(created.timezone,'local');
  const current=x.editor.snapshot().events.find(e=>e.id==='legacy'),edited=x.editor.save({event:{id:'legacy',title:'Legacy edited'},expectedRevision:current.revision}).event;
  assert.equal(edited.timezone,'America/New_York');assert.equal(edited.start,event.start);
});
test('simultaneous mixed-zone reminders and widget projections use each event zone independently',async t=>{
  const x=fixture(t,'Europe/London'),start='2030-07-02T00:00:00Z';
  x.editor.save({event:{...event,title:'NY',start,timezone:'America/New_York'}});x.editor.save({event:{...event,title:'Tokyo',start,timezone:'Asia/Tokyo'}});
  const projected=agendaEvents(JSON.parse(readFileSync(x.file)));assert.deepEqual(projected.map(e=>e.timezone),['America/New_York','Asia/Tokyo']);
  const sent=[],service=startAgendaService({dataDir:x.dataDir,ownerQQ:()=>12345,connected:()=>true,clock:()=>Date.parse(start),autoStart:false,log,send:async(id,text)=>{sent.push(text);return {message_id:sent.length};}});t.after(()=>service.stop());
  await service.poll();await service.poll();assert.equal(sent.length,2);assert.match(sent[0],/2030-07-01 20:00.*America\/New_York/);assert.match(sent[1],/2030-07-02 09:00.*Asia\/Tokyo/);
});
test('countdown formatting uses the selected zone and compares years there, while durations remain invariant',()=>{
  const start='2030-01-01T00:30:00Z',now=Date.parse('2029-12-31T23:30:00Z');
  assert.match(dateLabel(start,'America/New_York'),/12月31日.*19:30/);assert.match(dateLabel(start,'Asia/Tokyo'),/1月1日.*09:30/);
  assert.doesNotMatch(shortDateLabel(start,now,'America/New_York'),/2030/);assert.match(shortDateLabel(start,now,'UTC'),/2030/);assert.equal(remaining(start,now).total,3600);
});
