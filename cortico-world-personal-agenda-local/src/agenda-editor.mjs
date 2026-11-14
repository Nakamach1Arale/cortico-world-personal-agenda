import {readFileSync,writeFileSync,renameSync,mkdirSync,existsSync,statSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {validateAgenda} from './agenda-service.mjs';
import {eventFormat} from '../window/event-format.mjs';
import {resolveTimezone,eventTimezone,eventTimezoneSetting,systemTimezone,validISO,localToISO} from '../window/agenda-time.mjs';

export class AgendaEditError extends Error {
  constructor(message,code='validation'){super(message);this.code=code;}
}
const revision=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields=['title','subtitle','remark','details','start','timezone','status','reminders_minutes','url','enabled'];
export function createAgendaEditor({dataDir,clock=()=>Date.now()}){
  const file=join(dataDir,'personal-agenda.json');
  function read(){
    if(!existsSync(file))return {doc:{schema_version:1,events:[]},raw:null};
    if(statSync(file).size>1024*1024)throw new AgendaEditError('日程文件过大，未作修改。');
    const raw=readFileSync(file,'utf8');
    try{return {doc:validateAgenda(JSON.parse(raw)),raw};}catch{throw new AgendaEditError('日程文件无法读取，未作修改。');}
  }
  function snapshot(){const {doc}=read();return {revision:revision(doc),events:doc.events.map(e=>({...e,...eventFormat(e),timezoneSetting:eventTimezoneSetting(e,doc),resolvedTimezone:eventTimezone(e,doc),revision:revision(e)})),systemTimezone:systemTimezone()};}
  function commit(doc,before){
    validateAgenda(doc);mkdirSync(dataDir,{recursive:true});
    const temp=file+'.'+randomUUID()+'.tmp';
    try{
      writeFileSync(temp,JSON.stringify(doc,null,2)+'\n',{mode:0o600});
      const current=existsSync(file)?readFileSync(file,'utf8'):null;
      if(current!==before)throw new AgendaEditError('日程刚刚被其他操作修改，请刷新后重试。','conflict');
      renameSync(temp,file);
    }finally{if(existsSync(temp))unlinkSync(temp);}
  }
  function requireCurrent(doc,id,expected){
    const event=doc.events.find(e=>e.id===id);
    if(!event)throw new AgendaEditError('这项日程已不存在，请刷新。','conflict');
    if(typeof expected!=='string'||expected!==revision(event))throw new AgendaEditError('这项日程已有新改动，请重新打开编辑，避免覆盖。','conflict');
    return event;
  }
  function save(input){
    if(!input||typeof input!=='object'||!input.event||typeof input.event!=='object')throw new AgendaEditError('请填写日程信息。');
    const {doc,raw}=read(),data=input.event;
    const current=data.id?requireCurrent(doc,data.id,input.expectedRevision):null;
    const candidate=current?{...current,...eventFormat(current),timezone:eventTimezoneSetting(current,doc)}:{id:'event-'+randomUUID().slice(0,12),timezone:'local'};
    for(const key of fields)if(Object.hasOwn(data,key))candidate[key]=data[key];
    if(Object.hasOwn(data,'notes')&&!Object.hasOwn(data,'details'))candidate.details=data.notes;
    delete candidate.notes;
    if(!current&&!Object.hasOwn(data,'remark'))Object.assign(candidate,eventFormat(candidate));
    if(typeof candidate.title==='string')candidate.title=candidate.title.trim();
    for(const key of ['subtitle','remark','details','url'])if(typeof candidate[key]==='string'){candidate[key]=candidate[key].trim();if(!candidate[key]&&key==='url')delete candidate[key];}
    if(input.localStart!==undefined){
      if(typeof input.timezone!=='string'||resolveTimezone(input.timezone)!==eventTimezone(candidate))throw new AgendaEditError('日程时区与输入不一致，请重新打开编辑。','conflict');
      candidate.start=localToISO(input.localStart,input.timezone,input.occurrence);
    }
    if(!validISO(candidate.start))throw new AgendaEditError('请填写真实有效的日期和时间。');
    if((!current||candidate.start!==current.start||(!current.enabled&&candidate.enabled))&&candidate.enabled&&Date.parse(candidate.start)<=clock())throw new AgendaEditError('启用的日程需要使用未来的时间。');
    if(candidate.url){try{const url=new URL(candidate.url);if(url.protocol!=='https:'||url.username||url.password)throw new Error();}catch{throw new AgendaEditError('详情链接需为不含账号密码的 HTTPS 地址。');}}
    try{validateAgenda({schema_version:1,events:[candidate]});}catch{throw new AgendaEditError('请检查标题、时间和提醒设置。最多 5 个提前量，每个为 0–43200 分钟的整数。');}
    if(!current){
      const duplicate=doc.events.find(e=>e.enabled&&candidate.enabled&&eventFormat(e).title===candidate.title&&eventFormat(e).remark===candidate.remark&&Date.parse(e.start)===Date.parse(candidate.start));
      if(duplicate)return {event:{...duplicate,revision:revision(duplicate)},duplicate:true};
      if(doc.events.length>=200)throw new AgendaEditError('最多保存 200 项日程，请先整理历史记录。');
      doc.events.push(candidate);
    }else doc.events[doc.events.indexOf(current)]=candidate;
    commit(doc,raw);return {event:{...candidate,revision:revision(candidate)},duplicate:false};
  }
  function setEnabled({id,expectedRevision,enabled}={}){
    if(typeof enabled!=='boolean')throw new AgendaEditError('启用状态无效。');
    const {doc,raw}=read(),event=requireCurrent(doc,id,expectedRevision);
    if(enabled&&Date.parse(event.start)<=clock())throw new AgendaEditError('时间已过，请编辑为未来时间后再启用。');
    event.enabled=enabled;commit(doc,raw);return {event:{...event,revision:revision(event)}};
  }
  return {snapshot,save,setEnabled};
}
