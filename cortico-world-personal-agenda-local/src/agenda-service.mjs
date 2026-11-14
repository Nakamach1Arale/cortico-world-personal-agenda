import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {eventFormat,eventName} from '../window/event-format.mjs';
import {resolveTimezone,systemTimezone,eventTimezone,eventTimezoneSetting,stamp as zonedStamp,weekday as zonedWeekday,localInput,validISO,localToISO} from '../window/agenda-time.mjs';
import {validTarget,targetKey} from './qq-targets.mjs';


function save(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path + '.tmp', JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(path + '.tmp', path);
}

export function validateAgenda(value) {
  if (value?.schema_version !== 1 || !Array.isArray(value.events) || value.events.length > 200)
    throw new Error('日程文件格式不正确');
  if(value.timezone!==undefined)resolveTimezone(value.timezone);
  const ids = new Set();
  for (const e of value.events) {
    if (!e || !/^[a-zA-Z0-9_-]{1,80}$/.test(e.id) || ids.has(e.id) ||
        typeof e.title !== 'string' || !e.title.trim() || e.title.length > 180 || /[\r\n]/.test(e.title) ||
        typeof e.start !== 'string' || !validISO(e.start) ||
        !['confirmed', 'tentative'].includes(e.status) || typeof e.enabled !== 'boolean' ||
        !Array.isArray(e.reminders_minutes) || e.reminders_minutes.length > 5 ||
        e.reminders_minutes.some(m => !Number.isInteger(m) || m < 0 || m > 43200) ||
        new Set(e.reminders_minutes).size !== e.reminders_minutes.length ||
        (e.notes !== undefined && (typeof e.notes !== 'string' || e.notes.length > 2000)) ||
        (e.details !== undefined && (typeof e.details !== 'string' || e.details.length > 2000)) ||
        ['subtitle','remark'].some(key=>e[key]!==undefined&&(typeof e[key]!=='string'||e[key].length>180||/[\r\n]/.test(e[key]))) ||
        (e.url !== undefined && (typeof e.url !== 'string' || !/^https:\/\/\S{1,1500}$/.test(e.url))))
      throw new Error('日程字段不正确');
    if(e.timezone!==undefined)resolveTimezone(e.timezone);
    ids.add(e.id);
  }
  if (value.announcement_id !== undefined && !/^[a-zA-Z0-9_-]{1,80}$/.test(value.announcement_id))
    throw new Error('日程通知标识不正确');
  return value;
}

export function agendaOwnerText(ev, ownerQQ) {
  if (!Number.isSafeInteger(ownerQQ) || ownerQQ < 10000 || ev.post_type !== 'message' ||
      ev.message_type !== 'private' || Number(ev.user_id) !== ownerQQ || Number(ev.self_id) === ownerQQ) return null;
  const text = typeof ev.message === 'string' ? ev.message : Array.isArray(ev.message)
    ? ev.message.filter(s => s.type === 'text').map(s => s.data?.text ?? '').join('') : ev.raw_message ?? '';
  return text.trim() || null;
}

export function agendaCommandText(ev, ownerQQ) {
  const text = agendaOwnerText(ev, ownerQQ);
  return text && /^\/日程(?:\s|$)/.test(text) ? text : null;
}

