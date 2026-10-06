import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export function deliver(cwd,outputs,files){
 const base=fs.realpathSync(cwd),seen=new Set(),prepared=[];let total=0;
 for(const f of files){
  if(!f||typeof f!=='object'||typeof f.path!=='string'||Object.keys(f).some(k=>!['path','text','base64'].includes(k))||(typeof f.text==='string')===(typeof f.base64==='string'))throw Error('远端文件交付格式无效');
  if(f.base64!==undefined&&!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.base64))throw Error('远端文件base64无效');
  if(!outputs.includes(f.path)||seen.has(f.path))throw Error('远端交付包含未声明或重复路径');seen.add(f.path);
  const target=path.resolve(base,f.path),relative=path.relative(base,target);if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||f.path.includes(':'))throw Error('交付路径越界');
  let ancestor=target;while(!fs.existsSync(ancestor))ancestor=path.dirname(ancestor);
  const real=fs.realpathSync(ancestor),rel=path.relative(base,real);if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('交付链接越界');
  if(fs.existsSync(target)&&(!fs.lstatSync(target).isFile()||fs.lstatSync(target).isSymbolicLink()))throw Error('交付目标不是普通文件');
  const data=f.base64!==undefined?Buffer.from(f.base64,'base64'):Buffer.from(f.text??'','utf8');total+=data.length;if(data.length>8*1024*1024||total>16*1024*1024)throw Error('远端交付超过限制');prepared.push({target,data});
 }
 if(outputs.some(p=>!seen.has(p)))throw Error('远端未实际交付所有声明产物；已有本地文件不能代替本轮交付');
 for(const {target,data}of prepared){fs.mkdirSync(path.dirname(target),{recursive:true});const temp=target+'.delivery-'+randomUUID();try{fs.writeFileSync(temp,data,{flag:'wx'});fs.renameSync(temp,target);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}
 return [...seen];
}
