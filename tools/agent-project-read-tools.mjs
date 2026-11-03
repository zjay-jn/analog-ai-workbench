// Native transport only. Main owns source paths, project authority, validation and persistence.
const unavailable=()=>{throw new Error('Project tool unavailable');};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(value);
const nullableId={anyOf:[{type:'string',minLength:1,maxLength:256},{type:'null'}]};
const cursorArgs={directoryId:nullableId,cursor:nullableId,refresh:{type:'boolean'}};
const position={type:'object',properties:{line:{type:'integer',minimum:1,maximum:500000},column:{type:'integer',minimum:1,maximum:16777217}},required:['line','column'],additionalProperties:false};
const workFile={fileId:{type:'string',minLength:1,maxLength:256},version:{type:'string',pattern:'^[0-9a-f]{64}$'}};
const workTarget={relativePath:{type:'string',minLength:1,maxLength:240},expectedVersion:{anyOf:[{type:'string',pattern:'^[0-9a-f]{64}$'},{type:'null'}]}};
const waveId={type:'string',minLength:1,maxLength:128},waveHash={type:'string',minLength:64,maxLength:64};
const waveNullable={anyOf:[waveId,{type:'null'}]},waveVoltage={type:'object',properties:{positiveTraceId:waveId,negativeTraceId:waveNullable},required:['positiveTraceId','negativeTraceId'],additionalProperties:false};
const oaBound={designHandle:workFile.fileId,savedRevision:{type:'string',pattern:'^sha256:[0-9a-f]{64}$'}};
const oaSelector={anyOf:[{type:'object',properties:{kind:{type:'string',const:'all'}},required:['kind'],additionalProperties:false},{type:'object',properties:{kind:{type:'string',const:'id'},objectId:workFile.fileId},required:['kind','objectId'],additionalProperties:false},{type:'object',properties:{kind:{type:'string',const:'exact_name'},name:{type:'string',minLength:1,maxLength:4096}},required:['kind','name'],additionalProperties:false}]};
const oaCursor={anyOf:[{type:'string',minLength:1,maxLength:1024},{type:'null'}]};
const schemas={
  oa_open_design:{designId:{type:'string',enum:['folded-cascode-copy']},refresh:{type:'boolean'}},
  oa_inspect_design:oaBound,
  oa_query_instances:{...oaBound,selector:oaSelector,cursor:oaCursor},
  oa_query_nets:{...oaBound,selector:oaSelector,section:{type:'string',enum:['summary','members']},cursor:oaCursor},
  oa_describe_device:{...oaBound,instanceId:workFile.fileId,section:{type:'string',enum:['parameters','terminals']},cursor:oaCursor},
  fs_list:{path:{anyOf:[{type:'string',minLength:1,maxLength:8192},{type:'null'}]},...cursorArgs},
  fs_find:{path:{anyOf:[{type:'string',minLength:1,maxLength:8192},{type:'null'}]},...cursorArgs,query:{type:'string',minLength:1,maxLength:256}},
  fs_search:{path:{anyOf:[{type:'string',minLength:1,maxLength:8192},{type:'null'}]},...cursorArgs,fileId:nullableId,query:{type:'string',minLength:1,maxLength:256}},
  fs_read:{path:{anyOf:[{type:'string',minLength:1,maxLength:8192},{type:'null'}]},fileId:nullableId,version:{anyOf:[workFile.version,{type:'null'}]},start:position,cursor:nullableId},
  wsl_results_list:{bindingId:workFile.fileId,relativeDirectory:{type:'string',maxLength:1024},nameQuery:{type:'string',maxLength:128},cursor:nullableId},
  wsl_results_read:{bindingId:workFile.fileId,fileId:workFile.fileId,version:{type:'string',minLength:1,maxLength:256},startLine:{type:'integer',minimum:1,maximum:500000},maxLines:{type:'integer',minimum:1,maximum:200}},
  wsl_waveform_list:{bindingId:waveId,relativePath:{type:'string',minLength:1,maxLength:1024},analysis:{type:'string',const:'ac'},nameQuery:{type:'string',maxLength:128},cursor:waveNullable},
  wsl_waveform_read:{bindingId:waveId,traceId:waveId,sourceVersion:waveHash,startPoint:{type:'integer',minimum:0,maximum:16383},maxPoints:{type:'integer',minimum:1,maximum:128}},
  wsl_waveform_metrics:{bindingId:waveId,sourceVersion:waveHash,numerator:waveVoltage,denominator:waveVoltage},
  skill_discover:cursorArgs,
  skill_load:{skillId:workFile.fileId,discoveryVersion:workFile.version,version:{anyOf:[workFile.version,{type:'null'}]},start:position,cursor:nullableId},
  skill_read_reference:{skillId:workFile.fileId,skillVersion:workFile.version,fileId:workFile.fileId,version:{anyOf:[workFile.version,{type:'null'}]},start:position,cursor:nullableId},
  project_list:cursorArgs,
  project_find:{...cursorArgs,query:{type:'string',minLength:1,maxLength:256}},
  project_search:{...cursorArgs,query:{type:'string',minLength:1,maxLength:256}},
  project_read:{fileId:{type:'string',minLength:1,maxLength:256},version:{anyOf:[{type:'string',pattern:'^[0-9a-f]{64}$'},{type:'null'}]},start:position,cursor:nullableId},
  pilot_sum:{values:{type:'array',minItems:1,maxItems:32,items:{type:'integer',minimum:-1000000,maximum:1000000}}},
  work_list:{},work_read:{...workFile,offset:{type:'integer',minimum:0,maximum:65536}},
  work_write:{...workTarget,text:{type:'string',maxLength:8192}},
  work_edit:{fileId:workFile.fileId,expectedVersion:workFile.version,oldText:{type:'string',minLength:1,maxLength:8192},newText:{type:'string',maxLength:8192}},
  work_import:{...workFile,...workTarget},work_run:workFile,
  command_environment:{},
  command_start:{requestId:workFile.fileId,environmentId:workFile.fileId,environmentRevision:workFile.version,workspaceId:workFile.fileId,baselineVersion:workFile.version,cwdRelativePath:{type:'string',maxLength:240},commandText:{type:'string',minLength:1,maxLength:8192},timeoutMs:{type:'integer',minimum:1,maximum:600000}},
  command_status:{executionId:workFile.fileId,afterRevision:{anyOf:[{type:'integer',minimum:1},{type:'null'}]},waitMs:{type:'integer',minimum:0,maximum:25000}},
  command_log:{executionId:workFile.fileId,stream:{type:'string',enum:['stdout','stderr']},offset:{type:'integer',minimum:0,maximum:16777216},maxBytes:{type:'integer',minimum:1,maximum:16384},expectedPrefixVersion:{anyOf:[workFile.version,{type:'null'}]}},
  command_stop:{executionId:workFile.fileId},
};
const descriptions={project_list:'List one bounded directory page using main-issued IDs.',project_find:'Find names recursively by literal case-insensitive substring.',project_search:'Search ordinary text for a literal case-sensitive single-line string.',project_read:'Read a bounded verified text fragment; continue with the exact issued cursor, version and next position.',pilot_sum:'Sum bounded integers using the deterministic local calculator.'};
Object.assign(descriptions,{oa_open_design:'Open the registered folded-cascode-copy saved OA copy on request; returns exact handle/version. No live GUI, writes or simulation.',oa_inspect_design:'Inspect saved snapshot counts and coverage.',oa_query_instances:'Query saved devices by exact name or ID; preserve snapshot and cursor.',oa_query_nets:'Query saved nets or one net membership; cite the issued evidenceId.',oa_describe_device:'Read stored parameters or terminals of an issued instance ID. Unknown CDF and roles stay unknown.'});
Object.assign(descriptions,{fs_list:'List ordinary Windows directory children by explicit path or issued directoryId. Absolute paths need no project binding. Follow exact nextArguments.',fs_find:'Find names under an explicit ordinary Windows directory; preserve source and exact nextArguments.',fs_search:'Search a Windows directory or only one file for a case-sensitive literal. At most one path/directoryId/fileId. Continue exact nextArguments without widening a file search.',fs_read:'Read ordinary Windows text directly by explicit file path or issued fileId, without a folder picker. Preserve version/start/cursor from nextArguments, scoped rules and actual source; native read only.'});
Object.assign(descriptions,{command_environment:'Inspect registered Windows/WSL environments, actual access semantics and confirmed workspace baseline.',command_start:'Start one version-bound asynchronous command in the selected shell; WSL copies work files into its Linux cwd and returns verified outputs. Inspect status/logs/outputs before final.',command_status:'Wait up to 25 seconds for a changed execution revision; avoid busy polling.',command_log:'Read raw-byte logs using a fixed prefix version. Null nextCursor ends only that snapshot.',command_stop:'Request stop of one execution; actual exit, tracked descendants empty and cleanup are separate observations.'});
Object.assign(descriptions,{skill_discover:'Discover bounded skill name/description metadata in the selected project.',skill_load:'Load a discovered versioned skill entry through all body pages before using skill references.',skill_read_reference:'Read a versioned ordinary text resource within a fully loaded skill directory. Loading is not execution.'});
Object.assign(descriptions,{wsl_results_list:'List the explicit frozen experimental WSL results directory. Read only; no simulation.',wsl_results_read:'Read a precisely versioned existing WSL result using the issued file ID. Preserve source, range and citation.'});
Object.assign(descriptions,{wsl_waveform_list:'List supported historical AC signals from an exact already-listed binary result. Preserve binding, sourceVersion and issued trace IDs.',wsl_waveform_read:'Read a zero-based page of original complex AC samples with source hash, units and citation. A page is not a whole sweep.',wsl_waveform_metrics:'Compute deterministic AC V/V metrics using explicit numerator and denominator positive-minus-negative issued traces on the same complete Hz axis. Null negative is ground. AC screening is not STB or stability proof.'});
Object.assign(descriptions,{work_list:'List task work files.',work_read:'Read a verified task work file.',work_write:'Create or update a task work file with a required version check.',work_edit:'Replace one unique exact text fragment in a precise task file version; old/new UTF-8 text totals at most 8192 bytes.',work_import:'Copy verified project input to the task workspace.',work_run:'Run a precise task script in the main-owned restricted runtime.'});
// All wrappers import this one module. Waiting must not spend a different call's transport deadline.
const pending=[],failedSessions=new Set();let sending=false;
function drain(){
  if(sending)return;
  while(pending.length){
    const job=pending.shift();job.signal.removeEventListener('abort',job.cancel);
    if(job.signal.aborted||failedSessions.has(job.sessionID)||failedSessions.size>=32){job.reject(new Error('Project tool unavailable'));continue;}
    sending=true;
    let work;try{work=job.run();}catch{work=Promise.reject(new Error('Project tool unavailable'));}
    Promise.resolve(work).then(value=>{sending=false;job.resolve(value);drain();},()=>{
      // A failed transport has no confirmed result. Do not let already queued native calls revive that session.
      failedSessions.add(job.sessionID);
      for(let i=pending.length-1;i>=0;i--)if(pending[i].sessionID===job.sessionID){const removed=pending.splice(i,1)[0];removed.signal.removeEventListener('abort',removed.cancel);removed.reject(new Error('Project tool unavailable'));}
      sending=false;job.reject(new Error('Project tool unavailable'));drain();
    });return;
  }
}
function transport(sessionID,signal,run){
  // Main allows 64 tool calls and the owning runtime is rebuilt after 32 sessions.
  if(signal.aborted||failedSessions.has(sessionID)||failedSessions.size>=32||pending.length+(sending?1:0)>=64)return Promise.reject(new Error('Project tool unavailable'));
  return new Promise((resolve,reject)=>{
    const job={sessionID,signal,run,resolve,reject,cancel:null};
    job.cancel=()=>{const index=pending.indexOf(job);if(index<0)return;pending.splice(index,1);signal.removeEventListener('abort',job.cancel);reject(new Error('Project tool unavailable'));};
    pending.push(job);signal.addEventListener('abort',job.cancel,{once:true});if(signal.aborted)job.cancel();drain();
  });
}
export function createProjectReadNativeTool(name){
  if(!Object.hasOwn(schemas,name))return unavailable();
  return {
    description:descriptions[name],args:schemas[name],
    async execute(args,ctx){
      if(!exact(args,Object.keys(schemas[name]))||!ctx||!id(ctx.sessionID)||!id(ctx.messageID)||!id(ctx.callID)||!ctx.abort||ctx.abort.aborted)return unavailable();
      const body=JSON.stringify({sessionID:ctx.sessionID,messageID:ctx.messageID,callID:ctx.callID,toolName:name,arguments:args});
      if(new TextEncoder().encode(body).length>16384)return unavailable();
      const port=process.env.AAW_PILOT_TOOL_PORT,token=process.env.AAW_PILOT_TOOL_TOKEN;
      if(!port||!/^\d{4,5}$/u.test(port)||Number(port)<1024||Number(port)>65535||!token||!/^[0-9a-f]{64}$/u.test(token))return unavailable();
      const signal=ctx.abort;
      return transport(ctx.sessionID,signal,async()=>{
      if(signal.aborted)return unavailable();
      const controller=new AbortController(),abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,name==='oa_open_design'?135000:name==='work_run'||name==='command_status'?30000:name.startsWith('wsl_waveform_')?17000:12000);
      try{
        const response=await fetch(`http://127.0.0.1:${port}/tool`,{method:'POST',redirect:'error',signal:controller.signal,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body});
        if(response.status!==200||response.redirected||response.headers.get('content-type')?.split(';')[0]!=='application/json'||!response.body)return unavailable();
        const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let text='',bytes=0;
        const cancel=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancel,{once:true});
        try{for(;;){const chunk=await reader.read();if(controller.signal.aborted)return unavailable();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>(/^(?:work_|command_)/u.test(name)?24576:12288))return unavailable();text+=decoder.decode(chunk.value,{stream:true});}text+=decoder.decode();}
        finally{controller.signal.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});reader.releaseLock();}
        const result=JSON.parse(text);
        const expectedKind=name.startsWith('oa_')?'oa_read':name==='pilot_sum'?'sum':name==='skill_discover'?'skills':name==='skill_load'||name==='skill_read_reference'?'read':/^(?:work_|command_|wsl_results_|wsl_waveform_)/u.test(name)?name:name.startsWith('fs_')?name.slice(3):name.slice(8);
        const validError=result?.error&&(exact(result.error,['code'])||name.startsWith('fs_')&&exact(result.error,['code','osCode'])&&['ENOENT','EACCES','EPERM','ENOTDIR','EISDIR','EBUSY','EIO'].includes(result.error.osCode))&&typeof result.error.code==='string';
        if(controller.signal.aborted||!result||typeof result!=='object'||(result.ok===true?!exact(result,['ok','value'])||result.value?.kind!==expectedKind:result.ok!==false||!exact(result,['ok','error','coverage'])||!validError))return unavailable();
        return JSON.stringify(result);
      }catch{return unavailable();}finally{clearTimeout(timer);signal.removeEventListener('abort',abort);controller.abort();}
      });
    },
  };
}
