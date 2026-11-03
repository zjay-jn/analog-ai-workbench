// The sole reviewed native custom-tool module. Zero imports, no ambient file access.
const unavailable=()=>{throw new Error('Pilot tool unavailable');};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
export default {
  description:'Return a deterministic bounded integer sum through the Workbench host.',
  args:{values:{type:'array',minItems:1,maxItems:32,items:{type:'integer',minimum:-1000000,maximum:1000000}}},
  async execute(args,ctx){
    if(!exact(args,['values'])||!Array.isArray(args.values)||args.values.length<1||args.values.length>32||args.values.some(n=>!Number.isSafeInteger(n)||Object.is(n,-0)||Math.abs(n)>1000000))return unavailable();
    if(!ctx||!id(ctx.sessionID)||!id(ctx.messageID)||!id(ctx.callID)||!ctx.abort||ctx.abort.aborted)return unavailable();
    const port=process.env.AAW_PILOT_TOOL_PORT,token=process.env.AAW_PILOT_TOOL_TOKEN;
    if(!port||!/^\d{4,5}$/u.test(port)||Number(port)<1024||Number(port)>65535||!token||!/^[0-9a-f]{64}$/u.test(token))return unavailable();
    const controller=new AbortController(),abort=()=>controller.abort();ctx.abort.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,10000);
    try{
      const response=await fetch(`http://127.0.0.1:${port}/tool`,{method:'POST',redirect:'error',signal:controller.signal,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({sessionID:ctx.sessionID,messageID:ctx.messageID,callID:ctx.callID,toolName:'pilot_sum',arguments:args})});
      if(response.status!==200||response.redirected||response.headers.get('content-type')?.split(';')[0]!=='application/json'||!response.body)return unavailable();
      const reader=response.body.getReader();let bytes=0,text='';const decoder=new TextDecoder('utf-8',{fatal:true});
      try{for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;if(bytes>1024)return unavailable();text+=decoder.decode(chunk.value,{stream:true});}text+=decoder.decode();}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      const result=JSON.parse(text);
      if(controller.signal.aborted||!exact(result,['sum','count','source','toolVersion'])||result.sum!==args.values.reduce((a,b)=>a+b,0)||result.count!==args.values.length||result.source!=='deterministic-local'||result.toolVersion!=='pilot.sum.v1')return unavailable();
      return JSON.stringify(result);
    }catch{return unavailable();}finally{clearTimeout(timer);ctx.abort.removeEventListener('abort',abort);controller.abort();}
  },
};
