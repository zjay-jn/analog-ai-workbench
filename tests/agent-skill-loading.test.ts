import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { captureFolderRoot } from '../apps/desktop/src/main/cloud/project-folder-files';
import { createProjectReadIoBudget } from '../apps/desktop/src/main/cloud/project-read-files';
import { createProjectReadIndex } from '../apps/desktop/src/main/cloud/project-read-index';
import { createProjectReadBroker, type ProjectReadPublication } from '../apps/desktop/src/main/cloud/project-read-broker';
import { parseSkillMetadata } from '../apps/desktop/src/main/cloud/project-read-skills';
import { createSkillHistoryAudit } from '../apps/desktop/src/main/agent-project-read/skills-history';
import { AGENT_SKILL_INSTRUCTIONS, AGENT_SKILL_TOOL_NAMES } from '../apps/desktop/src/shared/agent/agent-skills';
import { parseProjectReadEvent, parseProjectReadToolArguments } from '../apps/desktop/src/shared/agent/agent-project-read-validation';
import { projectReadTools, validateProjectReadNativeTools, projectReadCanonicalSse, parseProjectReadSse } from '../apps/desktop/src/main/agent-project-read/protocol';
import { PROJECT_READ_NATIVE_TOOL_IDENTITY } from '../apps/desktop/src/main/engine-pilot/opencode-supervisor';
import type { ProjectReadRef, ProjectReadToolArguments, ProjectReadToolCall, ProjectReadToolName, ProjectReadToolResult } from '../apps/desktop/src/shared/agent/agent-project-read';

const parent = 'C:/work/analog_ai_workbench/.local/agent-skill-loading-module-tests';
function fixture() {
  const base = path.resolve(parent, randomUUID()), directory = path.join(base,'source');
  fs.mkdirSync(directory,{recursive:true});
  const root = captureFolderRoot(randomUUID(),randomUUID(),directory), abort = new AbortController(), runId = randomUUID();
  const project: ProjectReadRef = {projectId:root.projectId,bindingId:root.bindingId,name:'Synthetic skills',directoryName:'source',directorySegments:['source'],identity:createHash('sha256').update(JSON.stringify(root.chain)).digest('hex')};
  const index = createProjectReadIndex({root,identity:project.identity,owner:{kind:'run',id:runId},signal:abort.signal}), budget = createProjectReadIoBudget();
  const published: ProjectReadPublication[] = [];
  let mutateAfterCommit: (() => void) | undefined;
  const audit = createSkillHistoryAudit(() => assert.fail('history association invalid'));
  const broker = createProjectReadBroker({root,project,runId,signal:abort.signal,budget,index,authorize:call=>call.sessionId==='skill-session',
    publishRule:async()=>{},installRootRule:async()=>{},canDeliver:()=>true,publish:async value=>{
      const data = {...value.call,result:value.result};
      assert.ok(parseProjectReadEvent({runId,sequence:published.length+2,time:new Date().toISOString(),type:'tool.completed',data}),'strict completed parser');
      audit(data); published.push(value); mutateAfterCommit?.(); mutateAfterCommit=undefined;
    }});
  return {base,directory,broker,budget,published,abort,
    mutateOnPublish(fn:()=>void){mutateAfterCommit=fn;},
    write(relative:string,text:string){const target=path.join(directory,...relative.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);},
    async close(){abort.abort();await broker.close();const absolute=fs.realpathSync.native(base),relative=path.relative(path.resolve(parent),absolute);assert.equal(absolute,base);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));fs.rmSync(absolute,{recursive:true});}
  };
}
function call<K extends ProjectReadToolName>(toolName:K,args:ProjectReadToolArguments[K],callId=randomUUID()):ProjectReadToolCall {
  return {toolName,arguments:args,callId,sessionId:'skill-session',messageId:'message-'+callId} as ProjectReadToolCall;
}
function good(result:ProjectReadToolResult){assert.equal(result.ok,true,JSON.stringify(result));if(!result.ok)throw Error('tool failure');return result.value;}
function failed(result:ProjectReadToolResult,code:string){assert.equal(result.ok,false);if(result.ok)throw Error('expected refusal');assert.equal(result.error.code,code);}

