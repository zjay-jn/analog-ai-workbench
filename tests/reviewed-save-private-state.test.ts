import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {EDIT_VERSION} from '../apps/desktop/src/shared/agent/reviewed-edit';
import {createReviewedSaveHost} from '../apps/desktop/src/main/cloud/reviewed-save';
for(const directory of ['chat-drafts','project-workspace','display-paths'])test('reviewed save rejects synthetic application data directory '+directory,async()=>{
 const root=path.resolve('.local/test-workspaces/save-private-'+randomUUID()),folder=path.join(root,directory);fs.mkdirSync(folder,{recursive:true});const target=path.join(folder,'synthetic.json');fs.writeFileSync(target,'{"synthetic":1}');
 const result=await createReviewedSaveHost(async()=>target).save({contractVersion:EDIT_VERSION,name:'synthetic.json',before:'{"synthetic":1}',after:'{"synthetic":2}'},()=>true);
 assert.deepEqual(result,{ok:false,error:{code:'UNSUPPORTED_FILE'}});assert.equal(fs.readFileSync(target,'utf8'),'{"synthetic":1}');assert.deepEqual(fs.readdirSync(folder),['synthetic.json']);
});
