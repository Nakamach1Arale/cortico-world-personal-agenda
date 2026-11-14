export const validQQ=value=>Number.isSafeInteger(Number(value))&&Number(value)>=10000&&/^[1-9]\d{4,15}$/.test(String(value));
export const targetKey=target=>`${target.kind}:${target.id}`;
export function reminderTargets(cfg){
  return [...(validQQ(cfg.privateQQ)?[{kind:'private',id:Number(cfg.privateQQ)}]:[]),...(validQQ(cfg.groupId)?[{kind:'group',id:Number(cfg.groupId)}]:[])];
}
export function hasTargets(cfg){return reminderTargets(cfg).length>0;}
export function validTarget(target){return !!target&&['private','group'].includes(target.kind)&&validQQ(target.id);}
export function normalizeTarget(target){return typeof target==='number'?{kind:'private',id:target}:target;}
export function targetAllowed(cfg,target){return validTarget(target)&&reminderTargets(cfg).some(t=>targetKey(t)===targetKey(target));}
export function messageText(ev){
  const text=typeof ev.message==='string'?ev.message:Array.isArray(ev.message)?ev.message.filter(s=>s.type==='text').map(s=>s.data?.text??'').join(''):ev.raw_message??'';
  return typeof text==='string'?text.trim():'';
}
export function groupAddAllowed(cfg,ev){
  if(cfg.allowGroupAdd!==true||!validQQ(cfg.groupId)||Number(ev.group_id)!==Number(cfg.groupId))return false;
  return (cfg.groupAddByOwner===true&&validQQ(cfg.masterQQ)&&Number(ev.user_id)===Number(cfg.masterQQ))||
    (cfg.groupAddByAdmin===true&&ev.sender?.role==='admin')||(cfg.groupAddByGroupOwner===true&&ev.sender?.role==='owner');
}
export function agendaRequest(cfg,ev){
  if(ev.post_type!=='message'||!validQQ(ev.user_id)||Number(ev.user_id)===Number(ev.self_id))return null;
  const text=messageText(ev);if(!text)return null;
  if(ev.message_type==='private'&&validQQ(cfg.privateQQ)&&Number(ev.user_id)===Number(cfg.privateQQ))return {target:{kind:'private',id:Number(cfg.privateQQ)},text,command:/^\/日程(?:\s|$)/.test(text)?text:null};
  if(ev.message_type==='group'&&groupAddAllowed(cfg,ev)&&/^\/日程\s+添加(?:\s|$)/.test(text))return {target:{kind:'group',id:Number(cfg.groupId)},text,command:text,addOnly:true};
  return null;
}