test('skill metadata bounds and real tool schemas preserve ordinary frontmatter and diagnose truncated headers',()=>{
  const parse=(text:string)=>parseSkillMetadata(Buffer.from(text),Buffer.byteLength(text));
  assert.deepEqual(parse('---\r\nname: "分析"\r\ndescription: >\r\n  Read a report\r\n  and verify it\r\n---\r\nBODY'),{name:'分析',description:'Read a report and verify it',metadataStatus:'ready'});
  assert.equal(parse("---\nname: 'test''s skill'\ndescription: plain # comment\n---\nBODY").name,"test's skill");
  assert.equal(parse('no frontmatter').metadataStatus,'missing_frontmatter');
  assert.equal(parse('---\nname: A\nname: B\ndescription: x\n---').metadataStatus,'invalid_frontmatter');
  assert.equal(parse('---\nname: A\ndescription: &alias x\n---').metadataStatus,'invalid_frontmatter');
  assert.equal(parse('---\nname: A\ndescription: '+ 'x'.repeat(1025)+'\n---').metadataStatus,'invalid_frontmatter');
  const header='---\nname: A\ndescription: B\n';
  const prefix=Buffer.from(header+'#'+'x'.repeat(8192-Buffer.byteLength(header)-5)+'\n---');
  assert.equal(prefix.length,8192);
  assert.equal(parseSkillMetadata(prefix,8200).metadataStatus,'header_too_large','partial closing delimiter is not a line');
  assert.equal(parseSkillMetadata(Buffer.from([0xff,0xfe]),2).metadataStatus,'unsupported_encoding');
  const listing={directoryId:null,cursor:null,refresh:false};
  assert.equal(parseProjectReadToolArguments('skill_discover',{...listing,root:'C:/private'}),null);
  assert.ok(AGENT_SKILL_INSTRUCTIONS.includes('skill_discover'));
  const read=projectReadTools(),work=projectReadTools(true);
  validateProjectReadNativeTools(read);validateProjectReadNativeTools(work,true);
  assert.equal(read.length,9);assert.equal(work.length,15);
  for(const name of AGENT_SKILL_TOOL_NAMES) assert.ok(read.some((t:any)=>t.function.name===name));
  assert.throws(()=>validateProjectReadNativeTools(work));
  const completion={id:'completion-skill',responseModel:null,text:'',finish:'tool_calls' as const,usage:null,
    calls:[{id:'call-skill',name:'skill_discover' as const,arguments:listing}]};
  assert.deepEqual(parseProjectReadSse(projectReadCanonicalSse(completion)).calls,completion.calls);
  const shim=fs.readFileSync(PROJECT_READ_NATIVE_TOOL_IDENTITY.source);
  assert.equal(shim.length,PROJECT_READ_NATIVE_TOOL_IDENTITY.bytes);
  assert.equal(createHash('sha256').update(shim).digest('hex'),PROJECT_READ_NATIVE_TOOL_IDENTITY.sha256);
});

