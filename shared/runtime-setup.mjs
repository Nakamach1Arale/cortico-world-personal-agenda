import fs from 'node:fs';
import path from 'node:path';
export function setupRuntime(app){
  if(process.platform!=='win32')throw new Error('桌面挂件运行环境目前只支持 Windows。');
  if(!fs.existsSync(path.join(app,'Coopanion.exe')))throw new Error('请指定 Coopanion 安装目录。');
  const runtime=path.join(app,'data/runtime/desktop-widgets');fs.mkdirSync(path.join(runtime,'resources/app'),{recursive:true});
  const required=fs.readdirSync(app).filter(f=>f==='Coopanion.exe'||/\.(dll|pak|bin)$/.test(f)||['icudtl.dat','vk_swiftshader_icd.json','LICENSE.electron.txt','LICENSES.chromium.html'].includes(f));
  for(const name of required){const destination=path.join(runtime,name==='Coopanion.exe'?'electron.exe':name);if(!fs.existsSync(destination))fs.copyFileSync(path.join(app,name),destination);}
  if(!fs.existsSync(path.join(runtime,'locales')))fs.cpSync(path.join(app,'locales'),path.join(runtime,'locales'),{recursive:true});
  fs.writeFileSync(path.join(runtime,'resources/app/package.json'),JSON.stringify({name:'coopanion-widget-runtime',version:'0.1.0',main:'bootstrap.cjs'}));
  fs.writeFileSync(path.join(runtime,'resources/app/bootstrap.cjs'),`const {isAbsolute}=require('node:path');const entry=process.argv.find(a=>a.startsWith('--widget-entry='))?.slice(15);if(!entry||!isAbsolute(entry)||!entry.endsWith('main.cjs'))throw new Error('Invalid widget entry');require(entry);\n`);
  return runtime;
}
