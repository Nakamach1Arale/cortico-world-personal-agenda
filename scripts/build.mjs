import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createIcon} from '../shared/create-icon.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
for(const name of ['cortico-world-personal-agenda-local']){
  const dir=path.join(root,name);
  for(const [source,target]of [['desktop-window.mjs','src/desktop-window.mjs'],['window-main.cjs','window/main.cjs'],['webui.js','dist/webui.js'],['webui.css','dist/webui.css']])fs.copyFileSync(path.join(root,'shared',source),path.join(dir,target));
  for(const doc of ['CHANGELOG.md','LICENSE'])if(fs.existsSync(path.join(root,doc)))fs.copyFileSync(path.join(root,doc),path.join(dir,doc));
  createIcon(path.join(dir,'window/icon.png'));
  const def=(await import(pathToFileURL(path.join(dir,'src/index.mjs')).href)).default;
  const world=def.create({cfg:def.defaults(),dataDir:path.join(dir,'.tmp-data'),botDir:dir,repoRoot:dir});
  const docs=(world.webUi?.('zh')?.promptDocs??[]).filter(d=>d.role==='envPrompt'&&fs.existsSync(d.path));
  const prompts=docs.map(d=>({key:d.key,title:d.title,...(d.role?{role:d.role}:{}),content:fs.readFileSync(d.path,'utf8')}));
  const describe={tools:[...(def.describe?.tools??[])],events:[...(def.describe?.events??[])],...(prompts.length?{prompts}:{})};
  fs.writeFileSync(path.join(dir,'describe.json'),JSON.stringify(describe,null,2)+'\n');
}
console.log('Built the personal agenda package.');
