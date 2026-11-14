import test from 'node:test';
import assert from 'node:assert/strict';
import { agendaEvents, cleanPreferences, selectedEvent, remaining, dateLabel, fitBounds } from './cortico-world-personal-agenda-local/window/countdown-model.mjs';

const event = (id, start, extra = {}) => ({ id, start, title: id, enabled: true, status: 'confirmed', ...extra });
const agenda = events => agendaEvents({ schema_version: 1, events });
const now = Date.parse('2026-11-03T12:00:00+08:00');

test('upcoming selection ignores completed/disabled events and advances precisely at the boundary', () => {
  const events = agenda([
    event('next', '2026-11-04T12:00:00+08:00'),
    event('disabled', '2026-11-03T12:30:00+08:00', { enabled: false }),
    event('past', '2026-11-01T12:00:00+08:00'),
    event('first', '2026-11-03T13:00:00+08:00'),
  ]);
  assert.equal(selectedEvent(events, null, now).id, 'first');
  assert.equal(selectedEvent(events, 'next', now).id, 'next');
  assert.equal(selectedEvent(events, 'first', now + 3600000).id, 'next');
  assert.equal(selectedEvent(events, 'deleted', now).id, 'first');
  assert.equal(selectedEvent(events, null, now + 86400000), null);
});

test('countdown recalculates from wall clock after sleep and never becomes negative', () => {
  const target = '2026-11-04T23:00:00+08:00';
  assert.deepEqual(remaining(target, now), { days: 1, hours: 11, minutes: 0, seconds: 0, total: 126000 });
  assert.deepEqual(remaining(target, now + 34.5 * 3600000), { days: 0, hours: 0, minutes: 30, seconds: 0, total: 1800 });
  assert.equal(remaining(target, now + 40 * 3600000).total, 0);
  assert.equal(remaining(target, Date.parse(target) - 1).seconds, 1);
});

test('read-only projection retains tentative flags, distinguishes stream/source, rejects unsafe URLs', () => {
  const [item] = agenda([event('zelda', '2026-11-04T23:00:00+08:00', {
    status: 'tentative', url: 'javascript:alert(1)',
    notes: '直播 https://www.youtube.com/live/test\n说明 https://www.youtube.com.evil.example/live/fake',
  })]);
  assert.equal(item.status, 'tentative');
  assert.equal(item.stream, 'https://www.youtube.com/live/test');
  assert.equal(item.url, null);
  assert.equal(agenda([event('x', '2026-11-04T23:00:00')]).length, 0);
  assert.throws(() => agendaEvents({ events: [] }));
});

test('time labels use the selected zone independently of the operating-system time zone', () => {
  const label = dateLabel('2026-11-04T15:00:00Z','Asia/Shanghai');
  assert.match(label, /11月4日/); assert.match(label, /23:00/);
});

test('preferences tolerate corrupt settings and preserve selected event and window state', () => {
  assert.deepEqual(cleanPreferences(null), { visible: true, topmost: true, collapsed: false, selectedId: null });
  assert.deepEqual(cleanPreferences({ visible: false, topmost: false, collapsed: true, selectedId: 'gta6-hk', x: -1200, y: 80 }),
    { visible: false, topmost: false, collapsed: true, selectedId: 'gta6-hk', x: -1200, y: 80 });
  assert.equal(cleanPreferences({ x: NaN, selectedId: '<script>' }).selectedId, null);
});

test('restoring positions keeps the card accessible when a monitor was removed', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };
  const secondary = { x: -1920, y: 0, width: 1920, height: 1040 };
  assert.equal(fitBounds({ x: -1300, y: 100 }, [primary, secondary]).x, -1300);
  assert.equal(fitBounds({ x: -1300, y: 100 }, [primary]).x, 0);
  assert.equal(fitBounds({ x: 1900, y: 1000 }, [primary]).x, 1560);
  assert.equal(fitBounds({ x: 1900, y: 1000 }, [primary]).y, 760);
});

test('card labels: year only when it differs, relative distance, and urgency bands', async () => {
  const { shortDateLabel, relativeLabel, urgency } = await import('./cortico-world-personal-agenda-local/window/countdown-model.mjs');
  assert.doesNotMatch(shortDateLabel('2026-11-12T20:00:00+08:00', now,'Asia/Shanghai'), /2026/);
  assert.match(shortDateLabel('2026-11-12T20:00:00+08:00', now,'Asia/Shanghai'), /11月12日.*20:00/);
  assert.match(shortDateLabel('2027-01-02T08:00:00+08:00', now,'Asia/Shanghai'), /2027/);
  assert.equal(relativeLabel('2026-11-06T13:00:00+08:00', now), '3 天后');
  assert.equal(relativeLabel('2026-11-03T17:30:00+08:00', now), '5 小时后');
  assert.equal(relativeLabel('2026-11-03T12:00:20+08:00', now), '1 分钟后');
  assert.equal(urgency('2026-11-05T12:00:00+08:00', now), 'later');
  assert.equal(urgency('2026-11-04T11:00:00+08:00', now), 'today');
  assert.equal(urgency('2026-11-03T12:59:00+08:00', now), 'soon');
});