export function startAgendaService({ dataDir, ownerQQ=()=>0, targets,legacyOwnerQQ=0, connected, paused = () => false, remindersEnabled = () => true, send, log,
  interpret, generate, getConversation = () => [],deliveryVersion=()=>0, clock = () => Date.now(), intervalMs = 5000, autoStart = true }) {
  const path = join(dataDir, 'personal-agenda.json');
  const statePath = join(dataDir, 'personal-agenda-delivery.json');
  const dialoguePath = join(dataDir, 'personal-agenda-dialogue.json');
  let document;
  const timezone=event=>event?eventTimezone(event,document):systemTimezone();
  const stamp=(value,event)=>zonedStamp(value,timezone(event));
  const weekday=(value,event)=>zonedWeekday(value,timezone(event));
  const datedStamp=(value,event)=>`${stamp(value,event)}（${weekday(value,event)}）`;
  let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { schema_version: 1, deliveries: {} };
  if (state?.schema_version !== 1 || !state.deliveries || typeof state.deliveries !== 'object' || Array.isArray(state.deliveries))
    throw new Error('日程投递记录格式不正确');
  let active = null, stopped = false, timer, lastError = null;
  const read = () => {
    const next = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { schema_version: 1, events: [] };
    document = validateAgenda(next);
    lastError = null;
    return document;
  };
  read();
  const validOwner = () => Number.isSafeInteger(ownerQQ()) && ownerQQ() >= 10000;
  const list = () => read().events.filter(e => e.enabled).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const overview = () => {
    const events = list().filter(e => Date.parse(e.start) > clock() - 15 * 60000);
    return '近期日程（各项按自身时区显示）\n' + (events.length ? events.map(e =>
      `${datedStamp(e.start,e)}（${timezone(e)}）　${eventName(e)}${e.status === 'tentative' ? '【预计】' : ''}\n编号：${e.id}`
    ).join('\n\n') : '暂无待办日程。') + (interpret
      ? '\n\n可以直接说“明晚八点提醒我给手柄充电”“改到九点”“取消刚才那条”。/日程 命令仍可用。'
      : '\n\n私聊发送 /日程 查看清单；/日程 帮助 查看添加、修改、取消方法。');
  };
  const writeDelivery = (key, entry) => {
    const next = { ...state, deliveries: { ...state.deliveries, [key]: entry } };
    save(statePath, next);
    state = next;
  };
  const commit = next => { validateAgenda(next); save(path, next); document = next; };
  const express = async (kind, facts) => {
    if (!generate) return facts;
    try {
      const lead = await generate({ kind, facts });
      if (typeof lead === 'string' && lead.trim() && lead.trim().length <= 160
          && !(kind === 'reminder' && /确认|核对|核实|检查/.test(lead)))
        return lead.trim() + '\n\n' + facts;
    } catch { log.warn('日程自然语言表达暂不可用，使用准确事实'); }
    return facts;
  };
  const describe = e => `${eventName(e)}${e.status === 'tentative' ? '【预计】' : ''}\n`
    + `${datedStamp(e.start,e)}（${timezone(e)}）\n编号：${e.id}\n`
    + `提醒：${e.reminders_minutes.map(m => m ? `提前${m}分钟` : '到点').join('、') || '无'}\n`
    + (eventFormat(e).details ? eventFormat(e).details + '\n' : '') + (e.url ?? '');
  const recentHistory = () => {
    try {
      const saved = JSON.parse(readFileSync(dialoguePath, 'utf8'));
      if (saved.owner === ownerQQ() && saved.at > clock() - 30 * 60000 && Array.isArray(saved.turns)) return saved.turns.slice(-6);
    } catch { /* first conversation or expired/corrupt context starts fresh */ }
    return [];
  };
  const eventContext = event => ({ ...event, ...eventFormat(event), timezone:timezone(event),timezone_setting:eventTimezoneSetting(event,document),local_start: stamp(event.start,event),weekday: weekday(event.start,event) });
  const focusEvents = (history, events) => {
    for (const turn of [...history].reverse()) {
      const ids = turn.result?.ids ?? (turn.result?.event ? [turn.result.event.id] : null);
      if (ids) return events.filter(e => ids.includes(e.id)).map(eventContext);
    }
    return [];
  };
  const chatContext = () => {
    try {
      const history = recentHistory();
      if (!history.length) return null;
      const doc=read();return JSON.stringify({ timezone: timezone(), history: history.slice(-3),
        focus_events: focusEvents(history, doc.events) }).slice(0, 12000);
    } catch { return null; }
  };
  const natural = async text => {
    if (!interpret || stopped || paused() || !validOwner()) return null;
    const requestOwner=ownerQQ(),requestVersion=deliveryVersion();
    const history = recentHistory();
    const remember = (result, reply = '') => {if(requestOwner!==ownerQQ()||requestVersion!==deliveryVersion())return;save(dialoguePath, { owner: requestOwner, at: clock(),
      turns: [...history, { user: text, result, reply }].slice(-6) });};
    const answer = async (result, facts, kind = 'query') => {
      const reply = await express(kind, facts);
      remember(result, reply);
      return reply;
    };
    const before = structuredClone(read());
    const inputZone=timezone();
    const focus = focusEvents(history, before.events);
    let intent;
    try {
      const previous = history.at(-1);
      intent = await interpret({ now: new Date(clock()).toISOString(), local_now: zonedStamp(clock(),inputZone),
        timezone: inputZone,default_timezone:inputZone, text, history,
        pending_request: previous?.result?.action === 'clarify' ? { user_text: previous.user, question: previous.result.question } : null,
        conversation: getConversation(), focus_events: focus,
        events: before.events.filter(e => e.enabled).map(eventContext) });
    } catch {
      log.warn('日程自然语言理解暂不可用');
      return /日程|提醒|闹钟|改到|改成|推迟|取消|安排/.test(text) || history.length
        ? '日程理解暂时不可用，这条消息没有保存或修改日程。稍后再说一次，或使用 /日程 命令。' : null;
    }
    if(requestOwner!==ownerQQ()||requestVersion!==deliveryVersion())return null;
    // A short date follow-up refers to the last agenda result, not the wall clock.
    const dateFollowup = /(?:周几|星期几|礼拜几|哪一天|哪天|几月几号)/.test(text)
      && /^(?:那|这|它|刚才|所以|也就是)/.test(text.trim()) && !/今天|今日|现在|此刻/.test(text);
    if (dateFollowup && focus.length && (!intent || intent.action === 'ignore'))
      intent = { action: 'date_info', ...(focus.length === 1 ? { id: focus[0].id } : {}) };
    if (!intent || typeof intent !== 'object' || intent.action === 'ignore') return null;
    if (stopped || paused()) return null;
    const ask = question => {
      const safe = typeof question === 'string' && question.length <= 300 && !/已(?:保存|取消|修改|添加)/.test(question)
        ? question : '要安排哪件事、哪一天的几点？请补充一下。';
      remember({ action: 'clarify', question: safe }, safe);
      return safe;
    };
    if (intent.action === 'clarify') return ask(intent.question);
    const next = structuredClone(read());
    if(next.timezone!==before.timezone||timezone()!==inputZone)return ask('日程时区刚刚发生变化，请按新的时区再说一次。');
    if (intent.action === 'date_info') {
      const matches = intent.id ? next.events.filter(e => e.id === intent.id && e.enabled) : focus.filter(e => e.enabled);
      if (matches.length !== 1) return ask('你指的是哪一项日程？请告诉我标题，或是哪一天的活动。');
      const event = matches[0];
      return answer({ action: 'date_info', ids: [event.id], events: [eventContext(event)] },
        `${eventName(event)}${event.status === 'tentative' ? '【预计】' : ''}\n`
        + `${datedStamp(event.start,event)}（${timezone(event)}）\n` + eventFormat(event).details);
    }
    if (intent.action === 'list') {
      if ((intent.from && !validISO(intent.from)) || (intent.to && !validISO(intent.to)))
        return ask('你想查哪一天或哪段时间的日程？');
      const from = intent.from ? Date.parse(intent.from) : clock() - 15 * 60000;
      const to = intent.to ? Date.parse(intent.to) : Infinity;
      const events = next.events.filter(e => e.enabled && (!intent.id || e.id === intent.id)
        && Date.parse(e.start) >= from && Date.parse(e.start) < to).sort((a,b) => Date.parse(a.start) - Date.parse(b.start));
      const facts = events.length ? '查到的日程：\n\n' + events.map(describe).join('\n\n') : '这段时间没有符合条件的日程。';
      return answer({ action: 'list', ids: events.map(e => e.id), events: events.map(eventContext) }, facts);
    }
    if (!['add', 'update', 'cancel'].includes(intent.action)) return ask();
    let target;
    if (intent.action !== 'add') {
      target = next.events.find(e => e.enabled && e.id === intent.id);
      const original = before.events.find(e => e.enabled && e.id === intent.id);
      if (!target || !original) return ask('具体要修改或取消哪一项？可以告诉我日程标题。');
      if (JSON.stringify(target) !== JSON.stringify(original)) return ask('这项日程刚发生了变动，请再说一次要怎么改。');
    }
    if (intent.action === 'cancel') {
      target.enabled = false;
    } else {
      const setting=intent.timezone??(target?eventTimezoneSetting(target,next):'local');
      let inputTimezone;try{inputTimezone=resolveTimezone(setting);}catch{return ask('请提供有效的日程时区，例如 Asia/Tokyo 或 America/New_York。');}
      if (intent.start !== undefined) {
        const sources = [text, ...history.map(turn => turn.user).filter(x => typeof x === 'string')];
        const quoted = intent.time_text;
        const evidence = typeof quoted === 'string' && quoted.length <= 80 && sources.some(s => s.includes(quoted));
        const relative = /(?:\d+|[零〇一二两三四五六七八九十百半]+)\s*个?\s*(?:分钟|小时|秒钟?|刻钟)\s*(?:之?后|以后)|(?:再?过)\s*(?:\d+|[一二两三四五六七八九十半]+)\s*个?\s*(?:分钟|小时|秒钟?|刻钟)/.test(quoted ?? '');
        const clockTime = /\d{1,2}[:：]\d{2}|(?:\d{1,2}|[零〇一二两三四五六七八九十]+)[点时]/.test(quoted ?? '');
        const unambiguous = relative || /\d{1,2}[:：]\d{2}/.test(quoted ?? '')
          || /(?:1[3-9]|2[0-3]|十[三四五六七八九]|二十[一二三]?)[点时]/.test(quoted ?? '')
          || (intent.action === 'update' ? sources : [text, ...history.filter(turn => turn.result?.action === 'clarify').map(turn => turn.user)])
            .some(s => /上午|下午|晚上|早上|早晨|中午|傍晚|夜里|凌晨|今晚|明晚|今早|明早/.test(s));
        if (!evidence || !(relative || clockTime) || !unambiguous)
          return ask('你想在几点收到提醒？请说清上午还是下午／晚上，或使用24小时制。');
        const valid = typeof intent.start === 'string' && validISO(intent.start)
          && Date.parse(intent.start) > clock()
          && zonedStamp(intent.start,inputTimezone) === intent.start.slice(0, 16).replace('T', ' ');
        if (!valid) return ask(`请给一个有效的未来日期和时间，这条日程的时区为 ${inputTimezone}。`);
        if(!relative){
          const source=sources.join('\n'),occurrence=/第二次|后一次/.test(source)?'later':/第一次|前一次/.test(source)?'earlier':undefined;
          try{const resolved=localToISO(localInput(intent.start,inputTimezone,true),inputTimezone,occurrence);if(Date.parse(resolved)!==Date.parse(intent.start))return ask('请确认是夏令时重复时段的第一次还是第二次。');}
          catch(error){return ask(error.message);}
        }
      } else if (intent.action === 'add') return ask('你想在哪一天的几点收到提醒？');
      if (intent.action === 'add') {
        target = { id: 'event-' + randomUUID().slice(0, 8), title: intent.title, start: intent.start,
          timezone:setting,status: 'confirmed', enabled: true, reminders_minutes: intent.reminders_minutes ?? [1440, 30, 0] };
        for(const key of ['subtitle','remark','details'])if(intent[key]!==undefined)target[key]=intent[key];
        const duplicate = next.events.find(e => e.enabled && e.title === target.title && e.start === target.start);
        if (duplicate) return answer({ action: 'list', ids: [duplicate.id], events: [eventContext(duplicate)] },
          '这项日程已经存在，没有重复添加：\n' + describe(duplicate), 'reply');
        next.events.push(target);
      } else {
        if (!['start', 'title', 'timezone','reminders_minutes','subtitle','remark','details'].some(key => intent[key] !== undefined)) return ask('这项日程要改成什么时间或提醒方式？');
        for (const key of ['start', 'title', 'timezone','reminders_minutes','subtitle','remark','details']) if (intent[key] !== undefined) target[key] = intent[key];
      }
    }
    try { validateAgenda(next); }
    catch { return ask('日程信息还不完整，请补充事项和具体时间；提醒提前量需在0到43200分钟之间。'); }
    // Commit only after model output and all fields have been validated; never send an invented success.
    commit(next);
    const facts = (intent.action === 'cancel' ? '已取消，后续提醒已停止：\n' : '日程已保存：\n') + describe(target);
    return answer({ action: intent.action, event: eventContext(target) }, facts, 'reply');
  };
  const command = (text,{addOnly=false}={}) => {
    if(addOnly&&!/^\/日程\s+添加(?:\s|$)/.test(text))return null;
    read();const help = addOnly?`群内添加日程（默认时区 ${timezone()}）\n/日程 添加 2030-11-10 20:00 事项标题\n可在时间后加 @Asia/Tokyo 等时区。`:`日程命令（新增默认跟随电脑 ${timezone()}，修改沿用该项时区）\n/日程\n/日程 添加 2030-11-10 20:00 事项标题\n`
      + '/日程 修改 编号 2030-11-10 21:00 新标题\n/日程 取消 编号\n'
      + '可在时间后加 @Asia/Tokyo 等时区。新增日程默认提前1天、30分钟和到点提醒。修改会保留原日程的预计／确认状态及备注。';
    if (text === '/日程') return overview();
    if (text === '/日程 帮助') return help;
    const cancel = text.match(/^\/日程\s+取消\s+([a-zA-Z0-9_-]+)$/);
    if (cancel) {
      const e = document.events.find(e => e.id === cancel[1]);
      if (!e?.enabled) return '没有找到启用中的日程：' + cancel[1];
      const next = structuredClone(document);
      next.events.find(e => e.id === cancel[1]).enabled = false;
      commit(next);
      return `已取消：${e.title}。后续提醒已停止。`;
    }
    const match = text.match(/^\/日程\s+(添加|修改)\s+(?:([a-zA-Z0-9_-]+)\s+)?(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?:\s+@([-A-Za-z0-9_+/]+))?\s+([^\r\n]{1,180})$/);
    if (!match) return help;
    const [, action, id, date, time, explicitZone, title] = match;
    if ((action === '添加' && id) || (action === '修改' && !id)) return help;
    const original=action==='修改'?document.events.find(e=>e.id===id&&e.enabled):null;
    if(action==='修改'&&!original)return '没有找到启用中的日程：'+id;
    const setting=explicitZone??(original?eventTimezoneSetting(original,document):'local');
    let start;try{start=localToISO(`${date}T${time}:00`,setting);}catch(error){return error.message+(error.code==='ambiguous-time'?' 可在插件页面选择对应时段。':'');}
    const ms = Date.parse(start);
    if (!Number.isFinite(ms) || zonedStamp(ms,setting) !== `${date} ${time}` || ms <= clock()) return '请填写有效的未来日期和时间。';
    const next = structuredClone(document);
    if (action === '修改') {
      const e = next.events.find(e => e.id === id && e.enabled);
      if (!e) return '没有找到启用中的日程：' + id;
      e.start = start; e.timezone=setting;e.title = title.trim();
    } else {
      next.events.push({ id: 'event-' + randomUUID().slice(0, 8), start,timezone:setting,title: title.trim(), enabled: true,
        status: 'confirmed', reminders_minutes: [1440, 30, 0] });
    }
    commit(next);
    return '日程已保存：\n' + (addOnly?describe(next.events.at(-1)):overview());
  };
  const jobs = () => {
    const doc = read(), now = clock(), out = [], queuedZone=timezone();
    if (doc.announcement_id&&!targets) out.push({ key: 'announcement:' + doc.announcement_id,
      at: now, valid: () => read().announcement_id === doc.announcement_id && document.timezone===doc.timezone && timezone()===queuedZone,
      text: () => '日程提醒已接入，我会通过这里提醒你。\n\n' + overview() });
    for (const e of doc.events.filter(e => e.enabled)) {
      const eventZone=timezone(e);
      const start = Date.parse(e.start);
      const due = e.reminders_minutes.map(minutes => ({ minutes, at: start - minutes * 60000 }))
        .filter(j => j.at <= now && now <= Math.min(j.at + 2 * 3600000, start + 15 * 60000));
      // Reconnection near an event sends the latest useful reminder, not a burst of old ones.
      const j = due.sort((a, b) => b.at - a.at)[0];
      if (!j) continue;
      const key = `event:${e.id}:${start}:${j.minutes}`;
      for (const old of due.slice(1)) {
        const oldKey = `event:${e.id}:${start}:${old.minutes}`;
        if (!state.deliveries[oldKey]?.message_id && state.deliveries[oldKey]?.status !== 'superseded')
          writeDelivery(oldKey, { status: 'superseded' });
      }
      out.push({ key, at: j.at, valid: () => clock() <= Math.min(j.at + 2 * 3600000, start + 15 * 60000)
        && read().timezone===doc.timezone && timezone(e)===eventZone && document.events.some(current => current.enabled &&
        current.id === e.id && JSON.stringify(current) === JSON.stringify(e) && current.reminders_minutes.includes(j.minutes)),
        text: () => `日程提醒${e.status === 'tentative' ? '【预计】' : ''}\n${eventName(e)}\n`
          + `${datedStamp(e.start,e)}（${timezone(e)}）\n`
          + (j.minutes ? `提前${j.minutes >= 60 ? `${j.minutes / 60}小时` : `${j.minutes}分钟`}提醒。\n` : '已到安排的时间。\n')
          + (eventFormat(e).details ? eventFormat(e).details + '\n' : '') + (e.url ?? '') });
    }
    return out.sort((a, b) => a.at - b.at);
  };
  const run = async () => {
    const recipients=()=>targets?targets().filter(validTarget):(validOwner()?[ownerQQ()]:[]);
    if (stopped || !remindersEnabled() || !connected() || paused() || !recipients().length) return;
    for (const job of jobs()) {
      let prepared;const version=deliveryVersion();
      for(const recipient of recipients()){
        const key=targets?`${job.key}|${targetKey(recipient)}`:job.key;
        const previous = state.deliveries[key]??(targets&&recipient.kind==='private'&&recipient.id===legacyOwnerQQ?state.deliveries[job.key]:null);
        if (previous?.message_id || previous?.status === 'superseded' || (previous?.next_attempt ?? 0) > clock()) continue;
        if (stopped || !remindersEnabled() || !connected() || paused() || !job.valid()) continue;
        try {
          const recipientKey=targets?targetKey(recipient):recipient;
          const text = prepared??=await express('reminder', job.text());
          if (stopped || !remindersEnabled() || !connected() || paused() || !job.valid()||!recipients().some(r=>(targets?targetKey(r):r)===recipientKey)||version!==deliveryVersion()) continue;
          const receipt = await send(recipient, text);
          if (!receipt?.message_id) throw new Error('NapCat did not acknowledge delivery');
          writeDelivery(key, { status: 'sent', message_id: String(receipt.message_id), sent_at: new Date(clock()).toISOString(),...(targets?{target:recipient}:{}) });
          log.info('个人日程提醒已发送', { job: job.key, message_id: String(receipt.message_id) });
        } catch {
          if(stopped||!remindersEnabled()||paused()||version!==deliveryVersion()||!recipients().some(r=>(targets?targetKey(r):r)===(targets?targetKey(recipient):recipient)))continue;
          const attempts = (previous?.attempts ?? 0) + 1;
          writeDelivery(key, { status: 'retry', attempts, next_attempt: clock() + Math.min(3600000, 30000 * 2 ** Math.min(attempts - 1, 7)),...(targets?{target:recipient}:{}) });
          log.warn('个人日程提醒投递失败，将自动重试');
        }
      }
    }
  };
  const poll = () => active ??= run().catch(error => {
    lastError = error.message;
    log.error('个人日程暂不可用，请检查日程或投递记录文件');
  }).finally(() => { active = null; });
  if (autoStart) { timer = setInterval(() => void poll(), intervalMs); timer.unref(); }
  return { list, overview, command, natural, chatContext, poll,
    status: () => {
      let count = 0;
      try { count = list().length; } catch (error) { lastError = error.message; }
      return { enabled: !stopped, events: count, connected: connected(), paused: paused(),reminders_enabled:remindersEnabled(),
        owner_configured: validOwner(),targets_configured:targets?targets().some(validTarget):validOwner(),natural_language: !!interpret, personality: !!generate, last_error: lastError,
        delivered: Object.values(state.deliveries).filter(x => x.message_id).length };
    },
    stop: async () => { stopped = true; clearInterval(timer); await active; } };
}
