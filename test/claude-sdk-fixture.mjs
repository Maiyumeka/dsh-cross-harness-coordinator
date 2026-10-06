import fs from 'node:fs';
export function query({prompt,options}){
 let closed=false;
 const messages={async *[Symbol.asyncIterator](){for await(const message of prompt){if(closed)return;fs.appendFileSync('sdk-prompts.jsonl',JSON.stringify(message)+'\n');fs.writeFileSync('delivery.md','Claude SDK真实交付');yield {type:'result',subtype:'success',is_error:false,result:'fixture delivered',usage:{input_tokens:1}};return;}},initializationResult:async()=>{const denial=await options.canUseTool();if(denial.behavior!=='deny')throw Error('unexpected permission');return {models:[]};},supportedModels:async()=>[{value:'fixture'}],interrupt:async()=>{closed=true;},close:()=>{closed=true;}};
 return messages;
}