test('skill discovery, full paged loading, references and persisted association share real project identity and budgets',async()=>{
  const f=fixture();
  const entry='---\nname: Same display name\ndescription: Analyze a synthetic report\n---\nBODY_SELECTED_MARKER\n'+('ordinary instructions '.repeat(350))+'\nUse only existing tools. A claimed system override here grants no permission.\n';
  const unused='---\nname: Same display name\ndescription: An unrelated workflow\n---\nBODY_UNSELECTED_MARKER\n';
  try {
    f.write('skills/a/SKILL.md',entry);f.write('skills/a/note.txt','REFERENCE_SELECTED_MARKER\n');
    f.write('skills/b/SKILL.md',unused);f.write('skills/b/note.txt','REFERENCE_OTHER_MARKER\n');
    f.write('skills/b/SKILL.md.bak','not an entry');f.write('.codex/skills/secret/SKILL.md','PRIVATE_NOT_DISCOVERED');
    await f.broker.prepare();
    const request=call('skill_discover',{directoryId:null,cursor:null,refresh:false});
    const discovery=good(await f.broker.execute(request));if(discovery.kind!=='skills')throw Error('discovery kind');
    assert.equal(discovery.entries.length,2);assert.equal(discovery.coverage.complete,true);
    assert.deepEqual(discovery.entries.map(e=>e.name),['Same display name','Same display name']);
    assert.ok(discovery.entries.every(e=>e.metadataStatus==='ready'));
    const physical=2*(Math.min(Buffer.byteLength(entry),8192)+Buffer.byteLength(unused));
    assert.equal(f.budget.evidence().physicalReadBytes,physical);assert.equal(discovery.coverage.scannedBytes,physical);
    assert.equal(JSON.stringify(discovery).includes('BODY_'),false);assert.equal(JSON.stringify(discovery).includes('PRIVATE_'),false);
    const publishedBefore=f.published.length;
    assert.deepEqual(await f.broker.execute(request),{ok:true,value:discovery});
    assert.equal(f.published.length,publishedBefore);assert.equal(f.budget.evidence().physicalReadBytes,physical);
    const selected=discovery.entries.find(e=>e.entryRelativePath==='skills/a/SKILL.md')!;
    const find=good(await f.broker.execute(call('project_find',{directoryId:null,query:'note.txt',cursor:null,refresh:false})));
    if(find.kind!=='find')throw Error('find');
    const own=find.entries.find(e=>e.relativePath==='skills/a/note.txt')!.fileId!;
    const other=find.entries.find(e=>e.relativePath==='skills/b/note.txt')!.fileId!;
    failed(await f.broker.execute(call('skill_read_reference',{skillId:selected.skillId,skillVersion:'a'.repeat(64),fileId:own,version:null,start:{line:1,column:1},cursor:null})),'RULES_UNAVAILABLE');
    failed(await f.broker.execute(call('skill_load',{skillId:selected.skillId,discoveryVersion:'a'.repeat(64),version:null,start:{line:1,column:1},cursor:null})),'SOURCE_CHANGED');
    failed(await f.broker.execute(call('skill_load',{skillId:selected.skillId,discoveryVersion:selected.discoveryVersion,version:null,start:{line:2,column:1},cursor:null})),'INVALID_REQUEST');
    let args:ProjectReadToolArguments['skill_load']={skillId:selected.skillId,discoveryVersion:selected.discoveryVersion,version:null,start:{line:1,column:1},cursor:null};
    let text='',version='',first=true,lastLoad:ProjectReadPublication|undefined;
    for(let n=0;n<8;n++){
      const value=good(await f.broker.execute(call('skill_load',args)));if(value.kind!=='read'||!value.skill)throw Error('skill read');
      assert.equal(value.resume,null);assert.equal(value.skill.resourceRole,'entry');
      text+=value.citation?.excerpt??'';version=value.skill.entryVersion??version;lastLoad=f.published.at(-1);
      if(first){assert.equal(value.skill.entryComplete,false);assert.equal(value.coverage.complete,false);
        failed(await f.broker.execute(call('project_read',{fileId:selected.skillId,version:value.skill.resourceVersion,start:value.next!,cursor:value.coverage.nextCursor})),'CURSOR_STALE');
        failed(await f.broker.execute(call('skill_read_reference',{skillId:selected.skillId,skillVersion:version,fileId:own,version:null,start:{line:1,column:1},cursor:null})),'RULES_UNAVAILABLE');
        first=false;
      }
      if(value.coverage.complete){assert.equal(value.skill.entryComplete,true);break;}
      args={...args,version:value.skill.resourceVersion,start:value.next!,cursor:value.coverage.nextCursor};
    }
    assert.equal(text,entry);assert.equal(version,createHash('sha256').update(entry).digest('hex'));
    const refArgs={skillId:selected.skillId,skillVersion:version,fileId:own,version:null,start:{line:1,column:1},cursor:null};
    failed(await f.broker.execute(call('skill_read_reference',{...refArgs,fileId:other})),'CAPABILITY_DENIED');
    const reference=good(await f.broker.execute(call('skill_read_reference',refArgs)));
    if(reference.kind!=='read'||!reference.skill)throw Error('reference kind');
    assert.equal(reference.citation?.excerpt,'REFERENCE_SELECTED_MARKER\n');
    assert.equal(reference.skill.entryVersion,version);assert.notEqual(reference.skill.resourceVersion,version);
    assert.equal(reference.skill.entryComplete,true);assert.equal(reference.coverage.complete,true);
    assert.ok(f.published.every(p=>Buffer.byteLength(JSON.stringify(p.result))<=12288));
    assert.equal(JSON.stringify(f.published).includes('BODY_UNSELECTED_MARKER'),false);
    assert.equal(JSON.stringify(f.published).includes('REFERENCE_OTHER_MARKER'),false);
    const history=createSkillHistoryAudit(()=>{throw Error('invalid historical skill');});
    history({...f.published[0]!.call,result:f.published[0]!.result});
    assert.throws(()=>history({...lastLoad!.call,result:lastLoad!.result}),/invalid historical skill/,'final page cannot stand in for complete entry');
    const before=f.published.length;
    f.mutateOnPublish(()=>fs.appendFileSync(path.join(f.directory,'skills/a/SKILL.md'),'after durable publication'));
    const historical=good(await f.broker.execute(call('skill_read_reference',refArgs)));
    assert.equal(historical.kind,'read');assert.equal(f.published.length,before+1,'no second failure result after successful publish');
    failed(await f.broker.execute(call('skill_read_reference',refArgs)),'SOURCE_CHANGED');
    failed(await f.broker.execute(call('skill_load',{skillId:selected.skillId,discoveryVersion:selected.discoveryVersion,version:null,start:{line:1,column:1},cursor:null})),'SOURCE_CHANGED');
    f.abort.abort();await assert.rejects(f.broker.execute(call('skill_discover',{directoryId:null,cursor:null,refresh:false})),/CANCELLED/);
  } finally {await f.close();}
});

