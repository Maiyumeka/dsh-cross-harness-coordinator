import React from 'react';
import {createRoot} from 'react-dom/client';
import './shell.css';
import {VERSION} from '../lib/version.mjs';
let plugin;
window.__ModuleLoader__={load:registration=>{plugin=registration.factory(name=>{if(name==='react')return React;throw Error(name);});}};
await import('../lib/client.js');
const style=document.createElement('style');style.textContent=plugin.css;document.head.appendChild(style);plugin.setSession('preview');
const rpc=async(method,payload)=>{const r=await fetch('/preview-api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,payload})});const result=await r.json();if(!result.ok)throw Error(result.error);return result.value;};
function App(){const [active,setActive]=React.useState('协调器');return <><div className="preview-note">交互预览 · 示例任务与测试产物 · 未连接真实 Harness</div><main className="settings-shell"><aside><h1>设置</h1>{['通用设置','模型','内置插件','Agent 预设','协调器'].map(name=><button className={name===active?'active':''} key={name} onClick={()=>setActive(name)}><span>{name==='协调器'?'◈':'○'}</span>{name}</button>)}<p>设置内整合版 · 插件 {VERSION}</p></aside><section className="settings-content">{active==='协调器'?<plugin.Settings rpc={rpc}/>:<div className="other-setting"><h2>{active}</h2><p>这里由 DSH 原有设置页提供。</p><button onClick={()=>setActive('协调器')}>查看协调器</button></div>}</section></main></>;}
createRoot(document.getElementById('root')).render(<App/>);
