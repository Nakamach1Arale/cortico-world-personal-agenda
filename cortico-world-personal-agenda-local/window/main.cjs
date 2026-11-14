const {app,nativeImage}=require('electron');
const {join,resolve}=require('node:path');
const {mkdirSync}=require('node:fs');
const {createInterface}=require('node:readline');
const {createConnection}=require('node:net');
const args=Object.fromEntries(process.argv.filter(x=>x.startsWith('--widget-')).map(x=>{const n=x.indexOf('=');return [x.slice(2,n),x.slice(n+1)];}));
const dataDir=resolve(args['widget-data']||'.'),parent=Number(args['widget-parent']);
if(!parent||!args['widget-data']){app.exit(1);return;}
const kind='countdown';
const profile=join(dataDir,'widget-profiles',kind);mkdirSync(profile,{recursive:true});app.setPath('userData',profile);
app.disableHardwareAcceleration();
let widget,stopping=false;
const channel=createConnection(args['widget-pipe']);channel.on('error',()=>quit());
const emit=value=>{try{channel.write(JSON.stringify(value)+'\n');}catch{}};
const image=nativeImage.createFromPath(join(__dirname,'icon.png'));
function quit(){if(stopping)return;stopping=true;widget?.stop();app.quit();}
const lines=createInterface({input:channel});
lines.on('line',async line=>{
  let req;try{req=JSON.parse(line);}catch{return;}
  try{
    if(!widget)throw new Error('窗口正在启动');
    let result;
    if(req.action==='quit'){emit({id:req.id,result:{ok:true}});setTimeout(quit,30);return;}
    if(req.action==='show')widget.show();else if(req.action==='hide')widget.hide();
    else if(req.action==='refresh'){if(widget.refresh)await widget.refresh();}
    else if(req.action!=='state')throw new Error('未知操作');
    result={visible:widget.isVisible(),running:true,tray:false};emit({id:req.id,result});
  }catch(error){emit({id:req?.id,error:error.message});}
});
lines.on('close',quit);
const parentWatch=setInterval(()=>{try{process.kill(parent,0);}catch{quit();}},2000);parentWatch.unref();
app.on('window-all-closed',()=>{});app.on('before-quit',()=>{if(!stopping){stopping=true;widget?.stop();}});
app.whenReady().then(async()=>{
  const factory=require('./countdown.cjs');
  widget=await factory.createCountdown({dataDir,icon:image});
  widget.start();emit({event:'ready',kind,token:args['widget-session']});
}).catch(error=>{emit({event:'error',error:String(error)});app.exit(1);});
