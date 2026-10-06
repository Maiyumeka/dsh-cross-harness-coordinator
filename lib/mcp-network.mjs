import readline from 'node:readline';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js';
import {confinedFetch,redact,sanitize} from './network.js';
const e=JSON.parse(process.argv[2]),controller=new AbortController(),baseFetch=confinedFetch(e.server,controller.signal);
const fetchImpl=async(input,init)=>{
 const response=await baseFetch(input,init);
 // Legacy SDK transport throws on HTTP 400 before decoding the modern RPC error.
 // Preserve its actual code/data so the protocol layer cannot silently downgrade.
 if(response.status===400&&init?.method==='POST'){
  let message;try{message=await response.clone().json();}catch{}
  if(message?.jsonrpc==='2.0'&&message.error?.code===-32022)throw Object.assign(Error('现代MCP版本不兼容'),{rpcError:message.error});
 }
 return response;
};
const transport=e.mcp.transport==='sse'?new SSEClientTransport(new URL(e.server.url),{fetch:fetchImpl}):new StreamableHTTPClientTransport(new URL(e.server.url),{fetch:fetchImpl,reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1000,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1}});
const write=m=>process.stdout.write(JSON.stringify(sanitize(m,e.server))+'\n');
transport.onmessage=m=>{if(m.result?.protocolVersion)transport.setProtocolVersion?.(m.result.protocolVersion);write(m);};
transport.onerror=()=>{};
const lines=readline.createInterface({input:process.stdin});
const ready=transport.start();ready.catch(error=>{process.stderr.write(redact(error.message,e.server));process.exit(1);});
// Attach stdin immediately: SSE discovery can take longer than the first request.
lines.on('line',async line=>{let m;try{if(Buffer.byteLength(line)>1024*1024)throw Error('消息过大');m=JSON.parse(line);await ready;if(m.method==='initialize')transport.setProtocolVersion?.(undefined);const version=m.params?._meta?.['io.modelcontextprotocol/protocolVersion'];if(version)transport.setProtocolVersion?.(version);await transport.send(m);}catch(error){if(m?.id!==undefined)write({jsonrpc:'2.0',id:m.id,error:error.rpcError||{code:-32000,message:redact(error.message,e.server)}});}});
lines.on('close',async()=>{controller.abort();await transport.close();});
