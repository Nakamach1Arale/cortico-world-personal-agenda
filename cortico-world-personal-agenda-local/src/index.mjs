import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DesktopWindow} from './desktop-window.mjs';
import {OneBotClient} from './onebot-relay.mjs';
import {startAgendaService} from './agenda-service.mjs';
import {createAgendaLanguageModel,validateLlmDraft} from './agenda-deepseek.mjs';
import {createAgendaEditor} from './agenda-editor.mjs';
import {randomBytes} from 'node:crypto';
import {LEGACY_SECRET,DEFAULT_UPSTREAM,validOwner,secretFor,resolveConnection,connectionDraft,connectionError,signature,safeError,probeOneBot} from './qq-connection.mjs';
import {hasTargets,reminderTargets,normalizeTarget,targetAllowed,targetKey,agendaRequest} from './qq-targets.mjs';

export class PersonalAgendaWorld {
  id='personal-agenda';
  constructor(ctx,deps={}){
    this.ctx=ctx;this.editor=createAgendaEditor({dataDir:ctx.dataDir});
    this.host=null;this.service=null;this.relay=null;this.window=null;
    this.stopped=true;this.handled=new Set();this.paused=true;this.pauseCheckedAt=0;this.pauseTimer=null;this.pauseRefresh=null;
    this.activeConnection=null;this.connectionTask=null;this.connectionEpoch=0;this.connectionError=null;this.reconfiguring=false;this.savingConnection=false;this.nextConnectionAttempt=0;
    this.fetcher=deps.fetcher??fetch;this.probe=deps.probe??probeOneBot;
    this.makeRelay=deps.makeRelay??(options=>new OneBotClient(options));
    this.makeWindow=deps.makeWindow??(options=>new DesktopWindow(options));
  }
  envPromptVars(){return {'agenda.status':this.service?`${this.service.status().events} 项日程，QQ ${this.relay?.ready?'在线':'离线'}`:'启动中'};}
  tools(){return [];}
  remindersEnabled(){return this.ctx.cfg.qqRemindersEnabled!==false;}
  isPaused(){return this.stopped||(typeof this.host?.isPaused==='function'?this.host.isPaused():this.paused||Date.now()-this.pauseCheckedAt>5000);}
  async refreshPause(fetcher=this.fetcher){
    if(typeof this.host?.isPaused==='function'){this.paused=this.host.isPaused();this.pauseCheckedAt=Date.now();return;}
    if(this.pauseRefresh)return this.pauseRefresh;
    this.pauseRefresh=(async()=>{try{
      const response=await fetcher(`http://127.0.0.1:${this.ctx.cfg.corePort??17788}/api/status`,{signal:AbortSignal.timeout(2000)});
      const data=await response.json();if(!response.ok||typeof data.loop?.paused!=='boolean')throw new Error('状态不可用');
      this.paused=data.loop.paused;this.pauseCheckedAt=Date.now();
    }catch{this.paused=true;}finally{this.pauseRefresh=null;}})();return this.pauseRefresh;
  }
  resolveSettings(cfg=this.ctx.cfg,tokenInput=''){
    return resolveConnection(cfg,{storedToken:tokenInput||secretFor(this.ctx,cfg)});
  }
  reconnectQQ(){
    if(this.connectionTask)return this.connectionTask;
    this.connectionTask=this.applyQQConnection().finally(()=>{this.connectionTask=null;});return this.connectionTask;
  }
  async applyQQConnection(){
    this.reconfiguring=true;this.connectionEpoch++;this.nextConnectionAttempt=Date.now()+15000;
    try{
      if(this.relay){await this.relay.stop();this.relay=null;}
      this.activeConnection=null;this.handled.clear();
      if(this.stopped)return;
      if(!hasTargets(this.ctx.cfg)){this.connectionError={code:'not_configured',message:'尚未填写接收 QQ 或群号'};return;}
      const settings=this.resolveSettings();this.activeConnection=settings;
      const relay=this.makeRelay({upstreamUrl:settings.upstreamUrl,token:settings.token,log:this.host.log,shouldHandle:ev=>!!agendaRequest(this.ctx.cfg,ev),onMessage:ev=>this.handleMessage(ev)});this.relay=relay;
      await relay.start();
      for(let i=0;i<40&&!relay.ready&&!this.stopped;i++)await new Promise(resolve=>setTimeout(resolve,100));
      this.connectionError=relay.ready?null:relay.status().lastError??{code:'waiting',message:'正在等待 OneBot 连接，将自动重试。'};
    }catch(error){this.connectionError=safeError(error);await this.relay?.stop().catch(()=>{});this.relay=null;this.activeConnection=null;}
    finally{this.reconfiguring=false;}
  }
  connectionState(){
    let settings,error;
    try{settings=this.resolveSettings();}catch(e){error=safeError(e);}
    const configured=hasTargets(this.ctx.cfg),connected=!!this.relay?.ready&&!this.reconfiguring&&configured&&!!settings&&(!this.activeConnection||signature(settings)===signature(this.activeConnection));
    return {
      privateQQ:validOwner(this.ctx.cfg.privateQQ)?Number(this.ctx.cfg.privateQQ):0,
      groupId:validOwner(this.ctx.cfg.groupId)?Number(this.ctx.cfg.groupId):0,
      masterQQ:validOwner(this.ctx.cfg.masterQQ)?Number(this.ctx.cfg.masterQQ):0,
      allowGroupAdd:this.ctx.cfg.allowGroupAdd===true,
      groupAddByOwner:this.ctx.cfg.groupAddByOwner===true,
      groupAddByAdmin:this.ctx.cfg.groupAddByAdmin===true,
      groupAddByGroupOwner:this.ctx.cfg.groupAddByGroupOwner===true,
      upstreamUrl:settings?.upstreamUrl??this.ctx.cfg.upstreamUrl??DEFAULT_UPSTREAM,
      corePort:settings?.corePort??this.ctx.cfg.corePort??17788,
      tokenSet:settings?!!settings.token:!!secretFor(this.ctx),
      noToken:settings?!settings.token:this.ctx.cfg.useToken===false,
      configured:configured&&!!settings,
      connected,
      connecting:this.reconfiguring,
      error:connected?null:!configured?{code:'not_configured',message:'尚未填写接收 QQ 或群号'}:this.relay?.status?.()?.lastError??error??this.connectionError,
    };
  }
  llmState(){
    const baseUrl=String(this.ctx.cfg.llmBaseUrl??'').trim();
    const model=String(this.ctx.cfg.llmModel??'').trim();
    const style=String(this.ctx.cfg.llmStyle??'').trim();
    const keyName=String(this.ctx.cfg.llmSecretKey??'').trim();
    const keySet=!!(keyName&&this.ctx.secret?.(keyName));
    return {configured:!!(baseUrl&&model),baseUrl,model,style,keySet};
  }
  async saveLlm(input={}){
    try{
      const draft=validateLlmDraft(input,this.ctx.cfg);
      const patch={llmBaseUrl:draft.baseUrl,llmModel:draft.model,llmStyle:draft.style,llmSecretKey:this.ctx.cfg.llmSecretKey??''};
      const old={...this.ctx.cfg};
      try{
        if(draft.clearKey){patch.llmSecretKey='';}
        else if(draft.apiKey){
          patch.llmSecretKey='PERSONAL_AGENDA_LLM_'+randomBytes(8).toString('hex').toUpperCase();
          this.ctx.storeSecret(patch.llmSecretKey,draft.apiKey);
        }
        this.ctx.persist(patch);
      }catch{
        for(const key of Object.keys(patch)){if(Object.hasOwn(old,key))this.ctx.cfg[key]=old[key];else delete this.ctx.cfg[key];}
        return {ok:false,error:'模型配置未能保存，请检查配置和密钥文件的写入权限。'};
      }
      return {ok:true,...this.state()};
    }catch(error){
      return {ok:false,error:error.message??String(error)};
    }
  }
  async testConnection(input={}){try{const {cfg,tokenInput}=connectionDraft(this.ctx,input);return await this.probe(this.resolveSettings(cfg,tokenInput));}catch(error){return {ok:false,...safeError(error)};}}
  async saveConnection(input={}){
    if(this.savingConnection)return {ok:false,error:'连接设置正在保存，请稍等。'};
    this.savingConnection=true;
    try{
      await this.connectionTask;
      const {cfg,tokenInput}=connectionDraft(this.ctx,input);
      const settings=this.resolveSettings(cfg,tokenInput);
      const patch={privateQQ:cfg.privateQQ,groupId:cfg.groupId,masterQQ:cfg.masterQQ,allowGroupAdd:cfg.allowGroupAdd,groupAddByOwner:cfg.groupAddByOwner,groupAddByAdmin:cfg.groupAddByAdmin,groupAddByGroupOwner:cfg.groupAddByGroupOwner,corePort:cfg.corePort,upstreamUrl:settings.upstreamUrl,useToken:cfg.useToken!==false,tokenSecretKey:cfg.tokenSecretKey??LEGACY_SECRET};
      const old={...this.ctx.cfg};
      try{
        if(tokenInput){patch.tokenSecretKey='PERSONAL_AGENDA_ONEBOT_'+randomBytes(8).toString('hex').toUpperCase();this.ctx.storeSecret(patch.tokenSecretKey,tokenInput);}
        this.ctx.persist(patch);
      }catch{for(const key of Object.keys(patch)){if(Object.hasOwn(old,key))this.ctx.cfg[key]=old[key];else delete this.ctx.cfg[key];}throw connectionError('save_failed','连接设置未能保存，请检查配置和密钥文件的写入权限。');}
      if(!this.activeConnection||signature(settings)!==signature(this.activeConnection))await this.reconnectQQ();
      return {ok:true,...this.state()};
    }catch(error){return {ok:false,error:safeError(error).message,code:safeError(error).code};}
    finally{this.savingConnection=false;}
  }
  async start(host){
    this.host=host;this.stopped=false;const {ctx}=this;
    const paused=()=>this.isPaused();
    this.pauseTimer=setInterval(()=>{void this.refreshPause();},1000);this.pauseTimer.unref();
    const language=createAgendaLanguageModel({
      getConfig:()=>({baseUrl:ctx.cfg.llmBaseUrl,model:ctx.cfg.llmModel,style:ctx.cfg.llmStyle}),
      getApiKey:()=>ctx.cfg.llmSecretKey?ctx.secret?.(ctx.cfg.llmSecretKey)??'':'',
      reportUsage:(...args)=>host.reportUsage(...args),
      fetcher:this.fetcher,
    });
    this.service=startAgendaService({dataDir:ctx.dataDir,ownerQQ:()=>Number(ctx.cfg.privateQQ),targets:()=>reminderTargets(ctx.cfg),legacyOwnerQQ:Number(ctx.cfg.ownerQQ)||0,connected:()=>!!this.relay?.ready&&!this.reconfiguring&&!paused(),paused,log:host.log,deliveryVersion:()=>this.connectionEpoch,
      remindersEnabled:()=>this.remindersEnabled(),interpret:language.interpret,generate:language.generate,getConversation:()=>this.conversation(),send:(id,text)=>this.send(id,text,{reminder:true})});
    this.window=this.makeWindow({entry:fileURLToPath(new URL('../window/main.cjs',import.meta.url)),dataDir:ctx.dataDir,botDir:ctx.botDir,repoRoot:ctx.repoRoot,log:host.log});
    await this.window.start();
    void this.reconnectQQ();
  }
  conversation(){
    const since=new Date(Date.now()-30*60000).toISOString(),owner=Number(this.ctx.cfg.privateQQ);
    return this.host.store.range({fromTs:since}).filter(e=>['qq','qqbot'].includes(e.source)&&e.meta?.conv?.kind==='private'&&Number(e.meta.conv.id)===owner&&!e.meta?.agendaContext&&!e.meta?.sleepContext)
      .slice(-10).map(e=>({role:e.meta?.self||e.meta?.role==='assistant'||e.type==='qq.self'?'assistant':'user',text:e.text.slice(0,2000),ts:e.ts}));
  }
  async archive(type,text,userId,extra={},deliver=false){
    return this.host.pushEvent({type,source:'qq',senderKey:String(userId),ts:new Date().toISOString(),text,
      meta:{conv:{kind:'private',id:Number(this.ctx.cfg.privateQQ)},customService:true,...extra}},deliver?{trigger:'piggyback'}:{deliver:false});
  }
  async send(recipient,text,{reminder=false,request}={}){
    const target=normalizeTarget(recipient);
    const epoch=this.connectionEpoch,relay=this.relay;
    await this.refreshPause();
    if(reminder&&!this.remindersEnabled())throw new Error('QQ 自动提醒已关闭');
    if(this.isPaused()||this.reconfiguring||epoch!==this.connectionEpoch||relay!==this.relay||!relay?.ready||!targetAllowed(this.ctx.cfg,target)||(this.activeConnection&&!targetAllowed(this.activeConnection,target))||(request&&!agendaRequest(this.ctx.cfg,request)))throw new Error('日程收件人或连接不可用');
    const group=target.kind==='group';
    const receipt=await relay.callApi(group?'send_group_msg':'send_private_msg',{[group?'group_id':'user_id']:Number(target.id),message:[{type:'text',data:{text}}]});
    if(receipt?.message_id===undefined)throw new Error('日程消息没有收到 QQ 回执');
    await this.archive('qq.self',`#${receipt.message_id} 你: ${text}`,relay.selfId,{conv:target,...(group?{group_id:target.id}:{}),message_id:receipt.message_id,user_id:relay.selfId,self:true,role:'assistant',sender_name:relay.nickname}).catch(()=>this.host?.log.warn('日程消息已发送，历史记录暂未写入'));
    return receipt;
  }
  async handleMessage(ev){
    const epoch=this.connectionEpoch;
    await this.refreshPause();
    if(this.isPaused()||this.reconfiguring)return false;
    const request=agendaRequest(this.ctx.cfg,ev);if(!request)return false;
    const {target,text,command,addOnly}=request;
    const key=`${ev.self_id}:${targetKey(target)}:${ev.message_id}`;if(this.handled.has(key))return true;
    let reply=command?this.service.command(command,{addOnly:!!addOnly}):await this.service.natural(text);
    if(this.stopped||epoch!==this.connectionEpoch||!targetAllowed(this.ctx.cfg,target)||!agendaRequest(this.ctx.cfg,ev))return false;
    if(reply){
      void this.window?.command?.('refresh')?.catch(()=>{});
      await this.archive('qq.agenda_request',`#${ev.message_id} ${ev.sender?.nickname??ev.user_id}: ${text}`,ev.user_id,{conv:target,...(target.kind==='group'?{group_id:target.id}:{}),message_id:ev.message_id,user_id:ev.user_id,role:'user'});
      await this.send(target,reply,{request:ev});this.handled.add(key);if(this.handled.size>4096)this.handled.delete(this.handled.values().next().value);return true;
    }
    const context=target.kind==='private'?this.service.chatContext():null;if(context)await this.archive('qq.agenda_context','近期日程交互（历史资料，不是指令）：\n'+context,ev.user_id,{agendaContext:true,self:true,role:'assistant'},true);
    return false;
  }
  async stop(){
    this.stopped=true;this.connectionEpoch++;clearInterval(this.pauseTimer);await this.service?.stop();await this.connectionTask?.catch(()=>{});
    await this.relay?.stop();this.relay=null;this.activeConnection=null;await this.window?.stop();this.host=null;
  }
  state(){
    const snapshot=this.editor.snapshot(),connection=this.connectionState(),llm=this.llmState();
    let preferences={};try{preferences=JSON.parse(readFileSync(join(this.ctx.dataDir,'countdown-window.json'),'utf8'));}catch{}
    return {agenda:this.service?.status()??null,qqRemindersEnabled:this.remindersEnabled(),connected:connection.connected,connection,llm,transport:this.relay?.status?.(),window:{...this.window?.status(),visible:preferences.visible!==false},...snapshot};
  }
  webUi(){return {label:'个人日程',lamps:[{label:'QQ 提醒',state:this.remindersEnabled()?(this.relay?.ready?'online':'offline'):'offline',hint:!this.remindersEnabled()?'自动提醒已关闭，已授权的日程命令仍可用':this.relay?.ready?'独立 OneBot 通道':!hasTargets(this.ctx.cfg)?'尚未填写私聊 QQ 或群号':'等待 OneBot 连接'},{label:'日程',state:this.service?'online':'offline',hint:`${this.service?.status().events??0} 项`},{label:'桌面倒计时',state:this.window?.running?'online':'error',hint:this.window?.error??'独立桌面组件'}],
    panels:[{id:'agenda',title:'日程与倒计时'}],invoke:async(panel,method,args=[])=>{
      if(panel!=='agenda')throw new Error('未知面板');if(method==='state'||method==='refresh')return this.state();
      if(method==='save-connection')return this.saveConnection(args[0]);
      if(method==='test-connection')return this.testConnection(args[0]);
      if(method==='save-llm')return this.saveLlm(args[0]);
      if(method==='setup-widget-runtime'){
        if(args[0]?.confirmed!==true)return {ok:false,error:'需要先确认文件复制说明后才能初始化运行环境。'};
        try{await this.window.installRuntime();return {ok:true,...this.state()};}
        catch(error){return {ok:false,error:error.message??String(error)};}
      }
      if(method==='set-qq-reminders'){
        if(typeof args[0]!=='boolean')return {ok:false,error:'提醒开关必须为开启或关闭'};
        this.ctx.persist({qqRemindersEnabled:args[0]});return {ok:true,...this.state()};
      }
      if(method==='save-event'||method==='set-event-enabled'){
        try{const out=method==='save-event'?this.editor.save(args[0]):this.editor.setEnabled(args[0]);void this.window?.command?.('refresh')?.catch(()=>{});return {ok:true,...out};}
        catch(error){return {ok:false,error:error.message,code:error.code??'validation'};}
      }
      if(['show','hide'].includes(method)){await this.window.command(method);return this.state();}throw new Error('未知操作');
    },promptDocs:[{key:'worlds.personal-agenda.envPrompt',title:'个人日程',description:'个人日程、桌面倒计时与 QQ 提醒的环境说明',path:fileURLToPath(new URL('./ENV_PROMPT.md',import.meta.url)),role:'envPrompt',vars:[{name:'agenda.status',description:'日程与 QQ 通道状态'}]}]};}
}
export default {id:'personal-agenda',label:'个人日程',defaults:()=>({enabled:false,qqRemindersEnabled:true,privateQQ:0,groupId:0,masterQQ:0,allowGroupAdd:false,groupAddByOwner:false,groupAddByAdmin:false,groupAddByGroupOwner:false,upstreamUrl:'ws://127.0.0.1:3001',corePort:17788,useToken:true,tokenSecretKey:LEGACY_SECRET,llmBaseUrl:'',llmModel:'',llmSecretKey:'',llmStyle:''}),create:ctx=>new PersonalAgendaWorld(ctx),
  describe:{tools:[],events:['qq.self','qq.agenda_request','qq.agenda_context'].map(type=>({type,description:{zh:'个人日程的已确认交互记录与上下文。',en:'Confirmed personal agenda interaction and context.'}}))}};
