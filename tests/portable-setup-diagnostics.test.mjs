import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {persistNativeSelfTestDiagnostics} from '../tools/portable-native-build.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=path.join(root,'.local/portable-diagnostic-tests');fs.mkdirSync(temporary,{recursive:true});
function fixture(){const folder=fs.mkdtempSync(path.join(temporary,'case-')),runtimeRoot=path.join(folder,'.local/runtime'),records=path.join(folder,'synthetic-records');fs.mkdirSync(runtimeRoot,{recursive:true});fs.mkdirSync(records);return {paths:{root:folder,runtimeRoot},records};}

test('failed work evidence retains bounded report, errors and actual cleanup flags before throwing',()=>{
  const {paths,records}=fixture();fs.writeFileSync(path.join(records,'cleanup-failed.json'),JSON.stringify({cleanupConfirmed:false,activeProcesses:2}));fs.writeFileSync(path.join(records,'config.json'),'SYNTHETIC_NOT_FOR_UPLOAD');
  const aclDiagnostic={schema:'aaw.native.acl-cleanup-diagnostic/v1',restoreGrants:false,normalizeOutput:true,failures:[{index:0,directory:true,priorControl:4,currentControl:1028,observation:{stage:'verify',queryCode:0},prior:{size:64,bytesInUse:60},current:{size:60,bytesInUse:60}}]};fs.writeFileSync(path.join(records,'acl-diagnostics.json'),JSON.stringify(aclDiagnostic));
  const report={version:1,termination:'isolation_failed',exitCode:null,cleanupConfirmed:false,activeProcesses:2,aclRestored:false,profileDeleted:false};
  const result=persistNativeSelfTestDiagnostics(paths,{kind:'work',buildId:'synthetic',executionId:'synthetic-id',recordRoot:records,received:{code:0,closed:true,stdout:JSON.stringify(report),stderr:'create_process:5\n'},report,okay:false,failures:['termination','exit_code','cleanup']});
  const output=path.join(paths.root,result.directory),saved=JSON.parse(fs.readFileSync(path.join(output,'result.json'),'utf8'));
  assert.equal(saved.status,'FAIL');assert.equal(saved.exitCode,0);assert.equal(saved.cleanup.confirmed,false);assert.equal(saved.cleanup.activeProcesses,2);assert(saved.failures.includes('cleanup'));
  assert.equal(fs.readFileSync(path.join(output,'stderr.txt'),'utf8'),'create_process:5\n');assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output,'report.json'),'utf8')),report);
  assert(fs.existsSync(path.join(output,'native-record-cleanup-failed.json')));assert.equal(fs.existsSync(path.join(output,'config.json')),false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output,'native-record-acl-diagnostics.json'),'utf8')),aclDiagnostic);
});
test('malformed/oversized output and records cannot grow an artifact without a limit',()=>{
  const {paths,records}=fixture();fs.writeFileSync(path.join(records,'native-claim.json'),'x'.repeat(65537));
  const result=persistNativeSelfTestDiagnostics(paths,{kind:'work',buildId:'synthetic',executionId:'synthetic-id',recordRoot:records,received:{code:1,closed:true,stdout:'invalid'.repeat(5000),stderr:'error'.repeat(5000),stdoutObservedBytes:35000,stderrObservedBytes:25000},report:null,okay:false,failures:['report_json_invalid']});
  const output=path.join(paths.root,result.directory),saved=JSON.parse(fs.readFileSync(path.join(output,'result.json'),'utf8'));
  for(const name of ['stdout','stderr']){assert(fs.statSync(path.join(output,name+'.txt')).size<=16384);assert.equal(saved.streams[name].truncated,true);}
  assert.equal(saved.reportCapture,'absent');assert(saved.records.some(record=>record.name==='native-claim'&&record.status==='unavailable'));assert.equal(fs.existsSync(path.join(output,'native-record-native-claim.json')),false);
});
test('guardian evidence copies only fixed control receipts, never configuration or authentication',()=>{
  const {paths,records}=fixture();for(const name of ['intent','ready','result'])fs.writeFileSync(path.join(records,name+'.json'),JSON.stringify({schema:'synthetic.'+name}));
  fs.writeFileSync(path.join(records,'opencode.json'),'SYNTHETIC_CONFIGURATION_AUTH');
  const result=persistNativeSelfTestDiagnostics(paths,{kind:'guardian',buildId:'synthetic',executionId:'synthetic-id',recordRoot:records,received:{code:null,closed:false,transportError:'GUARDIAN_CLEANUP_UNCONFIRMED',stdout:'',stderr:'',stdoutObservedBytes:100,stderrObservedBytes:20,stdoutCaptureTruncated:true,stderrCaptureTruncated:true},report:null,okay:false,failures:['closed','healthy'],health:[{status:null,healthy:false,version:null,error:'HEALTH_REQUEST_FAILED'}]});
  const output=path.join(paths.root,result.directory),names=fs.readdirSync(output),body=names.map(name=>fs.readFileSync(path.join(output,name),'utf8')).join('\n');
  assert.equal(body.includes('SYNTHETIC_CONFIGURATION_AUTH'),false);assert.equal(names.includes('opencode.json'),false);assert.deepEqual(names.sort(),['native-record-intent.json','native-record-ready.json','native-record-result.json','result.json','stderr.txt','stdout.txt'].sort());
  assert.equal(JSON.parse(fs.readFileSync(path.join(output,'result.json'),'utf8')).schema,'aaw.native-self-test-diagnostic/v1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(output,'native-record-result.json'),'utf8')).schema,'synthetic.result');
  // The diagnostic summary deliberately owns result.json; the native result
  // receipt must not be mistaken for or overwrite that summary.
});