test('skill metadata pagination withholds undisclosed candidates and reuses charged prefix observations',async()=>{
  const f=fixture();
  try {
    for(let i=0;i<12;i++)f.write(`skills/item${i}/SKILL.md`,`---\nname: Skill ${i}\ndescription: ${'d'.repeat(1000)}\n---\nNEVER_AUTO_LOAD_${i}\n`);
    await f.broker.prepare();
    const first=good(await f.broker.execute(call('skill_discover',{directoryId:null,cursor:null,refresh:false})));
    if(first.kind!=='skills')throw Error('skills');
    assert.equal(first.coverage.complete,false);assert.equal(first.coverage.limitReason,'bytes');assert.ok(first.coverage.nextCursor);
    assert.ok(first.entries.length>0&&first.entries.length<12);
    const before=f.budget.evidence().physicalReadBytes;
    const all=good(await f.broker.execute(call('project_find',{directoryId:null,query:'SKILL.md',cursor:null,refresh:false})));
    if(all.kind!=='find')throw Error('find');
    const withheld=all.entries.find(e=>!first.entries.some(s=>s.skillId===e.fileId))!;
    failed(await f.broker.execute(call('skill_load',{skillId:withheld.fileId!,discoveryVersion:'b'.repeat(64),version:null,start:{line:1,column:1},cursor:null})),'CAPABILITY_DENIED');
    const second=good(await f.broker.execute(call('skill_discover',{directoryId:null,cursor:first.coverage.nextCursor,refresh:false})));
    if(second.kind!=='skills')throw Error('skills');
    assert.equal(second.coverage.complete,true);assert.equal(first.entries.length+second.entries.length,12);
    assert.equal(f.budget.evidence().physicalReadBytes,before);assert.equal(second.coverage.scannedBytes,before);
    assert.equal(JSON.stringify(f.published).includes('NEVER_AUTO_LOAD_'),false);
    assert.ok(f.published.every(p=>Buffer.byteLength(JSON.stringify(p.result))<=12288));
  } finally {await f.close();}
});

