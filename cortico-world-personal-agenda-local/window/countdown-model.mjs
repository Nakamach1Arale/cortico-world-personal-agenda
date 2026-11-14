import {eventFormat} from './event-format.mjs';
import {resolveTimezone,eventTimezone} from './agenda-time.mjs';
export const defaults = Object.freeze({ visible: true, topmost: true, collapsed: false, selectedId: null });

export function cleanPreferences(value) {
  const result = { ...defaults };
  for (const key of ['visible', 'topmost', 'collapsed'])
    if (typeof value?.[key] === 'boolean') result[key] = value[key];
  if (typeof value?.selectedId === 'string' && /^[\w-]{1,80}$/.test(value.selectedId)) result.selectedId = value.selectedId;
  for (const key of ['x', 'y'])
    if (Number.isInteger(value?.[key]) && Math.abs(value[key]) < 100000) result[key] = value[key];
  return result;
}

function https(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

export function agendaEvents(document) {
  if (document?.schema_version !== 1 || !Array.isArray(document.events) || document.events.length > 200)
    throw new Error('暂时无法读取日程');
  return document.events.filter(event => event?.enabled === true &&
    typeof event.id === 'string' && /^[\w-]{1,80}$/.test(event.id) &&
    typeof event.title === 'string' && event.title.trim() && event.title.length <= 180 &&
    typeof event.start === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(event.start) &&
    Number.isFinite(Date.parse(event.start)) && ['confirmed', 'tentative'].includes(event.status))
    .map(event => {
      const display=eventFormat(event);
      const notes = display.details.slice(0, 2000);
      const urls = notes.match(/https:\/\/[^\s<>]+/g) ?? [];
      const stream = urls.map(https).find(url => url && ['youtube.com', 'www.youtube.com', 'youtu.be', 'live.bilibili.com', 'bilibili.com', 'www.bilibili.com', 'b23.tv', 'twitch.tv', 'www.twitch.tv'].includes(new URL(url).hostname));
      return { id: event.id, ...display, start: event.start,timezone:eventTimezone(event,document),status: event.status,
        notes, url: https(event.url), stream: stream ?? null };
    }).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

export function upcomingEvents(events, now = Date.now()) {
  return events.filter(event => Date.parse(event.start) > now);
}

export function selectedEvent(events, selectedId, now = Date.now()) {
  const upcoming = upcomingEvents(events, now);
  return upcoming.find(event => event.id === selectedId) ?? upcoming[0] ?? null;
}

export function eventHeading(event) {
  const display=eventFormat(event);
  const language=/[ぁ-ゟ゠-ヿ]/.test(display.title)?'ja':/[a-zA-Z]/.test(display.title)&&!/[一-鿿]/.test(display.title)?'en':'zh-CN';
  return {original:display.title,translation:display.subtitle,activity:display.remark,language};
}
export const gameHeading = eventHeading;

export function remaining(start, now = Date.now()) {
  // Recompute from wall time every render: suspended PCs do not accumulate drift.
  const total = Math.max(0, Math.ceil((Date.parse(start) - now) / 1000));
  return { days: Math.floor(total / 86400), hours: Math.floor(total / 3600) % 24,
    minutes: Math.floor(total / 60) % 60, seconds: total % 60, total };
}

export function dateLabel(start,timezone) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: resolveTimezone(timezone), year: 'numeric', month: 'long', day: 'numeric',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(start));
}

export function fitBounds(state, areas, width = 360, height = 280) {
  const fallback = areas[0] ?? { x: 0, y: 0, width: 1920, height: 1080 };
  const x = state.x ?? fallback.x + fallback.width - width - 28;
  const y = state.y ?? fallback.y + 80;
  const area = areas.find(area => x + width / 2 >= area.x && x + width / 2 < area.x + area.width &&
    y + 30 >= area.y && y + 30 < area.y + area.height) ?? fallback;
  return { x: Math.round(Math.max(area.x, Math.min(x, area.x + Math.max(0, area.width - width)))),
    y: Math.round(Math.max(area.y, Math.min(y, area.y + Math.max(0, area.height - height)))), width, height };
}

const localYear = (date,timezone) => new Intl.DateTimeFormat('zh-CN', { timeZone: resolveTimezone(timezone), year: 'numeric' }).format(date);

// Compare years in the same selected time zone, including around New Year.
export function shortDateLabel(start, now = Date.now(), timezone) {
  const date = new Date(start);
  const sameYear = localYear(date,timezone) === localYear(new Date(now),timezone);
  return new Intl.DateTimeFormat('zh-CN', { timeZone: resolveTimezone(timezone), ...(sameYear ? {} : { year: 'numeric' }),
    month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

export function relativeLabel(start, now = Date.now()) {
  const { days, hours, minutes, total } = remaining(start, now);
  if (total <= 0) return '已到时间';
  if (days > 0) return `${days} 天后`;
  if (hours > 0) return `${hours} 小时后`;
  return `${Math.max(1, minutes)} 分钟后`;
}

// later: more than a day away; today: within 24 hours; soon: within the last hour.
export function urgency(start, now = Date.now()) {
  const total = remaining(start, now).total;
  return total <= 3600 ? 'soon' : total <= 86400 ? 'today' : 'later';
}
