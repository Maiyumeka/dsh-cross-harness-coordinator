import fs from 'node:fs';
import path from 'node:path';
import {createServer} from 'vite';
const root=path.resolve('preview'),source=JSON.parse(fs.readFileSync('test-data/native-home/coordinator/state.json'));const demo=JSON.parse(JSON.stringify(Object.values(source.sessions).find(s=>s.tasks.length)));
demo.id='preview';demo.title='示例 · 需求整理与文案整合';demo.paused=false;demo.tasks.forEach(t=>{if(t.status==='paused'&&t.result){t.status='awaiting_review';t.error='等待当前 Agent 检查真实产物';}});
demo.endpoints=Object.values(source.endpoints).map(e=>({...e,fingerprints:undefined}));demo.invitation={state:'none'};let concurrency=2;
const server=await createServer({root,server:{host:'127.0.0.1',port:19427,strictPort:true,fs:{allow:[path.resolve('..')]}},plugins:[{name:'coordinator-preview-fixtures',configureServer(vite){vite.middlewares.use('/preview-api',async(req,res)=>{try{let body='';for await(const b of req){body+=b;if(body.length>32000)throw Error('请求过大');}const {method,payload}=JSON.parse(body);let value;
if(method==='snapshot')value=demo;else if(method==='settings')value={concurrency};else if(method==='settings-save'){if(!Number.isInteger(payload.concurrency)||payload.concurrency<1||payload.concurrency>4)throw Error('并发须为1至4');concurrency=payload.concurrency;value={concurrency};}
else if(method==='control'){if(payload.action==='cancel'){demo.paused=true;demo.tasks.filter(t=>t.status!=='passed').forEach(t=>t.status='cancelled');}else{demo.paused=payload.action==='pause';demo.tasks.filter(t=>t.status!=='passed').forEach(t=>t.status=demo.paused?'paused':'awaiting_review');}value=demo;}
else if(method==='artifact'){const t=demo.tasks.find(t=>t.id===payload.id);if(!t?.outputs.includes(payload.relative))throw Error('无效产物');value={relative:payload.relative,text:fs.readFileSync(path.join(demo.cwd,payload.relative),'utf8')};}
else if(method==='invite'){demo.invitation={state:'waiting',prompt:'请把你当前实际使用的 Harness 接入 DSH 协调器。由你核实版本、调用入口，并自动回传有效资料，接入成功后告诉我；无需我填写参数或回来确认。无入口时说明原因，不假报成功。（本段为界面演示，没有真实接入令牌，请勿执行接入。）'};value=demo.invitation;}
else if(method==='reject'){demo.invitation={state:'none'};value=demo.invitation;}
else throw Error('预览使用测试数据；真实接入请在安装后的 DSH 中操作。');res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,value}));
}catch(e){res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:false,error:e.message}));}});}}]});await server.listen();console.log('协调器设置版交互预览 http://127.0.0.1:19427');
