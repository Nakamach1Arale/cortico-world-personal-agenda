import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAgendaService, agendaCommandText, validateAgenda } from './cortico-world-personal-agenda-local/src/agenda-service.mjs';

// Pin the local clock for these legacy scenarios; mixed zones have dedicated coverage.
process.env.TZ='Asia/Hong_Kong';

const owner = 123456789;
const log = { info() {}, warn() {}, error() {} };
function setup(t, patch = {}, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coopanion-agenda-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'personal-agenda.json');
  const now = { value: Date.parse('2026-11-18T23:30:00+08:00') };
  const event = { id: 'gta6', title: 'GTA6港版', start: '2026-11-19T00:00:00+08:00',
    enabled: true, status: 'confirmed', reminders_minutes: [1440, 30, 0], ...patch };
  writeFileSync(path, JSON.stringify({ schema_version: 1, timezone:'Asia/Hong_Kong', events: [event] }));
  const sent = [];
  const args = { dataDir: dir, ownerQQ: () => owner, connected: () => true, clock: () => now.value,
    autoStart: false, log, send: async (id, text) => { sent.push({ id, text }); return { message_id: 100 + sent.length }; }, ...options };
  const service = startAgendaService(args);
  return { dir, path, now, sent, args, service };
}

test('only owner private messages enter the deterministic agenda command path', () => {
  const ev = { post_type: 'message', message_type: 'private', self_id: 999999999,
    user_id: owner, message: [{ type: 'text', data: { text: '/日程' } }] };
  assert.equal(agendaCommandText(ev, owner), '/日程');
  for (const change of [{ user_id: owner + 1 }, { message_type: 'group' }, { post_type: 'message_sent' },
    { self_id: owner }, { message: '/日程外的闲聊' }])
    assert.equal(agendaCommandText({ ...ev, ...change }, owner), null);
});

test('due reminders use HK time, fixed owner, acknowledgement and persistence across restart', async t => {
  const x = setup(t);
  await x.service.poll();
  assert.equal(x.sent.length, 1);
  assert.equal(x.sent[0].id, owner);
  assert.match(x.sent[0].text, /2026-11-19 00:00/);
  await x.service.poll();
  await x.service.stop();
  const restarted = startAgendaService(x.args);
  await restarted.poll();
  assert.equal(x.sent.length, 1);
  x.now.value += 30 * 60000;
  await restarted.poll();
  assert.equal(x.sent.length, 2);
  assert.match(x.sent[1].text, /已到安排的时间/);
  await restarted.stop();
});

test('offline and paused reminders wait, reconnect sends latest useful reminder only', async t => {
  let connected = false, paused = false;
  const x = setup(t, {}, { connected: () => connected, paused: () => paused });
  await x.service.poll(); assert.equal(x.sent.length, 0);
  connected = true; paused = true;
  await x.service.poll(); assert.equal(x.sent.length, 0);
  paused = false; x.now.value += 30 * 60000;
  await x.service.poll(); assert.equal(x.sent.length, 1);
  assert.match(x.sent[0].text, /已到安排的时间/);
  const delivery = JSON.parse(readFileSync(join(x.dir, 'personal-agenda-delivery.json'), 'utf8'));
  assert.equal(Object.values(delivery.deliveries).filter(r => r.status === 'superseded').length, 1);
});

test('missing receipt retries with backoff; expired reminders are not sent', async t => {
  let tries = 0;
  const x = setup(t, {}, { send: async () => ++tries > 1 ? { message_id: 888 } : {} });
  await x.service.poll(); await x.service.poll(); assert.equal(tries, 1);
  x.now.value += 30000;
  await x.service.poll(); assert.equal(tries, 2);
  x.now.value += 48 * 3600000;
  await x.service.poll(); assert.equal(tries, 2);
});

test('owner can add, reschedule and cancel, with validation and uncertain facts preserved', async t => {
  const x = setup(t, { status: 'tentative', notes: '具体时间待官方确认' });
  assert.match(x.service.overview(), /【预计】/);
  assert.match(x.service.command('/日程 修改 gta6 2026-11-20 01:00 新时间'), /日程已保存/);
  assert.equal(x.service.list()[0].status, 'tentative');
  assert.equal(x.service.list()[0].notes, '具体时间待官方确认');
  await x.service.poll(); assert.equal(x.sent.length, 0);
  assert.match(x.service.command('/日程 添加 2026-11-21 20:00 测试事项'), /日程已保存/);
  assert.equal(x.service.list().length, 2);
  assert.match(x.service.command('/日程 取消 gta6'), /已取消/);
  assert.equal(x.service.list().length, 1);
  assert.match(x.service.command('/日程 添加 2026-02-30 20:00 无效'), /有效.*日期/);
  assert.match(x.service.command('/日程 添加 2026-11-22 25:00 无效'), /有效.*日期/);
});