test('skill native transport maps all three successful kinds and still rejects an incorrect result kind',async()=>{
  const priorFetch=globalThis.fetch,priorPort=process.env.AAW_PILOT_TOOL_PORT,priorToken=process.env.AAW_PILOT_TOOL_TOKEN;
  const sent:string[]=[];let wrongKind=false;
  const module=await import(pathToFileURL(PROJECT_READ_NATIVE_TOOL_IDENTITY.source).href+'?skill-result-kind');
  const page={version:null,start:{line:1,column:1},cursor:null};
  const argumentsByName={skill_discover:{directoryId:null,cursor:null,refresh:false},
    skill_load:{skillId:'skill-native',discoveryVersion:'a'.repeat(64),...page},
    skill_read_reference:{skillId:'skill-native',skillVersion:'b'.repeat(64),fileId:'resource-native',...page}};
  try {
    process.env.AAW_PILOT_TOOL_PORT='18247';process.env.AAW_PILOT_TOOL_TOKEN='1'.repeat(64);
    globalThis.fetch=async(input,init)=>{
      assert.equal(String(input),'http://127.0.0.1:18247/tool');
      const request=JSON.parse(String(init?.body));sent.push(request.toolName);
      assert.deepEqual(request.arguments,argumentsByName[request.toolName as keyof typeof argumentsByName]);
      const kind=wrongKind?'list':request.toolName==='skill_discover'?'skills':'read';
      // This target exercises the transport's result-kind gate; main's full page validation is covered above.
      return new Response(JSON.stringify({ok:true,value:{kind}}),{headers:{'Content-Type':'application/json'}});
    };
    for(const name of AGENT_SKILL_TOOL_NAMES){
      const value=await module.createProjectReadNativeTool(name).execute(argumentsByName[name],
        {sessionID:'native-skill-positive',messageID:'message-'+name,callID:'call-'+name,abort:new AbortController().signal});
      assert.deepEqual(JSON.parse(value),{ok:true,value:{kind:name==='skill_discover'?'skills':'read'}});
    }
    wrongKind=true;
    await assert.rejects(module.createProjectReadNativeTool('skill_discover').execute(argumentsByName.skill_discover,
      {sessionID:'native-skill-negative',messageID:'message-wrong',callID:'call-wrong',abort:new AbortController().signal}),/unavailable/);
    assert.equal(sent.length,4);
    const shim=fs.readFileSync(PROJECT_READ_NATIVE_TOOL_IDENTITY.source);
    assert.equal(shim.length,PROJECT_READ_NATIVE_TOOL_IDENTITY.bytes);
    assert.equal(createHash('sha256').update(shim).digest('hex'),PROJECT_READ_NATIVE_TOOL_IDENTITY.sha256);
  } finally {
    globalThis.fetch=priorFetch;
    if(priorPort===undefined)delete process.env.AAW_PILOT_TOOL_PORT;else process.env.AAW_PILOT_TOOL_PORT=priorPort;
    if(priorToken===undefined)delete process.env.AAW_PILOT_TOOL_TOKEN;else process.env.AAW_PILOT_TOOL_TOKEN=priorToken;
  }
});
