import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const check=(condition,message)=>{if(!condition)throw Error(message);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(root,file)=>{const rel=path.relative(root,file);return !!rel&&!rel.startsWith('..')&&!path.isAbsolute(rel);};
function noLinks(file,root){let current=file;while(true){if(fs.existsSync(current))check(!fs.lstatSync(current).isSymbolicLink(),'图片回收不接受链接路径');if(path.relative(root,current)==='')return;const parent=path.dirname(current);check(parent!==current,'图片路径不在预期目录');current=parent;}}
export function collectImage({cwd,cacheHome,source,relative,expectedSha256}){
 const workspace=fs.realpathSync(cwd),home=path.resolve(cacheHome),cache=path.join(home,'generated_images');
 check(typeof source==='string'&&path.isAbsolute(source)&&inside(cache,path.resolve(source)),'只允许回收本轮记录的Codex generated_images缓存图片');
 check(fs.existsSync(cache)&&fs.statSync(cache).isDirectory(),'图片缓存目录不存在');noLinks(path.resolve(source),home);
 const realCache=fs.realpathSync(cache),realSource=fs.realpathSync(source);check(inside(realCache,realSource),'图片源路径越界');
 check(typeof relative==='string'&&!relative.includes(':')&&!path.isAbsolute(relative)&&path.extname(relative).toLowerCase()==='.png','图片回收目标须为声明的相对PNG路径');
 const target=path.resolve(workspace,relative);check(inside(workspace,target),'图片回收目标越界');noLinks(target,workspace);
 const fd=fs.openSync(source,'r');let data,width,height;
 try{const before=fs.fstatSync(fd,{bigint:true});check(before.isFile()&&before.size>=24n&&before.size<=16n*1024n*1024n,'图片源须为不超过16MiB的普通PNG文件');
  const header=Buffer.alloc(24);check(fs.readSync(fd,header,0,24,0)===24&&header.subarray(0,8).toString('hex')==='89504e470d0a1a0a'&&header.readUInt32BE(8)===13&&header.subarray(12,16).toString()==='IHDR','图片源PNG头无效');
  width=header.readUInt32BE(16);height=header.readUInt32BE(20);check(width>0&&height>0,'图片尺寸无效');data=fs.readFileSync(fd);
  const after=fs.fstatSync(fd,{bigint:true}),current=fs.statSync(source,{bigint:true});check(['dev','ino','size','mtimeNs','ctimeNs'].every(k=>before[k]===after[k]&&before[k]===current[k])&&BigInt(data.length)===before.size,'图片源在回收时发生变化');
 }finally{fs.closeSync(fd);}
 const sha256=hash(data);if(expectedSha256)check(sha256===expectedSha256,'缓存图片内容与本轮图片事件哈希不一致');let unchanged=false;
 if(fs.existsSync(target)){check(fs.lstatSync(target).isFile()&&!fs.lstatSync(target).isSymbolicLink(),'目标不是普通文件');check(fs.statSync(target).size===data.length&&hash(fs.readFileSync(target))===sha256,'目标已有不同内容，回收不会覆盖；请由原会话先核对');unchanged=true;}
 else{fs.mkdirSync(path.dirname(target),{recursive:true});noLinks(target,workspace);const parent=fs.realpathSync(path.dirname(target));check(path.relative(workspace,parent)===''||inside(workspace,parent),'回收目录链接越界');
  const out=fs.openSync(target,'wx',0o600);let identity;
  try{identity=fs.fstatSync(out);fs.writeFileSync(out,data);}
  catch(error){fs.closeSync(out);const current=fs.lstatSync(target);if(!current.isSymbolicLink()&&current.dev===identity?.dev&&current.ino===identity?.ino)fs.unlinkSync(target);throw error;}
  fs.closeSync(out);
 }
 noLinks(target,workspace);check(inside(workspace,fs.realpathSync(target))&&hash(fs.readFileSync(target))===sha256,'回收后的图片核对失败');
 return {path:relative,source:realSource,size:data.length,sha256,width,height,unchanged,headerVerified:true,eventHashVerified:!!expectedSha256,mediaReviewed:false};
}