test('reminders keep estimated timing without asking the owner to confirm it', async t => {
  const x = setup(t, { title: '时之笛｜解锁', status: 'tentative' }, {
    generate: async () => '有件事想请你确认一下，方便的话看一眼就好。',
  });
  await x.service.poll();
  assert.equal(x.sent.length, 1);
  assert.match(x.sent[0].text, /^日程提醒【预计】\n时之笛｜解锁/);
  assert.doesNotMatch(x.sent[0].text, /确认|核对|核实|检查/);
  assert.equal(x.service.list()[0].status, 'tentative');
});

test('corrupt agenda fails closed and can recover after file repair', async t => {
  const x = setup(t), good = readFileSync(x.path, 'utf8');
  writeFileSync(x.path, 'broken');
  await x.service.poll(); assert.equal(x.sent.length, 0);
  assert.ok(x.service.status().last_error);
  writeFileSync(x.path, good);
  await x.service.poll(); assert.equal(x.sent.length, 1);
  assert.equal(x.service.status().last_error, null);
});

test('setup announcement is delivered once with schedule and command instructions', async t => {
  const x = setup(t, { start: '2026-12-01T00:00:00+08:00' });
  const doc = JSON.parse(readFileSync(x.path, 'utf8'));
  doc.announcement_id = 'setup-v1'; writeFileSync(x.path, JSON.stringify(doc));
  await x.service.poll(); await x.service.poll();
  assert.equal(x.sent.length, 1);
  assert.match(x.sent[0].text, /日程提醒已接入/);
  assert.match(x.sent[0].text, /\/日程 帮助/);
  await x.service.stop();
  const restarted = startAgendaService(x.args);
  await restarted.poll(); assert.equal(x.sent.length, 1);
  await restarted.stop();
});


test('natural add and follow-up update persist exact facts and context', async t => {
  const contexts = [], expressions = [];
  const x = setup(t, {}, { interpret: async ctx => {
    contexts.push(ctx);
    return contexts.length === 1 ? { action: 'add', title: '喝水', start: '2026-11-19T20:00:00+08:00', time_text: '明晚八点', reminders_minutes: [0] }
      : { action: 'update', id: ctx.history[0].result.event.id, start: '2026-11-19T21:00:00+08:00', time_text: '九点' };
  }, generate: async x => { expressions.push(x); return '好啦，记住了。'; } });
  const before = x.service.list().length;
  assert.match(await x.service.natural('明晚八点提醒我喝水'), /2026-11-19 20:00/);
  assert.match(await x.service.natural('改到九点'), /2026-11-19 21:00/);
  assert.equal(x.service.list().length, before + 1);
  assert.equal(contexts[1].history.length, 1);
  assert.equal(expressions.length, 2);
  assert.deepEqual(x.service.list().find(e => e.title === '喝水').reminders_minutes, [0]);
});

test('natural ambiguity asks a follow-up without writing a guessed event', async t => {
  const x = setup(t, {}, { interpret: async ctx => ctx.history.length
    ? { action: 'add', title: '拿快递', start: '2026-11-19T20:00:00+08:00', time_text: '晚上八点' }
    : { action: 'clarify', question: '明天几点提醒你？' } });
  const original = readFileSync(x.path, 'utf8');
  assert.equal(await x.service.natural('明天提醒我拿快递'), '明天几点提醒你？');
  assert.equal(readFileSync(x.path, 'utf8'), original);
  assert.match(await x.service.natural('晚上八点'), /日程已保存/);
});

test('natural queries filter exact ranges and ordinary chat does not mutate or answer', async t => {
  let intent = { action: 'ignore' };
  const x = setup(t, {}, { interpret: async () => intent });
  assert.equal(await x.service.natural('我想玩游戏'), null);
  intent = { action: 'list', from: '2026-11-19T00:00:00+08:00', to: '2026-11-20T00:00:00+08:00' };
  assert.match(await x.service.natural('明天有什么安排'), /GTA6港版/);
  intent = { action: 'list', from: '2026-11-20T00:00:00+08:00' };
  assert.match(await x.service.natural('后天之后呢'), /没有符合/);
  assert.equal(x.service.list().length, 1);
});

test('natural mutation rejects invalid dates, guessed IDs, invalid offsets and model-supplied status upgrades', async t => {
  let intent;
  const x = setup(t, { status: 'tentative' }, { interpret: async () => intent });
  for (const bad of [
    { action: 'add', title: '无效', start: '2027-02-30T20:00:00+08:00' },
    { action: 'update', id: 'unknown', start: '2027-01-01T20:00:00+08:00' },
    { action: 'add', title: '无效', start: '2027-01-01T20:00:00+08:00', reminders_minutes: [-1] },
  ]) {
    intent = bad; assert.doesNotMatch(await x.service.natural('安排提醒'), /日程已保存/);
    assert.equal(x.service.list().length, 1);
  }
  intent = { action: 'update', id: 'gta6', title: '改标题', status: 'confirmed' };
  await x.service.natural('改标题');
  assert.equal(x.service.list()[0].status, 'tentative');
  intent = { action: 'cancel', id: 'gta6' };
  assert.match(await x.service.natural('取消刚才那条'), /已取消/);
  assert.equal(x.service.list().length, 0);
});

