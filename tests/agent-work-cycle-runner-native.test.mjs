import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const PRODUCT='C:\\work\\analog_ai_workbench';
const ROOT=path.join(PRODUCT,'.local','agent-work-cycle-runner');
const SELF=fileURLToPath(import.meta.url);
const NATIVE=path.join(ROOT,'build','runner.exe');
const NODE=path.join(PRODUCT,'.local','toolchains','node-v24.20.0-win-x64','node.exe');
const NODE_SHA='5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5';
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const fileSha=filename=>sha(fs.readFileSync(filename));
const write=(name,value)=>fs.writeFileSync(name,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
function inside(filename){const full=path.resolve(filename);assert(full.startsWith(PRODUCT+path.sep));return full;}
function directory(filename){inside(filename);fs.mkdirSync(filename,{recursive:true});}
function pin(filename,expected){assert.equal(fileSha(filename),expected);}
const shared=path.join(PRODUCT,'apps','desktop','src','shared','agent','agent-work-cycle.ts');
const SOURCES=[SELF,path.join(PRODUCT,'tools','agent-work-cycle-runner-native.cc'),path.join(PRODUCT,'tools','agent-work-cycle-runner-native-security.h'),path.join(PRODUCT,'tools','agent-work-cycle-runner-build.mjs'),path.join(PRODUCT,'tools','agent-work-cycle-runner-contract.md'),shared,path.join(ROOT,'build','runner-limits.h')];
const resultKeys=['version','executionId','signature','termination','exitCode','durationMs','stdoutHex','stderrHex','stdoutTruncated','stderrTruncated','cleanupConfirmed','appContainer','capabilityCount','atomicJob','lowIntegrity','profileDeleted','aclRestored','activeProcesses'];
if(process.platform!=='win32'||process.argv.length<3)throw Error('Explicit Windows-only native check');
if(process.argv[2]==='prepare'){
  assert.equal(process.argv.length,3);pin(NODE,NODE_SHA);
  const batch=crypto.randomUUID(),base=path.join(ROOT,'native-tests',batch);directory(base);
  const canary=path.join(base,'outside-canary.json'),canaryText=JSON.stringify({synthetic:'outside task boundary',nonce:crypto.randomUUID()});
  write(canary,canaryText);const port=50197;
  const positive=[
    "const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),net=require('node:net');",
    "const input=JSON.parse(fs.readFileSync(path.join(process.env.AAW_INPUT_DIR,'input.json'),'utf8'));",
    "const denied=action=>{try{action();return false}catch(error){return ['EACCES','EPERM','EBUSY'].includes(error.code)}};",
    "const checks={sum:input.a+input.b,inputWriteDenied:denied(()=>fs.writeFileSync(path.join(process.env.AAW_INPUT_DIR,'input.json'),'changed')),outsideReadDenied:denied(()=>fs.readFileSync("+JSON.stringify(canary)+")),runtimeWriteDenied:denied(()=>fs.writeFileSync(process.execPath,'changed'))};",
    "const child=cp.spawnSync(process.execPath,['-e','require(\"node:fs\").writeFileSync(process.env.AAW_OUTPUT_DIR+\"/child-started.txt\",\"unexpected-child\")'],{stdio:'ignore'});checks.childObservation={code:child.error?.code??null,errno:child.error?.errno??null,message:child.error?.message??null,status:child.status,signal:child.signal,pid:child.pid??null,sentinelPresent:fs.existsSync(path.join(process.env.AAW_OUTPUT_DIR,'child-started.txt'))};checks.childDenied=child.error?.code==='UNKNOWN'&&child.error?.errno===-4094&&child.pid===0&&child.status===null&&child.signal===null&&!checks.childObservation.sentinelPresent;",
    "let done=false;const finish=ok=>{if(done)return;done=true;checks.networkDenied=ok;fs.writeFileSync(path.join(process.env.AAW_OUTPUT_DIR,'result.json'),JSON.stringify(checks));console.log('AAW_NATIVE_RESULT='+JSON.stringify(checks));};",
    "const socket=net.connect({host:'127.0.0.1',port:"+port+"});socket.on('connect',()=>{checks.networkObservation={event:'connect'};socket.destroy();finish(false)});socket.on('error',e=>{checks.networkObservation={event:'error',code:e.code,errno:e.errno,syscall:e.syscall};finish(e.code==='ETIMEDOUT'&&e.errno===-4039&&e.syscall==='connect')});socket.setTimeout(1000,()=>{checks.networkObservation={event:'timeout'};socket.destroy();finish(false)});",
  ].join('\n');
  const definitions=[
    ['arithmetic-boundaries',positive,'exited'],
    ['timeout',"while(true){}",'timed_out'],
    ['cancel',"require('node:fs').writeFileSync(process.env.AAW_OUTPUT_DIR+'/running.txt','running');setInterval(()=>{},1000);",'cancelled'],
    ['log-limit',"const fs=require('node:fs'),buffer=Buffer.alloc(4096,120);while(true)fs.writeSync(1,buffer);",'limit'],
    ['output-limit',"require('node:fs').writeFileSync(process.env.AAW_OUTPUT_DIR+'/oversized.txt',Buffer.alloc(262145,120));setInterval(()=>{},1000);",'limit'],
  ];
  const cases=definitions.map(([name,program,termination])=>{
    const executionId='wce-'+crypto.randomUUID(),execution=path.join(base,'executions',executionId),runtime=path.join(execution,'runtime');
    const snapshot=path.join(base,'snapshots',executionId),input=path.join(snapshot,'input'),output=path.join(snapshot,'output');
    for(const dir of [runtime,input,output])directory(dir);
    fs.copyFileSync(NODE,path.join(runtime,'node.exe'),fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(path.join(path.dirname(NODE),'LICENSE'),path.join(runtime,'LICENSE'),fs.constants.COPYFILE_EXCL);
    write(path.join(input,'analyze.js'),program);write(path.join(runtime,'program.cjs'),program);
    const inputText=JSON.stringify({a:19,b:23});write(path.join(input,'input.json'),inputText);
    const inputs=[{relativePath:'analyze.js',bytes:Buffer.byteLength(program),version:sha(program)},{relativePath:'input.json',bytes:Buffer.byteLength(inputText),version:sha(inputText)}];
    const nonce=crypto.randomBytes(16).toString('hex'),signature=sha(JSON.stringify({executionId,inputs,input,output,programSha256:sha(program)}));
    return {name,executionId,execution,runtime,input,output,programSha256:sha(program),inputs,nonce,signature,expectedTermination:termination};
  });
  const plan={schema:'aaw.c1.native-check.v1',batch,base,createdAt:new Date().toISOString(),native:NATIVE,nativeSha256:fileSha(NATIVE),nodeSha256:NODE_SHA,
    sources:SOURCES.map(filename=>({path:filename,sha256:fileSha(filename)})),cases,canary,canarySha256:sha(canaryText),
    bounds:{nativeInvocations:5,maxProfiles:5,analysisDeadlineMs:10000,cleanupMs:5000,outerCallMs:30000,totalBatchMs:90000,loopbackHost:'127.0.0.1',loopbackPort:port,externalRequests:0},executionOwner:'Explicit C1 synthetic native check only'};
  write(path.join(base,'plan.json'),plan);console.log(JSON.stringify({plan:path.join(base,'plan.json'),sha256:fileSha(path.join(base,'plan.json')),nativeSha256:plan.nativeSha256,cases:cases.map(value=>value.name)}));
}else if(process.argv[2]==='execute'){
  assert.equal(process.argv.length,4);const planPath=inside(process.argv[3]),plan=JSON.parse(fs.readFileSync(planPath,'utf8'));
  assert.equal(plan.schema,'aaw.c1.native-check.v1');assert.equal(planPath,path.join(ROOT,'native-tests',plan.batch,'plan.json'));
  pin(plan.native,plan.nativeSha256);pin(NODE,plan.nodeSha256);for(const source of plan.sources)pin(source.path,source.sha256);pin(plan.canary,plan.canarySha256);
  assert.equal(plan.cases.length,5);const launched=path.join(plan.base,'launched.json');
  write(launched,{startedAt:new Date().toISOString(),planSha256:fileSha(planPath),deadlineAt:new Date(Date.now()+plan.bounds.totalBatchMs).toISOString()});
  const deadline=Date.now()+plan.bounds.totalBatchMs;const rows=[];let acceptedConnections=0;
  const server=net.createServer(socket=>{acceptedConnections++;socket.destroy();});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(plan.bounds.loopbackPort,plan.bounds.loopbackHost,resolve)});
  let baselineAcceptedConnections=0;
  try{
    // A main-owned positive control closes before the analysis counter starts.
    await new Promise((resolve,reject)=>{
      let connected=false;const socket=net.connect({host:plan.bounds.loopbackHost,port:plan.bounds.loopbackPort});
      socket.once('connect',()=>{connected=true});socket.once('error',reject);
      socket.setTimeout(1000,()=>socket.destroy(Error('Host loopback control timeout')));
      socket.once('close',()=>connected?resolve():reject(Error('Host loopback control did not connect')));
    });
    assert.equal(acceptedConnections,1);baselineAcceptedConnections=acceptedConnections;acceptedConnections=0;
    for(const item of plan.cases){
      assert(Date.now()<deadline);pin(plan.native,plan.nativeSha256);
      assert.equal(item.execution,path.join(plan.base,'executions',item.executionId));assert.equal(item.runtime,path.join(item.execution,'runtime'));
      for(const input of item.inputs)pin(path.join(item.input,input.relativePath),input.version);
      pin(path.join(item.runtime,'node.exe'),plan.nodeSha256);pin(path.join(item.runtime,'program.cjs'),item.programSha256);
      const args=[item.execution,item.runtime,item.input,item.output,item.executionId,item.signature,item.nonce,'analyze.js',item.programSha256,...item.inputs.map(input=>input.version+':'+input.bytes+':'+input.relativePath)];
      const startedAt=new Date().toISOString();let stdout='',stderr='',cancelSent=false,outerTimedOut=false;
      const child=spawn(plan.native,args,{cwd:item.execution,shell:false,windowsHide:true,env:{SystemRoot:'C:\\Windows',windir:'C:\\Windows',SystemDrive:'C:'},stdio:['pipe','pipe','pipe']});
      let hardStop=null;
      const timer=setTimeout(()=>{outerTimedOut=true;try{child.stdin.write('C');child.stdin.end()}catch{}hardStop=setTimeout(()=>child.kill(),plan.bounds.cleanupMs);},Math.min(plan.bounds.outerCallMs,Math.max(1,deadline-Date.now())));
      const cancelPoll=item.name==='cancel'?setInterval(()=>{if(!cancelSent&&fs.existsSync(path.join(item.output,'running.txt'))){cancelSent=true;child.stdin.write('C');child.stdin.end();}},10):null;
      child.stdin.on('error',()=>{});child.stdout.on('data',chunk=>{stdout+=chunk.toString('utf8');if(Buffer.byteLength(stdout)>16384)child.stdin.end('C')});child.stderr.on('data',chunk=>{stderr+=chunk.toString('utf8');});
      const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});
      clearTimeout(timer);if(hardStop)clearTimeout(hardStop);if(cancelPoll)clearInterval(cancelPoll);
      const row={name:item.name,executionId:item.executionId,startedAt,endedAt:new Date().toISOString(),nativeExitCode:code,stdout,stderr,cancelSent,outerTimedOut,baselineAcceptedConnections,acceptedConnections,serverListening:server.listening,serverAddress:server.address()};
      write(path.join(item.execution,'test-observation.json'),row);rows.push(row);write(path.join(plan.base,'case-'+rows.length+'.json'),row);
      assert.equal(code,0);assert.equal(outerTimedOut,false);const report=JSON.parse(stdout);assert.deepEqual(Object.keys(report).sort(),resultKeys.toSorted());
      assert.equal(report.executionId,item.executionId);assert.equal(report.signature,item.signature);
      for(const key of ['appContainer','atomicJob','lowIntegrity','cleanupConfirmed','profileDeleted','aclRestored'])assert.equal(report[key],true,key);
      assert.equal(report.capabilityCount,0);assert.equal(report.activeProcesses,0);assert.equal(report.termination,item.expectedTermination);
      assert(report.stdoutHex.length<=4096&&report.stderrHex.length<=4096);
      if(item.name==='arithmetic-boundaries'){
        assert.equal(report.exitCode,0);const result=JSON.parse(fs.readFileSync(path.join(item.output,'result.json'),'utf8'));
        const {childObservation,networkObservation,...checks}=result;
        assert.deepEqual(checks,{sum:42,inputWriteDenied:true,outsideReadDenied:true,runtimeWriteDenied:true,childDenied:true,networkDenied:true});
        assert.deepEqual(childObservation,{code:'UNKNOWN',errno:-4094,message:'spawnSync '+path.join(item.runtime,'node.exe')+' UNKNOWN',status:null,signal:null,pid:0,sentinelPresent:false});
        assert.equal(fs.existsSync(path.join(item.output,'child-started.txt')),false);
        assert.deepEqual(networkObservation,{event:'error',code:'ETIMEDOUT',errno:-4039,syscall:'connect'});
        assert.equal(baselineAcceptedConnections,1);assert.equal(server.listening,true);
        pin(plan.canary,plan.canarySha256);assert.equal(acceptedConnections,0);
      }
      if(item.name==='cancel')assert.equal(cancelSent,true);
      if(item.name==='log-limit')assert.equal(report.stdoutTruncated,true);
      for(const input of item.inputs)pin(path.join(item.input,input.relativePath),input.version);
      console.log(JSON.stringify({case:item.name,status:'PASS',executionId:item.executionId,termination:report.termination,durationMs:report.durationMs,cleanupConfirmed:true}));
    }
    const proof={schema:'aaw.c1.native-check-result.v1',status:'PASS',nativeSha256:plan.nativeSha256,runtimeSha256:plan.nodeSha256,appContainer:true,capabilityCount:0,atomicJob:true,cleanupConfirmed:true,aclRestored:true,profileDeleted:true,activeProcesses:0,
      cases:rows.map(row=>({name:row.name,executionId:row.executionId,observation:path.join(plan.base,'executions',row.executionId,'test-observation.json'),sha256:fileSha(path.join(plan.base,'executions',row.executionId,'test-observation.json'))})),plan:path.join(plan.base,'plan.json'),planSha256:fileSha(planPath),baselineAcceptedConnections,acceptedConnections,completedAt:new Date().toISOString()};
    write(path.join(plan.base,'result.json'),proof);console.log(JSON.stringify({status:'PASS',proof:path.join(plan.base,'result.json'),sha256:fileSha(path.join(plan.base,'result.json'))}));
  }catch(error){
    write(path.join(plan.base,'failure.json'),{status:'FAILED_CLOSED',message:String(error),completedCases:rows.length,rows:rows.map(row=>({name:row.name,executionId:row.executionId})),acceptedConnections});throw error;
  }finally{await new Promise(resolve=>server.close(resolve));}
}else throw Error('Unknown explicit native-check mode');
