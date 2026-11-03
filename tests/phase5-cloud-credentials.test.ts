import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCloudCredentialCatalogV1} from '../apps/desktop/src/main/cloud/credential-catalog';
import {CloudChatErrorV1} from '../packages/agent-adapters/src/cloud-chat-contract';
const bytes=(value:string)=>new TextEncoder().encode(value);
test('P5 credential parser selects exact named section, without endpoint or unrelated credential use',()=>{
  const source='other:\nUNRELATED_PRIVATE_VALUE\nhttps://untrusted.invalid\nkimi:\nsk-FAKE_KIMI_0000\n\ndeepseek:\nsk-FAKE_DEEPSEEK_0000\n';
  assert.equal(parseCloudCredentialCatalogV1(bytes(source),'kimi'),'sk-FAKE_KIMI_0000');
  assert.equal(parseCloudCredentialCatalogV1(bytes(source),'deepseek'),'sk-FAKE_DEEPSEEK_0000');
});
test('P5 credential parser rejects duplicate, ambiguous and malformed sections with safe errors',()=>{
  for(const source of ['deepseek:\nnot a credential','deepseek:\nsk-FAKE_SECRET_000\nDeepSeek:\nsk-OTHER_FAKE_000','deepseek:\nkimi:\nsk-FAKE_SECRET_000','sk-FAKE_UNSCOPED_000','deepseek: sk-FAKE_INLINE_000','x'.repeat(65537)]){
    assert.throws(()=>parseCloudCredentialCatalogV1(bytes(source),'deepseek'),(error:unknown)=>error instanceof CloudChatErrorV1&&error.code==='NOT_CONFIGURED'&&!error.message.includes('SECRET'));
  }
});
test('P5 credential parser accepts UTF8 BOM and rejects malformed byte encoding',()=>{
  assert.equal(parseCloudCredentialCatalogV1(bytes('\uFEFFdeepseek：\r\napi_key: sk-FAKE_CREDENTIAL_000\r\n'),'deepseek'),'sk-FAKE_CREDENTIAL_000');
  assert.throws(()=>parseCloudCredentialCatalogV1(new Uint8Array([0xff]),'deepseek'),CloudChatErrorV1);
});
