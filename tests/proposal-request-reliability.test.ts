import test from 'node:test';import assert from 'node:assert/strict';
import {submitProposal,proposalRequestFingerprint,reconcileProposalJobs} from '../apps/desktop/src/renderer/documents/proposal-requests';
import {emptyWorkspace,parseWorkspaceDisk,type ProposalJob} from '../apps/desktop/src/shared/agent/project-workspace';
import type {SessionTurn} from '../apps/desktop/src/shared/agent/chat-sessions';
const file={id:'00000000-0000-4000-8000-000000000002',name:'synthetic.txt',text:'before',startLine:1,endLine:1,totalLines:1};
const job:ProposalJob={id:'00000000-0000-4000-8000-000000000003',sessionId:'00000000-0000-4000-8000-000000000004',document:file,excerpt:file,status:'waiting'};
test('accepted main request with lost ACK preserves durable proposal and never resends',async()=>{
 let jobs:ProposalJob[]=[],sends=0;const result=await submitProposal(job,async update=>{jobs=update(jobs);return true;},async()=>{sends++;throw Error('synthetic lost ACK');});
 assert.equal(result,'uncertain');assert.equal(jobs.length,1);assert.equal(jobs[0]!.id,job.id);assert.equal(sends,1);
});
const prompt='Synthetic exact instruction';
const turn:SessionTurn={id:job.id,user:prompt,assistant:'```txt\nafter\n```',status:'completed',error:'',images:[],files:[file]};
const signed=async()=>({...job,requestFingerprint:await proposalRequestFingerprint(job.sessionId,job.id,prompt,[],[file])});
test('confirmed refusal removes pending job; persistence failure blocks sending',async()=>{
 let jobs:ProposalJob[]=[],sends=0;const set=async(update:(jobs:ProposalJob[])=>ProposalJob[])=>{jobs=update(jobs);return true;};
 assert.equal(await submitProposal(await signed(),set,async()=>{sends++;return 'rejected';}),'rejected');assert.deepEqual(jobs,[]);assert.equal(sends,1);
 assert.equal(await submitProposal(await signed(),async()=>false,async()=>{sends++;return 'accepted';}),'rejected');assert.equal(sends,1);
});
test('unconfirmed cleanup after refusal retains recovery marker and reports uncertainty',async()=>{
 let jobs:ProposalJob[]=[],writes=0;assert.equal(await submitProposal(await signed(),async update=>{if(++writes===2)return false;jobs=update(jobs);return true;},async()=>'rejected'),'uncertain');assert.equal(jobs.length,1);
});
test('restart recovers only exact same-session request into review without sending',async()=>{
 const disk=emptyWorkspace();disk.projects[0]!.jobs=[await signed()];const recovered=parseWorkspaceDisk(JSON.parse(JSON.stringify(disk))).projects[0]!.jobs;
 const next=await reconcileProposalJobs(recovered,job.sessionId,[turn]);assert.equal(next[0]!.status,'review');assert.equal(next[0]!.after,'after');assert.equal(next[0]!.requestFingerprint,recovered[0]!.requestFingerprint);
 assert.equal(await reconcileProposalJobs(next,job.sessionId,[turn]),next);
});
test('different session or request ID cannot consume a waiting proposal',async()=>{
 const jobs=[await signed()];assert.equal(await reconcileProposalJobs(jobs,'00000000-0000-4000-8000-000000000099',[turn]),jobs);
 assert.equal(await reconcileProposalJobs(jobs,job.sessionId,[{...turn,id:'00000000-0000-4000-8000-000000000099'}]),jobs);
});
test('original question, every excerpt field, image fields and continuation are checked',async()=>{
 const jobs=[await signed()];const alterations:SessionTurn[]=[{...turn,user:prompt+' '},{...turn,files:[]},{...turn,files:[file,file]},{...turn,continueFrom:job.id},{...turn,images:[{id:file.id,name:'synthetic.png',data:'synthetic',width:1,height:1}]}];
 for(const [key,value] of Object.entries({id:'00000000-0000-4000-8000-000000000099',name:'other.txt',text:'else',startLine:2,endLine:2,totalLines:2}))alterations.push({...turn,files:[{...file,[key]:value}]});
 for(const candidate of alterations){const next=await reconcileProposalJobs(jobs,job.sessionId,[candidate]);assert.equal(next[0]!.status,'waiting');assert.equal(next[0]!.after,undefined);assert.match(next[0]!.error!,/不一致/);assert.equal(await reconcileProposalJobs(next,job.sessionId,[candidate]),next);}
 const image={id:file.id,name:'synthetic.png',data:'synthetic',width:1,height:1},digest=await proposalRequestFingerprint(job.sessionId,job.id,prompt,[image],[file]);
 for(const [key,value] of Object.entries({id:job.id,name:'other.png',data:'else',width:2,height:2}))assert.notEqual(await proposalRequestFingerprint(job.sessionId,job.id,prompt,[{...image,[key]:value}],[file]),digest);
});
test('running exact request waits; invalid or incomplete replies cannot become editable',async()=>{
 const jobs=[await signed()];assert.equal(await reconcileProposalJobs(jobs,job.sessionId,[{...turn,status:'running'}]),jobs);
 for(const candidate of [{...turn,status:'failed' as const},{...turn,assistant:'prose'}])assert.equal((await reconcileProposalJobs(jobs,job.sessionId,[candidate]))[0]!.status,'rejected');
});
test('legacy jobs load but need manual verification; fingerprint accepts only exact 64 lower hex',async()=>{
 const disk=emptyWorkspace();disk.projects[0]!.jobs=[job];assert.deepEqual(parseWorkspaceDisk(disk).projects[0]!.jobs,[job]);
 const old=await reconcileProposalJobs([job],job.sessionId,[turn]);assert.equal(old[0]!.status,'waiting');assert.match(old[0]!.error!,/旧提案/);
 disk.projects[0]!.jobs=[await signed()];assert.equal(parseWorkspaceDisk(disk).projects[0]!.jobs[0]!.requestFingerprint!.length,64);
 for(const fingerprint of ['',undefined,null,'f'.repeat(63),'f'.repeat(65),'A'.repeat(64),'g'.repeat(64),64]){const candidate=structuredClone(disk);candidate.projects[0]!.jobs=[{...job,requestFingerprint:fingerprint} as ProposalJob];assert.throws(()=>parseWorkspaceDisk(candidate));}
 const extra=structuredClone(disk);extra.projects[0]!.jobs=[{...job,unreviewedPath:'C:/synthetic.txt'} as ProposalJob];assert.throws(()=>parseWorkspaceDisk(extra));
});
