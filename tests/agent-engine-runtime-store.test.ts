import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import fs from 'node:fs';import {randomUUID} from 'node:crypto';
import {createPilotStore} from '../apps/desktop/src/main/engine-pilot/store';
const root='C:/work/analog_ai_workbench';
test('pilot disk uses only its synthetic directory, exclusive lock and validated reload',()=>{
  const directory=path.join(root,'.local','agent-engine-pilot-tests',randomUUID());const store=createPilotStore(root,directory);
  try{assert.deepEqual(store.load(),{version:1,runs:[]});store.save({version:1,runs:[]});assert.throws(()=>createPilotStore(root,directory));}finally{store.close();}
  const restarted=createPilotStore(root,directory);try{assert.deepEqual(restarted.load(),{version:1,runs:[]});}finally{restarted.close();}
  assert.throws(()=>createPilotStore(root,path.join(root,'.local','chat-history')));
});
test('pilot external state change poisons writer instead of overwriting or silently recovering',()=>{
  const directory=path.join(root,'.local','agent-engine-pilot-tests',randomUUID());const store=createPilotStore(root,directory);
  try{store.load();store.save({version:1,runs:[]});fs.writeFileSync(path.join(directory,'runs.json'),'malformed synthetic state');assert.throws(()=>store.save({version:1,runs:[]}));assert.throws(()=>store.load());assert.equal(fs.readFileSync(path.join(directory,'runs.json'),'utf8'),'malformed synthetic state');}finally{store.close();}
});
