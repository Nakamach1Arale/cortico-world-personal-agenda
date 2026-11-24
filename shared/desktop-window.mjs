import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readdirSync,copyFileSync,cpSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';

function findCoopanionAppDir(botDir,repoRoot){
  if(process.platform!=='win32')return null;
  const candidates=[resolve(botDir,'../../..'),repoRoot?resolve(repoRoot,'../../../..'):null,process.env.LOCALAPPDATA?join(process.env.LOCALAPPDATA,'Programs/Coopanion'):null].filter(Boolean);
  return candidates.find(dir=>existsSync(join(dir,'Coopanion.exe')))??null;
}

function requiredRuntimeFiles(app){
  return readdirSync(app).filter(f=>f==='Coopanion.exe'||/\.(dll|pak|bin)$/.test(f)||['icudtl.dat','vk_swiftshader_icd.json','LICENSE.electron.txt','LICENSES.chromium.html'].includes(f));
}

export function inspectWidgetRuntime(botDir,repoRoot){
  const runtimeDir=resolve(botDir,'../../runtime/desktop-widgets');
  const executable=join(runtimeDir,'electron.exe');
  const installed=existsSync(executable);
  const sourceDir=installed?null:findCoopanionAppDir(botDir,repoRoot);
  let fileCount=0;
  let hasLocales=false;
  if(sourceDir){
    try{
      fileCount=requiredRuntimeFiles(sourceDir).length;
      hasLocales=existsSync(join(sourceDir,'locales'));
    }catch{}
  }
  return {
    installed,
    canInstall:!installed&&!!sourceDir,
    sourceDir,
    runtimeDir,
    executable,
    fileCount,
    hasLocales,
    filesSummary:['Coopanion.exe（重命名为 electron.exe）','运行所需 .dll / .pak / .bin 文件','icudtl.dat 与 vk_swiftshader_icd.json','locales/ 语言资源目录','resources/app/ 独立窗口启动脚本'],
  };
}

export function installWidgetRuntime(botDir,repoRoot){
  const info=inspectWidgetRuntime(botDir,repoRoot);
  if(info.installed)return info.executable;
  if(!info.sourceDir)throw new Error('未在本机找到 Coopanion.exe，无法初始化桌面倒计时运行环境。');
  mkdirSync(join(info.runtimeDir,'resources/app'),{recursive:true});
  const required=requiredRuntimeFiles(info.sourceDir);
  for(const name of required){
    const dest=join(info.runtimeDir,name==='Coopanion.exe'?'electron.exe':name);
    if(!existsSync(dest))copyFileSync(join(info.sourceDir,name),dest);
  }
  if(!existsSync(join(info.runtimeDir,'locales'))&&existsSync(join(info.sourceDir,'locales'))){
    cpSync(join(info.sourceDir,'locales'),join(info.runtimeDir,'locales'),{recursive:true});
  }
  writeFileSync(join(info.runtimeDir,'resources/app/package.json'),JSON.stringify({name:'coopanion-widget-runtime',version:'0.1.0',main:'bootstrap.cjs'}));
  writeFileSync(join(info.runtimeDir,'resources/app/bootstrap.cjs'),`const {isAbsolute}=require('node:path');const entry=process.argv.find(a=>a.startsWith('--widget-entry='))?.slice(15);if(!entry||!isAbsolute(entry)||!entry.endsWith('main.cjs'))throw new Error('Invalid widget entry');require(entry);\n`);
  return info.executable;
}

export class DesktopWindow {
  constructor({entry, dataDir, botDir, repoRoot, log}) {
    this.entry=entry;this.dataDir=dataDir;this.log=log;this.botDir=botDir;this.repoRoot=repoRoot;
    this.executable=resolve(botDir,'../../runtime/desktop-widgets/electron.exe');
    this.child=null;this.running=false;this.error=null;this.pending=new Map();this.sequence=0;this.stopped=true;this.stderr='';this.socket=null;this.server=null;
  }
  runtimeInfo(){return inspectWidgetRuntime(this.botDir,this.repoRoot);}
  status(){
    const runtime=this.runtimeInfo();
    return {running:this.running,pid:this.child?.pid??null,error:this.error,runtime};
  }
  async installRuntime(){
    installWidgetRuntime(this.botDir,this.repoRoot);
    this.error=null;
    await this.start();
  }
  async start(){
    if(this.child)return;
    // Never silently copy Coopanion's Electron runtime; require explicit user confirmation via installRuntime().
    if(!existsSync(this.executable)){this.error='桌面倒计时运行环境未就绪，请先在插件页面确认启用';return;}
    this.stopped=false;this.error=null;
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;delete env.NODE_CHANNEL_FD;
    let resolveReady;const ready=new Promise(r=>{resolveReady=r;});
    const timeout=setTimeout(()=>{this.error='桌面组件启动超时';resolveReady();},15000);
    const token=randomUUID(),pipe='\\\\.\\pipe\\coopanion-widget-'+randomUUID();
    const server=createServer(socket=>{
      if(this.socket){socket.destroy();return;}
      let authenticated=false;const lines=createInterface({input:socket});
      lines.on('line',line=>{
      let msg;try{msg=JSON.parse(line);}catch{return;}
      if(!authenticated){if(msg.event!=='ready'||msg.token!==token){socket.destroy();return;}authenticated=true;this.socket=socket;this.running=true;clearTimeout(timeout);resolveReady();return;}
      if(msg.id&&this.pending.has(msg.id)){const job=this.pending.get(msg.id);this.pending.delete(msg.id);clearTimeout(job.timer);msg.error?job.reject(new Error(msg.error)):job.resolve(msg.result);}
      });
      socket.on('error',()=>{});socket.on('close',()=>{if(this.socket===socket)this.socket=null;lines.close();});
    });
    this.server=server;await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(pipe,resolve);});
    const child=spawn(this.executable,[`--widget-entry=${this.entry}`,`--widget-data=${this.dataDir}`,`--widget-parent=${process.pid}`,`--widget-pipe=${pipe}`,`--widget-session=${token}`],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    this.child=child;child.stdout.on('data',()=>{});
    child.stderr.on('data',chunk=>{this.stderr=(this.stderr+chunk.toString()).slice(-3000);});
    child.once('error',()=>{this.error='桌面组件未能启动';clearTimeout(timeout);resolveReady();});
    child.once('exit',()=>{
      if(this.child===child)this.child=null;
      this.running=false;this.socket?.destroy();this.socket=null;server.close();this.server=null;clearTimeout(timeout);resolveReady();
      for(const job of this.pending.values()){clearTimeout(job.timer);job.reject(new Error('桌面组件已停止'));}this.pending.clear();
      if(!this.stopped){this.error='桌面组件已退出，可在插件页面重新打开';this.log.warn(this.error);}
    });
    await ready;
  }
  async command(action){
    if(!['show','hide','state','refresh','quit'].includes(action))throw new Error('未知窗口操作');
    if(!this.child&&action==='show')await this.start();
    if(!this.socket?.writable)throw new Error(this.error??'桌面组件未运行');
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('桌面组件暂未响应'));},7000);
      this.pending.set(id,{resolve,reject,timer});this.socket.write(JSON.stringify({id,action})+'\n');
    });
  }
  async stop(){
    this.stopped=true;const child=this.child;if(!child)return;
    await this.command('quit').catch(()=>{});
    if(child.exitCode!==null)return;
    await new Promise(resolve=>{const timeout=setTimeout(()=>{child.kill();resolve();},3000);child.once('exit',()=>{clearTimeout(timeout);resolve();});});
  }
}
