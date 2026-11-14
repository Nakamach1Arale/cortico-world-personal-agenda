const systemTimezone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
const commonZones={'UTC':'协调世界时','Asia/Shanghai':'北京 / 上海','Asia/Taipei':'台北','Asia/Tokyo':'东京','Asia/Seoul':'首尔','Asia/Singapore':'新加坡','Europe/London':'伦敦','Europe/Paris':'巴黎','America/New_York':'纽约','America/Los_Angeles':'洛杉矶','Australia/Sydney':'悉尼'};
function el(tag,attrs={},...children){
  const node=document.createElement(tag);
  for(const [key,value]of Object.entries(attrs)){
    if(key==='class')node.className=value;
    else if(key.startsWith('on'))node.addEventListener(key.slice(2).toLowerCase(),value);
    else if(key==='text')node.textContent=value;
    else if(value!==undefined&&value!==null){if(['checked','disabled','value','type','name','required','maxLength'].includes(key))node[key]=value;else node.setAttribute(key,String(value));}
  }
  for(const child of children.flat())if(child!==undefined&&child!==null)node.append(child instanceof Node?child:document.createTextNode(String(child)));
  return node;
}
const button=(text,action,kind='')=>el('button',{type:'button',class:'cw-button '+kind,onClick:action},text);
const dateText=(value,zone=systemTimezone())=>new Intl.DateTimeFormat('zh-CN',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value));
const localInput=(value,zone)=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).map(p=>[p.type,p.value]));return `${p.year.padStart(4,'0')}-${p.month}-${p.day}T${p.hour}:${p.minute}`;};
const reminderText=minutes=>minutes.length?minutes.map(m=>m===0?'到点':m%1440===0?`提前 ${m/1440} 天`:m%60===0?`提前 ${m/60} 小时`:`提前 ${m} 分钟`).join(' · '):'不发送提醒';
export function parseReminders(checked,custom){
  const extra=custom.trim()?custom.trim().split(/[,，\s]+/):[];
  if(extra.some(x=>!/^\d+$/.test(x)))throw new Error('自定义提前量请填写整数分钟，以逗号分隔。');
  const values=[...new Set([...checked,...extra.map(Number)])].sort((a,b)=>b-a);
  if(values.length>5||values.some(x=>!Number.isSafeInteger(x)||x<0||x>43200))throw new Error('最多设置 5 个提醒，每个提前量为 0–43200 分钟。');
  return values;
}

