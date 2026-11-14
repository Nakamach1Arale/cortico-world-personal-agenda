import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import WebSocket from '../vendor/ws/wrapper.mjs';
import {validQQ} from './qq-targets.mjs';

export const LEGACY_SECRET='PERSONAL_AGENDA_ONEBOT_TOKEN';
export const DEFAULT_UPSTREAM='ws://127.0.0.1:3001';
export const relayUrl=port=>`ws://127.0.0.1:${port}`;
export const connectionError=(code,message)=>Object.assign(new Error(message),{code});
export const validOwner=validQQ;
export function validateUrl(value){
  let u;try{u=new URL(value);}catch{throw connectionError('invalid_url','连接地址需为 ws:// 或 wss:// 地址。');}
  if(typeof value!=='string'||value.length>2048||!['ws:','wss:'].includes(u.protocol)||u.username||u.password||u.hash||u.search)
    throw connectionError('invalid_url','请填写不含账号、密码或查询参数的 ws:// 或 wss:// 地址，令牌使用单独字段。');
  return u.href;
}
export function validatePort(value,label='日程转接端口'){const port=Number(value);if(!Number.isInteger(port)||port<1024||port>65535)throw connectionError('invalid_port',label+'需为 1024–65535 的整数。');return port;}
export function validateToken(value){if(typeof value!=='string'||value.length>4096||/\s/.test(value))throw connectionError('invalid_token','访问令牌不可包含空白，最长 4096 字符。');return value;}
export function readOfficialQQ(ctx){try{return JSON.parse(readFileSync(join(ctx.botDir??dirname(ctx.dataDir),'config.json'),'utf8')).worlds?.qq??null;}catch{return null;}}
export function secretFor(ctx,cfg=ctx.cfg){return cfg.useToken===false?'':ctx.secret?.(cfg.tokenSecretKey??LEGACY_SECRET)??'';}
export const sameUrl=(a,b)=>{try{return new URL(a).href===new URL(b).href;}catch{return false;}};
export function resolveConnection(cfg,{official,storedToken='',previous,legacyToken=''}={}){
  const mode=cfg.connectionMode??'official',port=validatePort(cfg.relayPort??3002);
  if(!['official','manual'].includes(mode))throw connectionError('invalid_mode','请选择复用官方 QQ 或手动连接。');
  let upstream=cfg.upstreamUrl??DEFAULT_UPSTREAM,token=storedToken;
  if(mode==='official'){
    if(!official?.wsUrl)throw connectionError('official_missing','未找到官方 QQ 连接。请先配置官方 QQ，或选择手动连接。');
    const isPrevious=previous&&sameUrl(official.wsUrl,relayUrl(previous.relayPort));
    const isManaged=sameUrl(official.wsUrl,relayUrl(port))&&(cfg.managedQQRoute===true||(validOwner(cfg.ownerQQ)&&!!legacyToken));
    upstream=isPrevious?(previous.upstreamUrl??upstream):isManaged?upstream:official.wsUrl;
    token=official.token??'';
  }
  upstream=validateUrl(upstream);validateToken(token);
  const u=new URL(upstream);
  if(['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&Number(u.port||(u.protocol==='wss:'?443:80))===port)
    throw connectionError('relay_loop','日程转接端口与 OneBot 端口相同，请在高级选项中换一个转接端口。');
  return {mode,privateQQ:Number(cfg.privateQQ)||0,groupId:Number(cfg.groupId)||0,masterQQ:Number(cfg.masterQQ)||0,allowGroupAdd:cfg.allowGroupAdd===true,groupAddByOwner:cfg.groupAddByOwner===true,groupAddByAdmin:cfg.groupAddByAdmin===true,groupAddByGroupOwner:cfg.groupAddByGroupOwner===true,upstreamUrl:upstream,relayPort:port,corePort:validatePort(cfg.corePort??17788,'Coopanion 本机接口端口'),token};
}
export const signature=settings=>JSON.stringify([settings.mode,settings.privateQQ,settings.groupId,settings.masterQQ,settings.allowGroupAdd,settings.groupAddByOwner,settings.groupAddByAdmin,settings.groupAddByGroupOwner,settings.upstreamUrl,settings.relayPort,settings.corePort,settings.token]);
export function connectionDraft(ctx,input={}){
  const cfg={...ctx.cfg};
  cfg.connectionMode=input.mode??cfg.connectionMode??'official';
  if(!['official','manual'].includes(cfg.connectionMode))throw connectionError('invalid_mode','请选择复用官方 QQ 或手动连接。');
  for(const [key,label]of [['privateQQ','私聊接收 QQ'],['groupId','接收群号'],['masterQQ','主人 QQ']]){
    const value=String(input[key]??cfg[key]??'').trim();
    if(value!==''&&value!=='0'&&!validQQ(value))throw connectionError('invalid_owner',`请填写有效的${label}；不使用时留空。`);
    cfg[key]=Number(value)||0;
  }
  for(const key of ['allowGroupAdd','groupAddByOwner','groupAddByAdmin','groupAddByGroupOwner']){
    if(input[key]!==undefined&&typeof input[key]!=='boolean')throw connectionError('invalid_owner','群内添加权限必须为开启或关闭。');
    cfg[key]=input[key]??cfg[key]??false;
  }
  if(cfg.allowGroupAdd&&!validQQ(cfg.groupId))throw connectionError('invalid_owner','允许群内添加时，请自行填写接收群号。');
  if(cfg.allowGroupAdd&&!['groupAddByOwner','groupAddByAdmin','groupAddByGroupOwner'].some(key=>cfg[key]))throw connectionError('invalid_owner','请选择至少一种允许在群内添加的身份。');
  if(cfg.allowGroupAdd&&cfg.groupAddByOwner&&!validQQ(cfg.masterQQ))throw connectionError('invalid_owner','允许主人在群内添加时，请自行填写主人 QQ。');
  cfg.relayPort=validatePort(input.relayPort??cfg.relayPort??3002);
  cfg.corePort=validatePort(input.corePort??cfg.corePort??17788,'Coopanion 本机接口端口');
  let tokenInput='';
  if(cfg.connectionMode==='manual'){
    cfg.upstreamUrl=validateUrl(input.upstreamUrl??cfg.upstreamUrl??DEFAULT_UPSTREAM);
    tokenInput=validateToken(input.token??'');
    if(tokenInput&&input.noToken===true)throw connectionError('invalid_token','已填写令牌，请取消“无需访问令牌”。');
    cfg.useToken=input.noToken===undefined?cfg.useToken!==false:!input.noToken;
    if(tokenInput)cfg.useToken=true;
  }
  return {cfg,tokenInput};
}
export function safeError(error){
  if(/CERT|TLS/.test(error?.code??''))return {code:'tls_error',message:'加密连接的证书无法验证，请检查 wss 地址及证书。'};
  if(error?.code==='EADDRINUSE')return {code:'port_in_use',message:'日程转接端口已被占用，请在高级选项中换一个端口。'};
  const known={ECONNREFUSED:['connection_refused','连接被拒绝，请确认 OneBot 已启动，地址和端口填写正确。'],ENOTFOUND:['host_not_found','找不到连接主机，请检查地址。'],ETIMEDOUT:['timeout','连接超时，请检查网络、端口和 OneBot 状态。'],EPROTO:['tls_error','加密连接失败，请检查 wss 地址及证书。']};
  if(known[error?.code])return {code:known[error.code][0],message:known[error.code][1]};
  if(['invalid_url','invalid_port','invalid_token','invalid_owner','invalid_mode','official_missing','relay_loop','auth_failed','not_logged_in','timeout','save_failed'].includes(error?.code))return {code:error.code,message:error.message};
  return {code:'connection_failed',message:'QQ 连接未完成，请核对 OneBot 地址、登录状态和访问令牌。'};
}
/** Read-only login check; never sends a message or changes the live QQ route. */
export function probeOneBot(settings,{timeoutMs=5000}={}){
  return new Promise(resolve=>{
    const echo='agenda-check:'+randomUUID();let socket,timer,done=false;
    const finish=result=>{if(done)return;done=true;clearTimeout(timer);socket?.terminate();resolve({...result,checkedAt:new Date().toISOString()});};
    try{socket=new WebSocket(settings.upstreamUrl,{headers:settings.token?{Authorization:'Bearer '+settings.token}:{},maxPayload:1024*1024});}
    catch(error){finish({ok:false,...safeError(error)});return;}
    socket.on('error',error=>finish({ok:false,...safeError(error)}));
    socket.on('unexpected-response',(_req,res)=>{res.resume();finish({ok:false,...(res.statusCode===401||res.statusCode===403?{code:'auth_failed',message:'访问令牌不匹配或缺失，请核对官方 QQ / OneBot 的令牌。'}:{code:'connection_failed',message:'该地址没有接受 OneBot WebSocket 连接，请检查地址和端口。'})});});
    socket.on('open',()=>socket.send(JSON.stringify({action:'get_login_info',params:{},echo})));
    socket.on('message',raw=>{let value;try{value=JSON.parse(raw);}catch{return;}if(value.echo!==echo)return;
      if(value.status==='failed'||Number(value.retcode??0)!==0||!validOwner(value.data?.user_id))return finish({ok:false,code:'not_logged_in',message:'OneBot 未返回有效的登录身份，请确认 QQ 已登录。'});
      finish({ok:true,code:'connected',message:'连接正常（QQ '+Number(value.data.user_id)+'）',bot:{id:Number(value.data.user_id)}});
    });
    socket.on('close',()=>finish({ok:false,code:'connection_closed',message:'连接在验证完成前关闭，请检查 OneBot 登录状态及令牌。'}));
    timer=setTimeout(()=>finish({ok:false,code:'timeout',message:'连接验证超时，未收到 OneBot 登录回执，请检查地址是否正确。'}),timeoutMs);
  });
}
