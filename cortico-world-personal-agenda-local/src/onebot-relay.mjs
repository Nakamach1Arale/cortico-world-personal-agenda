import WebSocket,{WebSocketServer} from '../vendor/ws/wrapper.mjs';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {validateUrl,validateToken,safeError} from './qq-connection.mjs';

/** Stable OneBot v11 boundary: no imports from or edits to the QQ extension. */
export class OneBotRelay {
  constructor({port=3002,upstreamUrl,token='',onMessage,ownerQQ=()=>null,shouldHandle,log}){
    validateUrl(upstreamUrl);validateToken(token);
    Object.assign(this,{port,upstreamUrl,token,onMessage,ownerQQ,log});
    this.shouldHandle=shouldHandle??(ev=>ev.message_type==='private'&&Number(ev.user_id)===this.ownerQQ());
    this.server=null;this.upstream=null;this.clients=new Set();this.pending=new Map();this.stopped=true;this.ready=false;this.selfId=null;this.nickname='';this.inbound=Promise.resolve();this.retry=null;this.lastError=null;
  }
  status(){return {connected:this.ready,selfId:this.selfId,clients:this.clients.size,port:this.server?.address()?.port??this.port,lastError:this.lastError};}
  authorized(req){
    const value=req.headers.authorization?.replace(/^Bearer\s+/i,'')??new URL(req.url,'http://localhost').searchParams.get('access_token')??'';
    const a=Buffer.from(value),b=Buffer.from(this.token);return a.length===b.length&&timingSafeEqual(a,b);
  }
  async start(){
    this.stopped=false;
    const server=new WebSocketServer({host:'127.0.0.1',port:this.port,maxPayload:32*1024*1024,verifyClient:info=>this.authorized(info.req)});this.server=server;
    await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
    server.on('error',()=>this.log.warn('日程本机连接暂时不可用'));
    server.on('connection',socket=>{
      if(!this.ready){socket.close(1013,'OneBot reconnecting');return;}
      this.clients.add(socket);
      socket.on('message',raw=>{
        let req;try{req=JSON.parse(raw.toString());}catch{return;}
        if(typeof req.action!=='string'||!this.ready)return;
        void this.request(req,{socket,echo:req.echo}).catch(()=>{});
      });
      socket.on('close',()=>{this.clients.delete(socket);for(const [id,p] of this.pending)if(p.socket===socket){clearTimeout(p.timer);this.pending.delete(id);}});
      socket.on('error',()=>{});
    });
    this.connect();
  }
  connect(){
    if(this.stopped)return;
    this.lastError=null;
    const socket=new WebSocket(this.upstreamUrl,{headers:this.token?{Authorization:'Bearer '+this.token}:{},maxPayload:32*1024*1024});this.upstream=socket;
    socket.once('open',async()=>{
      try{const identity=await this.callApi('get_login_info',{});if(!Number.isSafeInteger(Number(identity?.user_id))||Number(identity.user_id)<10000)throw new Error();if(this.stopped||this.upstream!==socket)return;this.selfId=Number(identity.user_id);this.nickname=String(identity.nickname??'');this.ready=true;this.lastError=null;this.log.info('个人日程 QQ 通道已连接');}
      catch{this.lastError={code:'not_logged_in',message:'OneBot 未返回有效的登录身份，请确认 QQ 已登录。'};socket.close();}
    });
    socket.on('message',raw=>{
      let value;try{value=JSON.parse(raw.toString());}catch{return;}
      const job=this.pending.get(value.echo);
      if(job){clearTimeout(job.timer);this.pending.delete(value.echo);
        if(job.socket){if(job.socket.readyState===WebSocket.OPEN)job.socket.send(JSON.stringify({...value,echo:job.echo}));job.resolve(value.data);}
        else if(value.status==='failed'||(value.retcode!==undefined&&Number(value.retcode)!==0))job.reject(new Error('OneBot 操作未成功'));
        else job.resolve(value.data);
        return;
      }
      if(!value.post_type)return;
      if(value.post_type==='message'&&this.shouldHandle(value)){
        this.inbound=this.inbound.then(async()=>{
          if(this.stopped)return;
          let handled=false;try{handled=await this.onMessage(value);}catch{this.log.warn('日程消息未处理，交回 QQ 对话');}
          if(!handled&&!this.stopped)this.broadcast(raw);
        }).catch(()=>{});
      }else this.broadcast(raw);
    });
    socket.on('error',error=>{this.lastError??=safeError(error);});
    socket.on('unexpected-response',(_req,res)=>{res.resume();this.lastError=res.statusCode===401||res.statusCode===403?{code:'auth_failed',message:'访问令牌不匹配或缺失，请核对 QQ / OneBot 的令牌。'}:{code:'connection_failed',message:'服务器没有接受 OneBot WebSocket 连接，请检查地址。'};socket.terminate();});
    socket.once('close',()=>{
      if(this.upstream!==socket)return;this.ready=false;this.upstream=null;
      this.lastError??={code:'disconnected',message:'QQ 连接已断开，正在自动重连。'};
      for(const client of this.clients)client.close(1013,'OneBot reconnecting');
      for(const job of this.pending.values()){clearTimeout(job.timer);job.reject?.(new Error('OneBot 连接中断'));}this.pending.clear();
      if(!this.stopped){this.retry=setTimeout(()=>this.connect(),1500);this.retry.unref();}
    });
  }
  broadcast(raw){for(const socket of this.clients)if(socket.readyState===WebSocket.OPEN)socket.send(raw);}
  request(req,downstream){
    if(this.upstream?.readyState!==WebSocket.OPEN)return Promise.reject(new Error('OneBot 未连接'));
    if(this.pending.size>=512)return Promise.reject(new Error('OneBot 请求过多'));
    const echo='personal-agenda:'+randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(echo);if(downstream?.socket.readyState===WebSocket.OPEN)downstream.socket.send(JSON.stringify({status:'failed',retcode:1500,message:'OneBot request timed out',echo:downstream.echo}));reject(new Error('OneBot 请求超时'));},10000);timer.unref();
      this.pending.set(echo,{...downstream,resolve,reject,timer});
      this.upstream.send(JSON.stringify({...req,echo}),error=>{if(error){clearTimeout(timer);this.pending.delete(echo);reject(error);}});
    });
  }
  callApi(action,params){return this.request({action,params});}
  async stop(){
    this.stopped=true;this.ready=false;clearTimeout(this.retry);
    for(const job of this.pending.values()){clearTimeout(job.timer);job.reject?.(new Error('日程服务已停止'));}this.pending.clear();
    for(const client of this.clients)client.terminate();this.clients.clear();
    const upstream=this.upstream;this.upstream=null;upstream?.terminate();
    const server=this.server;this.server=null;if(server)await new Promise(resolve=>server.close(resolve));
  }
}
