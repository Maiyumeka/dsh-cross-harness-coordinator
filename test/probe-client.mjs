import {createRequire} from 'node:module';
import path from 'node:path';
const require=createRequire(import.meta.url),{chromium}=require('playwright'),browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage();
const events=[];
page.on('pageerror',e=>events.push(e.message));page.on('console',m=>{if(m.type()==='error')events.push(m.text());});
try{await page.goto(process.env.COORDINATOR_TEST_URL,{waitUntil:'networkidle'});if(await page.getByRole('button',{name:'稍后配置',exact:true}).count())await page.getByRole('button',{name:'稍后配置',exact:true}).click();await page.getByRole('button',{name:'设置',exact:true}).click();await page.waitForTimeout(1500);console.log(JSON.stringify({events,boot:await page.evaluate(()=>window.__DSH_BOOT__.entries.filter(e=>e.id.includes('coordinator'))),text:await page.locator('body').innerText()},null,2));await page.screenshot({path:path.resolve('test-data/probe-client.png')});}finally{await browser.close();}