const panel={mount(ctx){
  const root=el('section',{class:'cw-tools cw-agenda'});ctx.root.append(root);
  let stopped=false,loading=false,changing=false,data=null,filter='upcoming',query='',editorOpen=false;
  const notice=el('div',{class:'cw-notice',role:'status','aria-live':'polite',hidden:true});
  function message(text,error=false){notice.hidden=!text;notice.textContent=text;notice.classList.toggle('is-error',error);}
  const heading=el('div',{class:'cw-heading'},el('div',{},el('div',{class:'cw-eyebrow'},'PERSONAL AGENDA'),el('h2',{},'让重要的事，准时发生。'),el('p',{class:'cw-muted'},'管理日程、桌面倒计时和 QQ 提醒。')));
  const refresh=button('刷新',()=>load(),'quiet'),toggle=button('显示挂件',()=>control(data?.window?.visible?'hide':'show'),'quiet');
  heading.append(el('div',{class:'cw-actions'},toggle,refresh));root.append(heading,notice);
  const summary=el('div',{class:'cw-summary'}),body=el('div',{});root.append(summary);
  let reminderSwitch,connectionHint;
  {
    reminderSwitch=el('button',{type:'button',role:'switch','aria-label':'QQ 自动提醒','aria-checked':'true',class:'cw-reminder-switch',onClick:()=>setReminders(!(data?.qqRemindersEnabled!==false))});
    root.append(el('div',{class:'cw-reminder-setting'},el('div',{},el('strong',{},'QQ 自动提醒'),el('p',{class:'cw-small'},'关闭后暂停自动推送。')),reminderSwitch));
    connectionHint=el('p',{class:'cw-small'},'未接入 QQ');
    root.append(el('div',{class:'cw-connection-setting'},el('div',{},el('strong',{},'QQ 接入'),connectionHint),button('设置连接',()=>editConnection(),'quiet')));
  }
  root.append(body);
  const search=el('input',{type:'search',class:'cw-search',placeholder:'搜索标题、备注或详情','aria-label':'搜索日程',onInput:event=>{query=event.target.value;renderList();}});
  const list=el('div',{class:'cw-list'}),tabs=el('div',{class:'cw-tabs','aria-label':'日程筛选'}),count=el('span',{class:'cw-muted'});
  {
    for(const [key,label]of [['upcoming','待发生'],['all','全部'],['cancelled','已取消']])tabs.append(button(label,()=>{filter=key;renderList();},'tab'));
    body.append(el('div',{class:'cw-list-toolbar'},el('div',{class:'cw-actions'},tabs,count),button('＋ 新增日程',()=>edit(null),'primary')),search,list);
  }
  function summaryCard(label,value,hint){return el('div',{class:'cw-stat'},el('span',{class:'cw-muted'},label),el('strong',{},value),...(hint?[el('span',{class:'cw-small'},hint)]:[]));}
  function render(){
    toggle.textContent=data.window?.visible?'隐藏挂件':'显示挂件';toggle.setAttribute('aria-pressed',String(!!data.window?.visible));
    summary.replaceChildren();
    {
      const connection=data.connection;
      const destinations=[connection?.privateQQ?`私聊 ${connection.privateQQ}`:'',connection?.groupId?`群 ${connection.groupId}`:''].filter(Boolean).join('、');
      connectionHint.textContent=connection?.connected?`已连接 · ${connection.mode==='manual'?'手动接入':'复用官方 QQ'} · ${destinations}${connection.routeConnected?'':' · 等待官方 QQ 连入'}`:connection?.error?.message??(connection?.connecting?'正在连接 QQ…':'未接入 QQ');
      const upcoming=(data.events??[]).filter(e=>e.enabled&&Date.parse(e.start)>Date.now());
      const remindersOn=data.qqRemindersEnabled!==false;reminderSwitch.setAttribute('aria-checked',String(remindersOn));reminderSwitch.textContent=remindersOn?'已开启':'已关闭';
      const next=upcoming.sort((a,b)=>Date.parse(a.start)-Date.parse(b.start))[0];
      summary.append(summaryCard('待发生',upcoming.length,next?`最近：${next.title}`:'暂无待办'),summaryCard('QQ 提醒',!remindersOn?'已关闭':data.connection?.configured===false?'待配置':data.connected?(data.agenda?.paused?'已暂停':'已连接'):'未连接',data.agenda?.last_error??(destinations||'未设置接收对象')),summaryCard('桌面倒计时',data.window?.running?(data.window.visible?'显示中':'已隐藏'):'未运行',data.window?.error??''));
      renderList();
    }
  }
  function renderList(){
    if(!data)return;
    [...tabs.children].forEach((b,i)=>b.setAttribute('aria-pressed',String(['upcoming','all','cancelled'][i]===filter)));
    const events=(data.events??[]).filter(e=>(filter==='all'||filter==='cancelled'?!e.enabled||filter==='all':e.enabled&&Date.parse(e.start)>Date.now())&&(!query||[e.title,e.subtitle??'',e.remark??'',e.details??e.notes??''].join(' ').toLowerCase().includes(query.toLowerCase())))
      .sort((a,b)=>Date.parse(a.start)-Date.parse(b.start));
    count.textContent=`${events.length} 项`;list.replaceChildren();
    if(!events.length){list.append(el('div',{class:'cw-empty'},el('strong',{},query?'没有匹配的日程':filter==='upcoming'?'接下来暂时没有安排':'这里还没有日程'),el('p',{class:'cw-muted'},query?'换个关键词，或查看全部日程。':'点击右上角「新增日程」添加安排。')));return;}
    for(const event of events){
      const past=Date.parse(event.start)<=Date.now();
      const badges=el('div',{class:'cw-actions'},el('span',{class:'cw-badge '+(!event.enabled?'off':past?'off':'')},!event.enabled?'已取消':past?'已结束':'待发生'));
      if(event.status==='tentative')badges.append(el('span',{class:'cw-badge tentative'},'预计时间'));
      if(event.remark)badges.append(el('span',{class:'cw-badge cw-remark'},event.remark));
      const content=el('div',{class:'cw-event-content'},badges,el('h3',{},event.title));
      if(event.subtitle)content.append(el('p',{class:'cw-small'},event.subtitle));
      const eventZone=event.resolvedTimezone??(event.timezone&&event.timezone!=='local'?event.timezone:data.systemTimezone??systemTimezone());
      content.append(el('div',{class:'cw-date'},`${dateText(event.start,eventZone)} · ${commonZones[eventZone]??eventZone}`),el('p',{class:'cw-small'},reminderText(event.reminders_minutes)));
      if(event.details??event.notes)content.append(el('p',{class:'cw-notes'},event.details??event.notes));
      if(event.url){try{const url=new URL(event.url);if(url.protocol==='https:'&&!url.username&&!url.password)content.append(el('a',{href:url.href,target:'_blank',rel:'noopener noreferrer',class:'cw-link'},'查看详情 ↗'));}catch{}}
      const actions=el('div',{class:'cw-event-actions'},button('编辑',()=>edit(event),'quiet'),button(event.enabled?'取消日程':'重新启用',()=>changeEnabled(event),event.enabled?'danger-link':'quiet'));
      list.append(el('article',{class:'cw-event','data-event-id':event.id},content,actions));
    }
  }
  async function control(method){
    if(changing)return;changing=true;toggle.disabled=true;refresh.disabled=true;
    try{await ctx.invoke(method);await load();message(method==='show'?'挂件已显示。':method==='hide'?'挂件已隐藏。':'状态已更新。');}
    catch(error){message(error.message??String(error),true);}finally{changing=false;toggle.disabled=false;refresh.disabled=false;}
  }
  async function setReminders(enabled){
    if(changing||!data)return;changing=true;reminderSwitch.disabled=true;
    try{const result=await ctx.invoke('set-qq-reminders',[enabled]);if(!result.ok)throw new Error(result.error??'开关未保存');data=result;render();message(enabled?'QQ 自动提醒已开启。':'QQ 自动提醒已关闭。');}
    catch(error){message(error.message??String(error),true);}finally{changing=false;reminderSwitch.disabled=false;}
  }
  async function load(){
    if(stopped||loading)return;loading=true;refresh.disabled=true;
    try{const next=await ctx.invoke('state');if(stopped)return;data=next;render();}
    catch(error){if(!stopped)message(error.message??String(error),true);}finally{loading=false;refresh.disabled=false;}
  }
  function dialog(title){
    const d=el('dialog',{class:'cw-dialog'}),error=el('div',{class:'cw-form-error',role:'alert'}),form=el('form',{method:'dialog'});
    const close=()=>{ctx.signal?.removeEventListener('abort',close);d.close();d.remove();editorOpen=false;};
    form.append(el('div',{class:'cw-dialog-head'},el('h3',{},title),button('×',close,'quiet')));d.append(form);root.append(d);
    d.addEventListener('cancel',event=>{event.preventDefault();close();});ctx.signal?.addEventListener('abort',close,{once:true});
    return {d,form,error,close};
  }
  function field(form,label,input,hint){
    const heading=el('span',{class:'cw-field-label'},label);
    if(input.tagName!=='SELECT')heading.append(el('small',{class:'cw-field-requirement'+(input.required?' required':'')},input.required?'必填':'选填'));
    const wrapper=el('label',{class:'cw-field'},heading,input);if(hint)wrapper.append(el('small',{class:'cw-muted'},hint));form.append(wrapper);return input;
  }
  function editConnection(){
    if(editorOpen||changing||!data)return;editorOpen=true;
    const {d,form,error,close}=dialog('QQ 提醒接入'),current=data.connection??{};
    const privateQQ=field(form,'私聊接收 QQ',el('input',{name:'privateQQ',inputmode:'numeric',maxLength:16,value:current.privateQQ?String(current.privateQQ):'',placeholder:'可私聊机器人管理日程'}));
    const groupId=field(form,'接收群号',el('input',{name:'groupId',inputmode:'numeric',maxLength:16,value:current.groupId?String(current.groupId):'',placeholder:'接收日程提醒的群号'}));
    const permissions=el('fieldset',{class:'cw-group-permissions'},el('legend',{},'群内添加日程'));form.append(permissions);
    const allowGroupAdd=el('input',{name:'allowGroupAdd',type:'checkbox',checked:current.allowGroupAdd===true});permissions.append(el('label',{class:'cw-check'},allowGroupAdd,'允许在群里用 /日程 添加日程'));
    const roles=el('div',{class:'cw-group-roles'});permissions.append(roles);
    const groupAddByOwner=el('input',{name:'groupAddByOwner',type:'checkbox',checked:current.groupAddByOwner===true}),groupAddByAdmin=el('input',{name:'groupAddByAdmin',type:'checkbox',checked:current.groupAddByAdmin===true}),groupAddByGroupOwner=el('input',{name:'groupAddByGroupOwner',type:'checkbox',checked:current.groupAddByGroupOwner===true});
    for(const [input,label]of [[groupAddByOwner,'主人'],[groupAddByAdmin,'群管理员'],[groupAddByGroupOwner,'群主']])roles.append(el('label',{class:'cw-check'},input,label));
    const masterQQ=field(permissions,'主人 QQ',el('input',{name:'masterQQ',inputmode:'numeric',maxLength:16,value:current.masterQQ?String(current.masterQQ):'',placeholder:'填写主人 QQ 号'}));
    const updatePermissions=()=>{
      roles.hidden=!allowGroupAdd.checked;
      for(const input of [groupAddByOwner,groupAddByAdmin,groupAddByGroupOwner])input.disabled=!allowGroupAdd.checked;
      masterQQ.required=allowGroupAdd.checked&&groupAddByOwner.checked;
      masterQQ.parentElement.hidden=masterQQ.disabled=!masterQQ.required;
      const requirement=masterQQ.parentElement.querySelector('.cw-field-requirement');
      requirement.textContent=masterQQ.required?'必填':'选填';requirement.classList.toggle('required',masterQQ.required);
    };allowGroupAdd.addEventListener('change',updatePermissions);groupAddByOwner.addEventListener('change',updatePermissions);updatePermissions();
    const mode=field(form,'连接方式',el('select',{name:'qqMode'},el('option',{value:'official'},'复用官方 QQ（推荐）'),el('option',{value:'manual'},'手动连接 OneBot')));mode.value=current.mode??'official';
    const officialNote=el('p',{class:'cw-small cw-setup-note'},current.officialAvailable?'已检测到官方 QQ 插件，将直接复用连接。':'未检测到官方 QQ 插件，请先配置官方 QQ 或改用手动连接。');form.append(officialNote);
    const manual=el('div',{class:'cw-manual-connection'});form.append(manual);
    const url=field(manual,'OneBot WebSocket 地址',el('input',{name:'qqUrl',type:'url',required:true,value:current.upstreamUrl??'ws://127.0.0.1:3001',placeholder:'ws://127.0.0.1:3001'}));
    const token=field(manual,'访问令牌',el('input',{name:'qqToken',type:'password',autocomplete:'new-password',maxLength:4096,placeholder:current.tokenSet?'已保存，留空则不修改':'与 OneBot 访问令牌一致'}));
    const noToken=el('input',{name:'qqNoToken',type:'checkbox',checked:current.noToken===true});manual.append(el('label',{class:'cw-check'},noToken,'无需访问令牌'));
    token.addEventListener('input',()=>{if(token.value)noToken.checked=false;});
    const advanced=el('details',{class:'cw-setup-advanced'},el('summary',{},'高级选项'));form.append(advanced);
    const port=field(advanced,'日程转接端口',el('input',{name:'qqRelayPort',type:'number',min:1024,max:65535,value:String(current.relayPort??3002)}),'默认 3002，不能与 OneBot 端口相同。');
    const corePort=field(advanced,'Coopanion 接口端口',el('input',{name:'qqCorePort',type:'number',min:1024,max:65535,value:String(current.corePort??17788)}),'默认 17788。');
    const result=el('p',{class:'cw-setup-result',role:'status','aria-live':'polite'});form.append(result,error);
    const payload=()=>({privateQQ:privateQQ.value,groupId:groupId.value,masterQQ:masterQQ.value,allowGroupAdd:allowGroupAdd.checked,groupAddByOwner:groupAddByOwner.checked,groupAddByAdmin:groupAddByAdmin.checked,groupAddByGroupOwner:groupAddByGroupOwner.checked,mode:mode.value,relayPort:Number(port.value||3002),corePort:Number(corePort.value||17788),...(mode.value==='manual'?{upstreamUrl:url.value,token:token.value,noToken:noToken.checked}:{})});
    const check=button('检测连接',async()=>{
      if(check.disabled)return;check.disabled=true;save.disabled=true;error.textContent='';result.textContent='正在检测连接…';
      try{const response=await ctx.invoke('test-connection',[payload()]);result.textContent=response.message??response.error??'检测完成';result.classList.toggle('is-error',!response.ok);}
      catch(e){result.textContent='检测失败，请重试。';result.classList.add('is-error');}finally{check.disabled=false;save.disabled=false;}
    },'quiet');
    const save=el('button',{type:'submit',class:'cw-button primary'},'保存并连接');
    form.append(el('div',{class:'cw-dialog-footer'},button('取消',close,'quiet'),check,save));
    const updateMode=()=>{manual.hidden=mode.value!=='manual';officialNote.hidden=mode.value!=='official';url.disabled=token.disabled=noToken.disabled=mode.value!=='manual';};mode.addEventListener('change',updateMode);updateMode();
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(save.disabled)return;save.disabled=true;check.disabled=true;error.textContent='';
      try{const response=await ctx.invoke('save-connection',[payload()]);if(!response.ok)throw new Error(response.error??'连接设置未保存');token.value='';close();data=response;render();message(response.connected?'QQ 接入已保存并连接。':response.connection?.error?.message??'已保存，正在连接 QQ…');}
      catch(e){error.textContent=e.message??String(e);}finally{save.disabled=false;check.disabled=false;}
    });d.showModal();privateQQ.focus();
  }
  function edit(event){
    if(editorOpen||changing)return;editorOpen=true;
    const {d,form,error,close}=dialog(event?'编辑日程':'新增日程');
    const system=data.systemTimezone??systemTimezone(),setting=event?.timezoneSetting??event?.timezone??'local';
    const resolved=setting=>setting==='local'?system:new Intl.DateTimeFormat('en',{timeZone:setting}).resolvedOptions().timeZone;
    let editTimezone=resolved(setting);
    const title=field(form,'标题',el('input',{name:'title',required:true,maxLength:180,value:event?.title??'',placeholder:'例如：周末音乐会'}));
    const subtitle=field(form,'副标题',el('input',{name:'subtitle',maxLength:180,value:event?.subtitle??'',placeholder:'显示在标题下方，例如：和朋友一起去'}));
    const remark=field(form,'备注',el('input',{name:'remark',maxLength:180,value:event?.remark??'',placeholder:'显示在挂件顶部，例如：演出 · 线上直播'}));
    const zones=[...new Set([...Object.keys(commonZones),system,setting==='local'?system:setting,...(Intl.supportedValuesOf?.('timeZone')??[])])];
    const timezoneSelect=field(form,'时区',el('select',{name:'timezone','aria-label':'日程时区'},el('option',{value:'local'},`跟随电脑（${system}）`),...zones.map(z=>el('option',{value:z},commonZones[z]?`${commonZones[z]}（${z}）`:z))));timezoneSelect.value=setting;
    const grid=el('div',{class:'cw-form-grid'});form.append(grid);
    const start=field(grid,'开始时间',el('input',{type:'datetime-local',name:'start',required:true,value:event?localInput(event.start,editTimezone):''}),`时区：${editTimezone}`);
    const status=field(grid,'时间状态',el('select',{name:'status'},el('option',{value:'confirmed'},'已确定'),el('option',{value:'tentative'},'预计时间')));status.value=event?.status??'confirmed';
    const occurrence=el('select',{name:'occurrence'},el('option',{value:''},'请选择对应时段'),el('option',{value:'earlier'},'第一次（时钟回拨前）'),el('option',{value:'later'},'第二次（时钟回拨后）'));
    field(form,'夏令时重复时段',occurrence,'这个当地时刻出现两次，选择你要使用的那一次。');occurrence.parentElement.hidden=true;
    start.addEventListener('input',()=>{occurrence.value='';occurrence.parentElement.hidden=true;});
    timezoneSelect.addEventListener('change',()=>{const next=resolved(timezoneSelect.value);if(event&&start.value===localInput(event.start,editTimezone))start.value=localInput(event.start,next);editTimezone=next;start.parentElement.querySelector('small.cw-muted').textContent=`时区：${editTimezone}`;occurrence.value='';occurrence.parentElement.hidden=true;});
    const reminders=el('fieldset',{class:'cw-field cw-reminders'},el('legend',{},'提醒时间'));form.append(reminders);
    const selected=event?.reminders_minutes??[1440,30,0],checks=[];
    for(const [value,label]of [[1440,'提前 1 天'],[30,'提前 30 分钟'],[0,'到点']]){const input=el('input',{type:'checkbox',checked:selected.includes(value),value:String(value)});checks.push(input);reminders.append(el('label',{},input,label));}
    const custom=field(form,'自定义提前量（分钟）',el('input',{name:'reminders',value:selected.filter(x=>![1440,30,0].includes(x)).join(', '),placeholder:'例如：10, 60, 120',inputmode:'numeric'}),'最多 5 个提醒；全不选则仅显示倒计时。');
    const details=field(form,'详情',el('textarea',{name:'details',maxLength:2000,rows:3,value:event?.details??event?.notes??'',placeholder:'提醒时会一并发送'}));
    const url=field(form,'详情链接',el('input',{name:'url',type:'url',value:event?.url??'',placeholder:'https://…'}));
    const enabled=el('input',{type:'checkbox',name:'enabled',checked:event?.enabled??true});form.append(el('label',{class:'cw-check'},enabled,'启用日程'));
    const save=el('button',{type:'submit',class:'cw-button primary'},'保存日程');form.append(error,el('div',{class:'cw-dialog-footer'},button('取消',close,'quiet'),save));
    form.addEventListener('submit',async action=>{
      action.preventDefault();if(save.disabled)return;error.textContent='';save.disabled=true;
      try{
        if(!title.value.trim()||!start.value)throw new Error('请填写标题和开始时间。');
        const minutes=parseReminders(checks.filter(x=>x.checked).map(x=>Number(x.value)),custom.value);
        const unchanged=event&&start.value===localInput(event.start,editTimezone);
        const payload={event:{...(event?{id:event.id}:{}),title:title.value,subtitle:subtitle.value,remark:remark.value,details:details.value,timezone:timezoneSelect.value,...(unchanged?{start:event.start}:{}),status:status.value,reminders_minutes:minutes,url:url.value,enabled:enabled.checked},...(unchanged?{}:{localStart:start.value,timezone:editTimezone,occurrence:occurrence.value||undefined}),expectedRevision:event?.revision};
        const result=await ctx.invoke('save-event',[payload]);if(!result.ok){if(result.code==='ambiguous-time')occurrence.parentElement.hidden=false;throw new Error(result.error);}
        close();await load();message(result.duplicate?'已存在相同日程。':'日程已保存。');
      }catch(e){error.textContent=e.message??String(e);}finally{save.disabled=false;}
    });
    d.showModal();title.focus();
  }
  function changeEnabled(event){
    if(editorOpen||changing)return;
    if(!event.enabled&&Date.parse(event.start)<=Date.now()){edit(event);message('这项日程已过期，请先修改时间。');return;}
    editorOpen=true;const {d,form,error,close}=dialog(event.enabled?'取消这项日程？':'重新启用日程？');
    form.append(el('p',{class:'cw-confirm-title'},event.title),el('p',{class:'cw-muted'},event.enabled?'取消后不再发送提醒，可随时重新启用。':'将按原有设置恢复提醒。'));
    const confirm=button(event.enabled?'确认取消':'确认启用',async()=>{
      confirm.disabled=true;try{const result=await ctx.invoke('set-event-enabled',[{id:event.id,expectedRevision:event.revision,enabled:!event.enabled}]);if(!result.ok)throw new Error(result.error);close();await load();message(event.enabled?'日程已取消。':'日程已重新启用。');}catch(e){error.textContent=e.message??String(e);}finally{confirm.disabled=false;}
    },event.enabled?'danger':'primary');
    form.append(error,el('div',{class:'cw-dialog-footer'},button('返回',close,'quiet'),confirm));d.showModal();
  }
  void load();ctx.interval(()=>{void load();},8000);ctx.own({dispose:()=>{stopped=true;}});
}};
export default {panels:{agenda:panel}};
