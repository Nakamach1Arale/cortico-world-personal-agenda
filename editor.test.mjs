import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createAgendaEditor} from './cortico-world-personal-agenda-local/src/agenda-editor.mjs';
import {startAgendaService} from './cortico-world-personal-agenda-local/src/agenda-service.mjs';
const now=Date.parse('2030-01-01T08:00:00+08:00');
const input=()=>({title:'Test event',start:'2030-02-01T20:00:00+08:00',enabled:true,status:'tentative',reminders_minutes:[30,0],notes:'note',url:'https://example.com/event'});
function fixture(){const dataDir=mkdtempSync(join(tmpdir(),'agenda-editor-'));return {dataDir,editor:createAgendaEditor({dataDir,clock:()=>now})};}
test('UI create/update/cancel/restore shares the original file and preserves IDs, metadata and delivery ledger',()=>{
  const {dataDir,editor}=fixture();writeFileSync(join(dataDir,'personal-agenda-delivery.json'),'unchanged');
  const created=editor.save({event:input()});const id=created.event.id;
  const edited=editor.save({event:{...created.event,title:'Changed',notes:'',url:''},expectedRevision:created.event.revision});
  assert.equal(edited.event.id,id);assert.equal(edited.event.status,'tentative');assert.equal(edited.event.notes,undefined);assert.equal(edited.event.url,undefined);
  const cancelled=editor.setEnabled({id,enabled:false,expectedRevision:edited.event.revision});assert.equal(cancelled.event.enabled,false);
  editor.setEnabled({id,enabled:true,expectedRevision:cancelled.event.revision});assert.equal(editor.snapshot().events.length,1);
  assert.equal(readFileSync(join(dataDir,'personal-agenda-delivery.json'),'utf8'),'unchanged');
});
test('conflicting browser and QQ changes are rejected, unrelated changes are preserved',()=>{
  const {dataDir,editor}=fixture(),old=editor.save({event:input()}).event;
  const doc=JSON.parse(readFileSync(join(dataDir,'personal-agenda.json'),'utf8'));doc.events[0].title='Changed through QQ';doc.announcement_id='keep';writeFileSync(join(dataDir,'personal-agenda.json'),JSON.stringify(doc));
  assert.throws(()=>editor.save({event:{...old,title:'Stale browser'},expectedRevision:old.revision}),/新改动/);
  assert.throws(()=>editor.setEnabled({id:old.id,expectedRevision:old.revision,enabled:false}),/新改动/);
  const current=editor.snapshot().events[0];editor.save({event:{...current,title:'Fresh browser'},expectedRevision:current.revision});
  assert.equal(JSON.parse(readFileSync(join(dataDir,'personal-agenda.json'),'utf8')).announcement_id,'keep');
});
test('calendar validation rejects normalized invalid dates, past activation, unsafe links and bad reminder offsets',()=>{
  const {editor}=fixture();
  for(const change of [{start:'2030-02-30T20:00:00+08:00'},{start:'2030-02-01T24:00:00+08:00'},{start:'2020-01-01T20:00:00+08:00'},{url:'javascript:alert(1)'},{url:'https://user:password@example.com/'},{reminders_minutes:[0,0]},{reminders_minutes:[-1]},{reminders_minutes:['30']},{reminders_minutes:[1,2,3,4,5,6]},{title:'bad\nline'}])assert.throws(()=>editor.save({event:{...input(),...change}}));
  const past=editor.save({event:{...input(),enabled:false,start:'2020-01-01T20:00:00+08:00'}}).event;
  assert.throws(()=>editor.setEnabled({id:past.id,expectedRevision:past.revision,enabled:true}),/时间已过/);
});
test('duplicate creates do not add another event; corrupt data is never overwritten',()=>{
  const {editor,dataDir}=fixture();const first=editor.save({event:input()});const second=editor.save({event:input()});assert.equal(second.duplicate,true);assert.equal(second.event.id,first.event.id);assert.equal(editor.snapshot().events.length,1);
  writeFileSync(join(dataDir,'personal-agenda.json'),'broken');assert.throws(()=>editor.save({event:input()}));assert.equal(readFileSync(join(dataDir,'personal-agenda.json'),'utf8'),'broken');
});
test('editing a title during reminder generation cancels stale output and uses the next poll without duplicate delivery',async()=>{
  const {dataDir}=fixture(),editor=createAgendaEditor({dataDir,clock:()=>now});
  const e=editor.save({event:{...input(),start:'2030-01-01T08:01:00+08:00',reminders_minutes:[0]}}).event;
  let release,calls=0;const sent=[];let clock=now;
  const service=startAgendaService({dataDir,ownerQQ:()=>12345,connected:()=>true,paused:()=>false,clock:()=>clock,autoStart:false,log:{warn(){},error(){}},generate:()=>++calls===1?new Promise(r=>{release=r;}):Promise.resolve('提醒'),send:async(id,text)=>{sent.push(text);return {message_id:7};}});
  clock+=60000;const pending=service.poll();await new Promise(r=>setTimeout(r,0));editor.save({event:{...e,title:'New title'},expectedRevision:e.revision});release('提醒');await pending;assert.equal(sent.length,0);await service.poll();assert.match(sent[0],/New title/);await service.poll();assert.equal(sent.length,1);await service.stop();
});
