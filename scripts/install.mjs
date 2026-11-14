import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setupRuntime} from '../shared/runtime-setup.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const arg=name=>process.argv.find(x=>x.startsWith('--'+name+'='))?.split('=').slice(1).join('=');
const app=arg('app')??(process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'Programs/Coopanion'):null);
const api=arg('api')??'http://127.0.0.1:17788';
if(!app)throw new Error('需要 --app=Coopanion安装目录');
const url=new URL(api);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.protocol!=='http:')throw new Error('只允许本机 Coopanion API');
setupRuntime(app);
for(const name of ['cortico-world-personal-agenda-local']){
  const destination=path.join(app,'data/local-extensions',name);fs.cpSync(path.join(root,name),destination,{recursive:true});
  const result=await fetch(new URL('/api/extensions/install',url),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:destination}),signal:AbortSignal.timeout(120000)});
  if(!result.ok)throw new Error('扩展安装未完成：'+result.status+'。请在本机插件管理页选择 '+destination);
  console.log('已安装 '+name);
}
console.log('安装完成。请按扩展管理器提示重启核心，并在 World 中启用个人日程。');
console.log('日程和倒计时无需 QQ 即可使用；QQ 提醒从“个人日程 → QQ 接入 → 设置连接”配置，无需手改配置文件。');
console.log('已有日程、密钥与提醒记录不会被此脚本重置。');
