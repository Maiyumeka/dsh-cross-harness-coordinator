import fs from 'node:fs';
import readline from 'node:readline';
const mode=process.argv[2],source=process.argv[3],base={threadId:'image-thread',turnId:'image-turn'};let approval=900;
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n'),notify=(method,params)=>emit({method,params}),lines=readline.createInterface({input:process.stdin});
function ask(){emit({id:approval,method:'item/commandExecution/requestApproval',params:{...base,itemId:'copy-'+approval,command:'copy '+source+' to scene1.png',cwd:process.cwd(),reason:'复制本轮生成图片到声明产物'}});}
lines.on('line',line=>{
 const m=JSON.parse(line),reply=result=>emit({id:m.id,result});
 if(m.method==='initialize')reply({userAgent:'image fixture'});else if(m.method==='model/list')reply({data:[]});else if(m.method==='thread/start')reply({thread:{id:base.threadId}});
 else if(m.method==='turn/start'){
  reply({turn:{id:base.turnId}});notify('turn/started',{threadId:base.threadId,turn:{id:base.turnId,status:'inProgress'}});notify('item/started',{...base,item:{id:'image',type:'imageGeneration',status:'inProgress'}});
  if(mode==='malformed'){process.stdout.write('not-json\n');return;}
  if(mode==='hang')return;
  if(mode==='scope-noise')for(const params of [{item:{id:'unscoped-image',type:'imageGeneration',status:'completed',savedPath:source,result:''}},{threadId:'other-thread',turnId:base.turnId,item:{id:'foreign-image',type:'imageGeneration',status:'completed',savedPath:source,result:''}},{threadId:base.threadId,turnId:'other-turn',item:{id:'wrong-turn-image',type:'imageGeneration',status:'completed',savedPath:source,result:''}}])notify('item/completed',params);
  const result=mode==='oversize'?'A'.repeat(17*1024*1024):fs.readFileSync(source).toString('base64');
  const item=mode==='extension'?{id:'image',type:'extension',kind:'image_gen.generation',status:'completed',payload:{result,savedPath:source,failure:null}}:{id:'image',type:'imageGeneration',status:'completed',result,savedPath:source,failure:null};
  if(mode==='fragmented'){const wire=JSON.stringify({method:'item/completed',params:{...base,item}})+'\n';for(let at=0;at<wire.length;at+=65536)process.stdout.write(wire.slice(at,at+65536));}else notify('item/completed',{...base,item});
  if(mode==='exit-after-image'){process.stdout.write('',()=>process.exit(1));return;}ask();
 }else if(m.id===approval&&m.result){
  if(m.result.decision!=='accept'){process.stdout.write('',()=>process.exit(3));return;}
  if(approval<902){approval++;ask();return;}
  fs.copyFileSync(source,'scene1.png');notify('turn/completed',{threadId:base.threadId,turn:{id:base.turnId,status:'completed'}});
 }else if(m.method==='turn/interrupt')reply({});
});
