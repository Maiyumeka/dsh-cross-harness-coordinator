// Diagnostics describe shape and size only, never the supplied prompt or JSON body.
export const valueInfo=value=>({type:value===null?'null':Array.isArray(value)?'array':typeof value,length:typeof value==='string'||Array.isArray(value)?value.length:null,...(typeof value==='string'?{utf8Bytes:Buffer.byteLength(value)}:{})});
const received=value=>{const info=valueInfo(value);return info.type+'（长度='+String(info.length??'不适用')+(info.utf8Bytes!==undefined?'，UTF-8字节='+info.utf8Bytes:'')+'）';};
export function fieldError(field,value,expected,{layer='engine',code='COORDINATOR_INVALID_FIELD',...limits}={}){
 return Object.assign(Error('参数校验失败：字段='+field+'；收到='+received(value)+'；要求='+expected+'；层='+layer),{code,validation:{layer,field,received:valueInfo(value),expected,...limits}});
}
export function validText(value,max,field){
 if(typeof value!=='string'||!value.trim()||value.length>max)throw fieldError(field,value,'非空string，长度≤'+max+'（UTF-16码元）',{maxLength:max});
 return value.trim();
}
export function validKey(value,field='id'){
 if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(value))throw fieldError(field,value,'任务或执行端编号无效：1至80位字母、数字、下划线或短横线',{maxLength:80});
 return value;
}
export function validArray(value,max,field,{min=0}={}){
 if(!Array.isArray(value)||value.length<min||value.length>max)throw fieldError(field,value,'array，项数'+min+'至'+max,{minItems:min,maxItems:max});
 return value;
}
export function validStrings(value,max,field,options){
 validArray(value,max,field,options);
 value.forEach((item,index)=>{if(typeof item!=='string'||item.length>16000)throw fieldError(field+'['+index+']',item,'string，长度≤16000（UTF-16码元）',{maxLength:16000});});
 return value;
}
export function validObject(value,field){
 if(!value||typeof value!=='object'||Array.isArray(value))throw fieldError(field,value,'JSON object');
 return value;
}
export function jsonArgument(value,field,kind,{allowArray=false}={}){
 let parsed=value;
 if(typeof value==='string'){
  try{parsed=JSON.parse(value);}catch{throw fieldError(field,value,'合法JSON'+(kind==='array'?'数组':'对象')+'字符串',{layer:'tool/json',code:'COORDINATOR_INVALID_JSON'});}
 }else if(!(allowArray&&Array.isArray(value)))throw fieldError(field,value,allowArray?'JSON数组字符串或array':'JSON字符串',{layer:'tool/input'});
 if(kind==='array'&&!Array.isArray(parsed)||kind==='object'&&(!parsed||typeof parsed!=='object'||Array.isArray(parsed)))throw fieldError(field,parsed,kind==='array'?'JSON array':'JSON object',{layer:'tool/json'});
 return parsed;
}
export const PLAN_PARAMETERS={
 title:{type:'string',required:true,description:'计划标题，非空，最多200个UTF-16码元；与每项任务title分别必填'},
 tasks:{required:true,oneOf:[{type:'string'},{type:'array',items:{type:'json'}}],description:'任务数组或JSON数组字符串，1至30项。每项必填id、title（非空且≤200）、prompt（非空且≤16000）、endpoint（取coordinator_candidates中已接入的编号）、outputs、criteria、reason（非空且≤2000）。长度按UTF-16码元计算；dependencies可省略，默认[]；model/reasoning可选。任务title不能省略。',examples:[[{id:'task1',title:'任务标题',prompt:'任务要求',endpoint:'h_example',outputs:['result.md'],criteria:['具体验收条件'],reason:'分配依据'}]]}
};
// Keep the real host's error class/code and strict schema; only enrich its diagnostics.
export function explainSchemaError(error,args,tool){
 if(error?.code!=='INVALID_ARGS'||!Array.isArray(error.violations))return error;
 const diagnostics=error.violations.slice(0,8).map(violation=>{
  const field=violation.match(/"([^"]*)"/)?.[1]||'$';let value=args;
  if(field!=='$')for(const part of field.replace(/\[(\d+)\]/g,'.$1').split('.').filter(Boolean))value=value&&typeof value==='object'?value[part]:undefined;
  const limits=tool==='coordinator_plan'&&field==='title'?{maxLength:200}:{};
  const expected=Object.hasOwn(limits,'maxLength')?'非空string，长度≤200（UTF-16码元）':tool==='coordinator_plan'&&field==='tasks'?'JSON数组字符串或array（1至30项，每项必填title）':violation;
  return fieldError(field,value,expected,{layer:'tool/schema',code:error.code,...limits}).validation;
 });
 error.message='invalid arguments：工具='+tool+'；'+diagnostics.map(d=>'字段='+d.field+'，收到='+received(d.field==='$'?args:readField(args,d.field))+'，要求='+d.expected+'，层='+d.layer).join('；');
 error.validation={layer:'tool/schema',tool,fields:diagnostics};return error;
}
function readField(args,field){let value=args;for(const part of field.replace(/\[(\d+)\]/g,'.$1').split('.').filter(Boolean))value=value&&typeof value==='object'?value[part]:undefined;return value;}
