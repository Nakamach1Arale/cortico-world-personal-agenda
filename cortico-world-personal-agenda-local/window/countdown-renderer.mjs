import { selectedEvent, upcomingEvents, remaining, eventHeading, shortDateLabel, relativeLabel, urgency } from './countdown-model.mjs';
const $ = id => document.getElementById(id);
let data = { events: [], preferences: {} }, listOpen = false, lastListKey = '', lastHeight = 0;
const act = (command, value) => window.countdown.action(command, value).catch(() => {
  $('notice').textContent = '操作失败，请重试'; $('notice').hidden = false;
});
const pad = number => String(number).padStart(2, '0');
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function spokenDuration(time) {
  const parts = [];
  if (time.days) parts.push(`${time.days} 天`);
  if (time.days || time.hours) parts.push(`${time.hours} 小时`);
  parts.push(`${time.minutes} 分`, `${time.seconds} 秒`);
  return '剩余 ' + parts.join(' ');
}

function renderClock(start) {
  const time = remaining(start);
  // Over an hour: optional whole days plus HH:MM:SS. Final hour: MM:SS only.
  const hms = time.total >= 3600 ? `${pad(time.hours)}:${pad(time.minutes)}:${pad(time.seconds)}` : `${pad(time.minutes)}:${pad(time.seconds)}`;
  $('days-part').hidden = time.days === 0;
  $('days').textContent = time.days;
  $('hms').textContent = hms; $('hms').hidden = false;
  $('empty').hidden = true;
  $('clock').classList.remove('is-empty');
  $('clock').classList.toggle('no-days', time.days === 0);
  $('clock').setAttribute('aria-label', spokenDuration(time));
}

function renderList(upcoming, current) {
  const minute = Math.floor(Date.now() / 60000);
  const key = JSON.stringify([upcoming, current?.id, data.preferences.selectedId, minute]);
  if (key === lastListKey) return;
  lastListKey = key;
  const fragment = document.createDocumentFragment();
  for (const event of upcoming) {
    const pinned = event.id === data.preferences.selectedId;
    const button = element('button', 'event' + (event.id === current?.id ? ' selected' : ''));
    button.type = 'button';
    button.setAttribute('aria-pressed', String(pinned));
    const heading = eventHeading(event);
    const what = element('span', 'event-what');
    const title = element('span', 'event-title', heading.original); title.lang = heading.language;
    const sub = element('span', 'event-sub');
    if (heading.activity) sub.append(element('span', 'activity', heading.activity));
    if (heading.translation) sub.append(element('span', 'translation-text', heading.translation));
    what.append(title); if (sub.childNodes.length) what.append(sub);
    const when = element('span', 'event-when');
    when.append(element('span', 'event-relative', relativeLabel(event.start)));
    const date = element('span', 'event-date', shortDateLabel(event.start,Date.now(),event.timezone)+` · ${event.timezone??Intl.DateTimeFormat().resolvedOptions().timeZone}`);
    if (event.status === 'tentative') date.prepend(element('span', 'event-flag', '预计 '));
    when.append(date);
    button.append(what, when);
    button.title = [heading.original, heading.translation, heading.activity].filter(Boolean).join('\n') +
      (pinned ? '\n已固定，点“跟随下一项”恢复自动' : '\n点击固定显示');
    button.addEventListener('click', () => act('select', event.id));
    fragment.append(button);
  }
  if (!upcoming.length) fragment.append(element('p', 'list-note', '没有接下来的日程'));
  $('events').replaceChildren(fragment);
}

