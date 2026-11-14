import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {eventFormat,eventName} from './cortico-world-personal-agenda-local/window/event-format.mjs';
import {agendaEvents,eventHeading,gameHeading} from './cortico-world-personal-agenda-local/window/countdown-model.mjs';
import {createAgendaEditor} from './cortico-world-personal-agenda-local/src/agenda-editor.mjs';
test('explicit main title, Chinese subtitle, short remark and long details map independently without preset overrides',()=>{
  const e={id:'lol-worlds-2026-final',title:'Custom main title',subtitle:'自定义副标题',remark:'决赛 · Bo5',details:'完整说明'};
  assert.deepEqual(eventHeading(e),{original:'Custom main title',translation:'自定义副标题',activity:'决赛 · Bo5',language:'en'});
  assert.deepEqual(gameHeading(e),eventHeading(e));
  assert.equal(eventName(e),'Custom main title｜决赛 · Bo5');assert.equal(eventFormat(e).details,'完整说明');
  assert.equal(eventHeading({...e,remark:'',subtitle:''}).activity,'');assert.equal(eventHeading({...e,remark:'',subtitle:''}).translation,'');
});
test('legacy pipe labels and notes are read without inventing a translation, while explicit empty fields clear them',()=>{
  assert.deepEqual(eventFormat({title:'Title｜标签',notes:'旧长备注'}),{title:'Title',subtitle:'',remark:'标签',details:'旧长备注'});
  assert.equal(eventFormat({title:'Literal | title',remark:'',details:'',notes:'old'}).title,'Literal | title');
  assert.equal(eventFormat({title:'Title',details:'',notes:'old'}).details,'');
});
test('widget projection retains the presentation and finds video links in details',()=>{
  const e={id:'fixture',title:'Main',subtitle:'副标题',remark:'小标签',details:'直播 https://www.youtube.com/live/example',enabled:true,status:'confirmed',start:'2031-01-01T20:00:00+08:00'};
  const p=agendaEvents({schema_version:1,events:[e]})[0];assert.equal(p.remark,'小标签');assert.equal(p.subtitle,'副标题');assert.match(p.stream,/youtube/);
  const bili=agendaEvents({schema_version:1,events:[{...e,details:'直播 https://live.bilibili.com/12345'}]})[0];
  assert.equal(bili.stream,'https://live.bilibili.com/12345');
});
test('legacy records are normalized only on save and retain IDs, event timing and other metadata',()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'agenda-presentation-')),file=join(dataDir,'personal-agenda.json');
  const old={id:'legacy',title:'Main｜Tag',notes:'Full explanation',enabled:true,status:'tentative',start:'2031-01-01T20:00:00+08:00',reminders_minutes:[30,0]};
  const raw=JSON.stringify({schema_version:1,events:[old]});writeFileSync(file,raw);const editor=createAgendaEditor({dataDir,clock:()=>Date.parse('2030-01-01T00:00:00Z')});
  const view=editor.snapshot().events[0];assert.equal(readFileSync(file,'utf8'),raw);assert.equal(view.title,'Main');assert.equal(view.remark,'Tag');assert.equal(view.details,'Full explanation');
  const {revision,...event}=view;const result=editor.save({event:{...event,subtitle:'翻译',remark:'New Tag',details:'New details'},expectedRevision:revision}).event;
  assert.equal(result.id,old.id);assert.equal(result.start,old.start);assert.deepEqual(result.reminders_minutes,old.reminders_minutes);assert.equal(result.notes,undefined);assert.equal(result.remark,'New Tag');assert.equal(result.details,'New details');
});
