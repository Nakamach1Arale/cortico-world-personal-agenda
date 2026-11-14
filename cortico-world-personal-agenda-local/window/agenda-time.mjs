// Shared by the editor, scheduler and desktop window. Stored starts always identify an instant.
export function systemTimezone(){return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}
export function resolveTimezone(value='local'){
  if(value===undefined||value==='local')return systemTimezone();
  if(typeof value!=='string'||value.length>100||!/^[-A-Za-z0-9_+/]+$/.test(value))throw new Error('请选择有效的时区。');
  try{return new Intl.DateTimeFormat('en',{timeZone:value}).resolvedOptions().timeZone;}
  catch{throw new Error('请选择有效的时区。');}
}
export const eventTimezoneSetting=(event,document={})=>event?.timezone??document.timezone??'local';
export const eventTimezone=(event,document={})=>resolveTimezone(eventTimezoneSetting(event,document));
const formatters=new Map();
function parts(value,zone){
  zone=resolveTimezone(zone);
  if(!formatters.has(zone))formatters.set(zone,new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}));
  return Object.fromEntries(formatters.get(zone).formatToParts(new Date(value)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
}
export function localInput(value,zone,seconds=false){
  const p=parts(value,zone);return `${p.year.padStart(4,'0')}-${p.month}-${p.day}T${p.hour}:${p.minute}${seconds?':'+p.second:''}`;
}
export const stamp=(value,zone)=>localInput(value,zone).replace('T',' ');
export const weekday=(value,zone)=>new Intl.DateTimeFormat('zh-CN',{timeZone:resolveTimezone(zone),weekday:'long'}).format(new Date(value));
function wallEpoch(raw){
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::([0-5]\d))?$/.exec(raw??'');if(!m)return NaN;
  const [y,mo,d,h,mi,s]=m.slice(1).map(v=>Number(v??0));if(mo<1||mo>12||d<1||h>23||mi>59)return NaN;
  const date=new Date(0);date.setUTCFullYear(y,mo-1,d);date.setUTCHours(h,mi,s,0);
  return date.getUTCFullYear()===y&&date.getUTCMonth()===mo-1&&date.getUTCDate()===d?date.getTime():NaN;
}
export function validISO(raw){
  const m=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::[0-5]\d)?)(Z|[+-](\d{2}):(\d{2}))$/.exec(raw??'');
  return !!m&&Number.isFinite(wallEpoch(m[1]))&&Number(m[3]??0)<=23&&Number(m[4]??0)<=59&&Number.isFinite(Date.parse(raw));
}
const timeError=(message,code)=>Object.assign(new Error(message),{code});
function offsetAt(value,zone){return wallEpoch(localInput(value,zone,true))-Math.floor(value/1000)*1000;}
export function zonedISO(value,zone){
  const minutes=offsetAt(Number(new Date(value)),zone)/60000;
  if(!Number.isInteger(minutes))throw timeError('这个历史时刻的时区偏移不受支持，请填写明确的 ISO 时间。','invalid-time');
  const abs=Math.abs(minutes),pad=v=>String(v).padStart(2,'0');
  return localInput(value,zone,true)+(minutes===0?'Z':`${minutes<0?'-':'+'}${pad(Math.floor(abs/60))}:${pad(abs%60)}`);
}
export function localToISO(raw,zone,occurrence){
  zone=resolveTimezone(zone);const epoch=wallEpoch(raw);if(!Number.isFinite(epoch))throw timeError('请填写真实有效的日期和时间。','invalid-time');
  if(occurrence!==undefined&&!['earlier','later'].includes(occurrence))throw timeError('请选择有效的重复时段。','invalid-time');
  const offsets=new Set();for(let hour=-48;hour<=48;hour+=6)offsets.add(offsetAt(epoch+hour*3600000,zone));
  const normalized=raw.length===16?raw+':00':raw;
  const candidates=[...offsets].map(offset=>epoch-offset).filter(t=>localInput(t,zone,true)===normalized).sort((a,b)=>a-b);
  if(!candidates.length)throw timeError('这个当地时刻因时区或夏令时调整而不存在，请选择其他时间。','invalid-time');
  if(candidates.length>1&&!occurrence)throw timeError('这个当地时刻因夏令时结束出现两次，请选择第一次或第二次。','ambiguous-time');
  return zonedISO(occurrence==='later'?candidates.at(-1):candidates[0],zone);
}