test('model outage preserves agenda and generated wording failure retains exact reminder facts', async t => {
  const x = setup(t, { status: 'tentative' }, { interpret: async () => { throw new Error('offline'); },
    generate: async () => { throw new Error('offline'); } });
  const original = readFileSync(x.path, 'utf8');
  assert.match(await x.service.natural('明天提醒我拿快递'), /没有保存或修改/);
  assert.equal(readFileSync(x.path, 'utf8'), original);
  await x.service.poll();
  assert.match(x.sent[0].text, /【预计】/);
  assert.match(x.sent[0].text, /2026-11-19 00:00/);
});

test('cancel during model generation prevents sending a stale reminder', async t => {
  let service;
  const x = setup(t, {}, { generate: async () => { service.command('/日程 取消 gta6'); return '开场白'; } });
  service = x.service;
  await service.poll();
  assert.equal(x.sent.length, 0);
});

test('a concurrent external schedule edit is not overwritten by a stale model result', async t => {
  let file;
  const x = setup(t, {}, { interpret: async () => {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    doc.events[0].title = '外部更新'; writeFileSync(file, JSON.stringify(doc));
    return { action: 'update', id: 'gta6', start: '2026-11-20T20:00:00+08:00' };
  } });
  file = x.path;
  assert.match(await x.service.natural('改到后天晚上八点'), /刚发生了变动/);
  assert.equal(x.service.list()[0].title, '外部更新');
  assert.equal(x.service.list()[0].start, '2026-11-19T00:00:00+08:00');
});

test('a model cannot invent a missing or ambiguous time even when it outputs valid JSON', async t => {
  let quoted = '明天';
  const x = setup(t, {}, { interpret: async () => ({ action: 'add', title: '拿快递',
    start: '2026-11-19T09:00:00+08:00', time_text: quoted }) });
  assert.match(await x.service.natural('明天提醒我拿快递'), /几点/);
  quoted = '上午九点';
  assert.match(await x.service.natural('明天提醒我拿快递'), /几点/);
  quoted = '九点';
  assert.match(await x.service.natural('明天九点提醒我拿快递'), /几点/);
  assert.equal(x.service.list().length, 1);
});

test('screenshot regression: quoted event weekday follows the event rather than today, including legacy ID-only history', async t => {
  const contexts=[];
  const x=setup(t,{id:'zelda-jp',title:'时之笛 日版',start:'2026-11-04T23:00:00+08:00',status:'tentative'},
    {interpret:async ctx=>{contexts.push(ctx);return ctx.text.includes('时之笛')?{action:'list',id:'zelda-jp'}:{action:'ignore'};}});
  x.now.value=Date.parse('2026-10-30T19:10:00+08:00');
  const first=await x.service.natural('时之笛周几解锁来着');
  assert.match(first,/星期三/);
  const reply=await x.service.natural('这是周几');
  assert.match(reply,/2026-11-04 23:00（星期三）/);assert.doesNotMatch(reply,/星期五/);
  assert.equal(contexts[1].focus_events[0].weekday,'星期三');
  assert.match(contexts[1].history[0].reply,/星期三/);
  assert.equal(await x.service.natural('今天周几'),null);
  assert.match(x.service.chatContext(),/星期三/);
  writeFileSync(join(x.dir,'personal-agenda-dialogue.json'),JSON.stringify({owner,at:x.now.value,
    turns:[{user:'时之笛周几解锁来着',result:{action:'list',ids:['zelda-jp']}}]}));
  assert.match(await x.service.natural('那是礼拜几来着'),/星期三/);
});

test('multiple event referents clarify and expired or different-owner context is not reused', async t => {
  const x=setup(t,{}, {interpret:async()=>({action:'ignore'})});
  const doc=JSON.parse(readFileSync(x.path,'utf8'));doc.events.push({...doc.events[0],id:'another',title:'另一项'});
  writeFileSync(x.path,JSON.stringify(doc));
  const contextPath=join(x.dir,'personal-agenda-dialogue.json');
  writeFileSync(contextPath,JSON.stringify({owner,at:x.now.value,turns:[{user:'最近日程',result:{action:'list',ids:['gta6','another']}}]}));
  assert.match(await x.service.natural('这是周几'),/哪一项/);
  x.now.value+=31*60000;
  assert.equal(x.service.chatContext(),null);assert.equal(await x.service.natural('这是周几'),null);
  writeFileSync(contextPath,JSON.stringify({owner:owner+1,at:x.now.value,turns:[{user:'别人的安排',result:{action:'list',ids:['gta6']}}]}));
  assert.equal(x.service.chatContext(),null);
});
