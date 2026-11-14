/** Legacy pipe titles/notes remain readable; new events use explicit presentation fields. */
export function eventFormat(event){
  const raw=typeof event.title==='string'?event.title.trim():'';
  const parts=raw.split(/[｜|]/).map(x=>x.trim());
  const explicit=Object.hasOwn(event,'remark');
  return {
    title:explicit?raw:parts[0],
    subtitle:typeof event.subtitle==='string'?event.subtitle.trim():'',
    remark:explicit?(typeof event.remark==='string'?event.remark.trim():''):parts.slice(1).filter(Boolean).join(' · '),
    details:typeof event.details==='string'?event.details:typeof event.notes==='string'?event.notes:'',
  };
}
export function eventName(event){const e=eventFormat(event);return [e.title,e.remark].filter(Boolean).join('｜');}
