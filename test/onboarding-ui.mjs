import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'vite';
import {VERSION} from '../lib/version.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright');
const root=path.resolve('test-data','onboarding-ui-'+Date.now());fs.mkdirSync(root,{recursive:true});
const endpoint=(id,label,protocol,state)=>({id,label,version:'fixture-1',protocol,ownerHere:true,connection:{state,...(state==='needs_agent'?{error:'隔离演示：需要修正启动入口'}:{})}});
const data={title:'隔离接入界面验证',paused:false,tasks:[],events:[],endpoints:[endpoint('good','已验证测试端','acp','ready'),endpoint('bad','需处理测试端','acp','needs_agent'),endpoint('old','旧登记测试端','acp','unverified'),endpoint('text','文本测试端','text','not_applicable'),endpoint('mcp-good','MCP已验证测试端','mcp','ready'),endpoint('mcp-old','MCP旧登记测试端','mcp','unverified'),endpoint('mcp-bad','MCP需处理测试端','mcp','needs_agent')],invitation:{state:'needs_agent',error:'隔离演示：需要修正启动入口'}};
let retried=false;
const server=await createServer({root:path.resolve('preview'),server:{host:'127.0.0.1',port:0,fs:{allow:[path.resolve('..')]}},plugins:[{name:'isolated-onboarding-ui',configureServer(vite){vite.middlewares.use('/preview-api',async(req,res)=>{
 let body='';for await(const b of req)body+=b;const {method,payload}=JSON.parse(body);let value;
 if(method==='snapshot')value=data;
 else if(method==='settings')value={version:VERSION,concurrency:2,activeConnections:0};
 else if(method==='prefs')value={sharePolicy:'all'};
 else if(method==='endpoint-connect'){const e=data.endpoints.find(e=>e.id===payload.endpointId);e.connection={state:'ready'};data.invitation={state:'connected',endpoint:e,connection:e.protocol==='mcp'?{state:'ready',protocol:'mcp'}:e.connection};retried=true;value={connected:true};}
 else throw Error('未预期的测试动作 '+method);
 res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,value}));
 });}}]});
let browser;
try{
 await server.listen();const url='http://127.0.0.1:'+server.httpServer.address().port;
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(5000);
 await page.goto(url,{waitUntil:'networkidle'});
 await page.getByText('当前运行版本 '+VERSION,{exact:true}).waitFor();
 await page.getByText('ACP 连接可用',{exact:true}).first().waitFor();await page.getByText('MCP 连接可用',{exact:true}).first().waitFor();assert.equal(await page.getByText('MCP 待验证',{exact:true}).count()>0,true);
 assert.equal(await page.getByText('需要 Agent 处理',{exact:true}).count()>0,true);
 assert.equal(await page.getByText('ACP 待验证',{exact:true}).count()>0,true);
 assert.equal(await page.getByText('text 已登记',{exact:true}).count()>0,true);
 assert.equal(await page.getByText('插件未完成协议连接，需要 Agent 处理：隔离演示：需要修正启动入口',{exact:true}).isVisible(),true);
 await page.locator('.settings-content').evaluate(e=>e.scrollTop=0);await page.screenshot({path:path.join(root,'failure-desktop.png'),fullPage:true});
 const card=page.locator('.file').filter({has:page.getByText('需处理测试端',{exact:true})});await card.getByRole('button',{name:'检查连接',exact:true}).click();assert.equal(retried,true);await page.locator('.endpoints .ep').filter({has:page.getByText('需处理测试端',{exact:true})}).getByText('ACP 连接可用',{exact:true}).waitFor();if((await page.locator('details.connection').getAttribute('open'))===null)await page.getByText('接入与运行设置',{exact:true}).click();
 const mcpCard=page.locator('.file').filter({has:page.getByText('MCP需处理测试端',{exact:true})});await mcpCard.getByRole('button',{name:'检查连接',exact:true}).click();await page.locator('.endpoints .ep').filter({has:page.getByText('MCP需处理测试端',{exact:true})}).getByText('MCP 连接可用',{exact:true}).waitFor();if((await page.locator('details.connection').getAttribute('open'))===null)await page.getByText('接入与运行设置',{exact:true}).click();await page.getByText('MCP 握手、工具发现和任务映射已通过。',{exact:false}).waitFor();
 await page.locator('.settings-content').evaluate(e=>e.scrollTop=0);await page.screenshot({path:path.join(root,'desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.locator('.settings-content').evaluate(e=>e.scrollTop=0);assert.equal(await page.evaluate(()=>document.body.scrollWidth<=innerWidth),true);
 assert.equal(await page.locator('.chc').evaluate(e=>e.scrollWidth<=e.clientWidth),true);await page.screenshot({path:path.join(root,'mobile.png'),fullPage:true});
 assert.deepEqual(errors,[]);const result={passed:true,version:VERSION,coverage:['ACP/MCP连接通过/失败/旧登记/text独立状态','Agent失败提示','已有端连接检查按钮','桌面和窄屏布局'],root};fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser?.close();await server.close();}