function render() {
  const current = selectedEvent(data.events, data.preferences.selectedId);
  const upcoming = upcomingEvents(data.events);
  const collapsed = !!data.preferences.collapsed;
  const pinned = !!current && current.id === data.preferences.selectedId;
  $('card').classList.toggle('collapsed', collapsed);
  $('card').dataset.urgency = current ? urgency(current.start) : 'later';
  $('topmost').setAttribute('aria-pressed', String(data.preferences.topmost === true));
  $('topmost').title = data.preferences.topmost ? '取消置顶' : '置顶显示';
  $('topmost').setAttribute('aria-label', $('topmost').title);
  $('collapse').title = collapsed ? '展开' : '收起';
  $('collapse').setAttribute('aria-label', $('collapse').title);
  $('count').textContent = upcoming.length;
  $('list-section').hidden = !listOpen;
  $('list-toggle').setAttribute('aria-expanded', String(listOpen));
  $('auto').disabled = !data.preferences.selectedId;
  $('open').hidden = !(current?.url || current?.stream);
  $('open-label').textContent = current?.stream ? '观看直播' : '查看详情';
  $('pinned').hidden = !pinned;
  $('status').hidden = current?.status !== 'tentative';
  const timingNote = current?.status === 'tentative' ? '时间尚未确定，以官方公告为准' : '';
  const notice = data.error || data.preferenceError || timingNote;
  $('notice').textContent = notice; $('notice').hidden = !notice;

  if (current) {
    const heading = eventHeading(current);
    $('activity').textContent = heading.activity; $('activity').hidden = !heading.activity;
    const original = !collapsed && heading.language === 'ja' ? heading.original.replace(': ', ':\n') : heading.original;
    const mark = element('span', 'tentative-mark', '预计');
    mark.hidden = current.status !== 'tentative';
    $('title').replaceChildren(mark, document.createTextNode(original));
    $('title').lang = heading.language;
    $('title').title = [heading.original, heading.translation, heading.activity].filter(Boolean).join('\n');
    $('translation').textContent = heading.translation;
    $('translation').hidden = !heading.translation;
    $('target').textContent = `${shortDateLabel(current.start,Date.now(),current.timezone)}（${current.timezone??Intl.DateTimeFormat().resolvedOptions().timeZone}）`;
    renderClock(current.start);
  } else {
    $('activity').hidden = true;
    $('title').textContent = data.error ? '日程暂时读不到' : '没有待办日程';
    $('title').lang = 'zh-CN'; $('title').removeAttribute('title');
    $('translation').textContent = ''; $('translation').hidden = true;
    $('target').textContent = data.error ? '正在重试…' : '新加的日程会自动出现在这里';
    $('days-part').hidden = true; $('hms').hidden = true;
    $('empty').textContent = data.error ? '读取中' : '暂无日程'; $('empty').hidden = false;
    $('clock').classList.remove('no-days'); $('clock').classList.add('is-empty');
    $('clock').setAttribute('aria-label', $('empty').textContent);
  }
  renderList(upcoming, current);
}

$('topmost').addEventListener('click', () => act('topmost'));
$('collapse').addEventListener('click', () => act('collapse'));
$('hide').addEventListener('click', () => act('hide'));
$('auto').addEventListener('click', () => act('select', null));
$('list-toggle').addEventListener('click', () => { listOpen = !listOpen; render(); });
$('open').addEventListener('click', () => {
  const current = selectedEvent(data.events, data.preferences.selectedId);
  if (current) void act('open', current.id);
});
let drag = null;
document.addEventListener('pointerdown', event => {
  const area = event.target.closest('.drag');
  if (!area || event.button !== 0 || event.target.closest('button')) return;
  drag = { pointer: event.pointerId, x: event.screenX, y: event.screenY, dx: 0, dy: 0 };
  area.setPointerCapture(event.pointerId);
  document.body.classList.add('is-dragging');
  void act('drag-start');
});
document.addEventListener('pointermove', event => {
  if (!drag || event.pointerId !== drag.pointer) return;
  drag.dx = event.screenX - drag.x; drag.dy = event.screenY - drag.y;
  void act('drag', { dx: drag.dx, dy: drag.dy });
});
function finishDrag(event) {
  if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.pointer)) return;
  if (event?.type === 'pointerup') { drag.dx = event.screenX - drag.x; drag.dy = event.screenY - drag.y; }
  void act('drag-end', { dx: drag.dx, dy: drag.dy });
  drag = null; document.body.classList.remove('is-dragging');
}
document.addEventListener('pointerup', finishDrag);
document.addEventListener('pointercancel', finishDrag);
document.addEventListener('lostpointercapture', finishDrag);
window.addEventListener('blur', () => finishDrag());
window.countdown.subscribe(snapshot => { data = snapshot; render(); });
window.countdown.get().then(snapshot => { data = snapshot; render(); }).catch(() => {
  $('title').textContent = '正在连接 Coopanion';
});
new ResizeObserver(() => {
  const height = Math.ceil($('card').getBoundingClientRect().height);
  if (height !== lastHeight) { lastHeight = height; void act('height', height); }
}).observe($('card'));
setInterval(render, 1000);
