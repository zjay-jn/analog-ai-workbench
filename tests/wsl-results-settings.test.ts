import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { WSL_RESULTS_VERSION, type WslResultsBinding } from '../apps/desktop/src/shared/agent/wsl-results';
import { createWslResultsSettings } from '../apps/desktop/src/main/wsl-results/settings';
const fixtureRoot = path.resolve('.local/quality-evidence/20260915-wsl-results-module-01/settings-fixtures');
const binding: WslResultsBinding = { id: 'wsl-settings-fixture', distro: 'ROCKY9_LLM_LAB', user: 'maxwell', rootPath: '/home/maxwell/simulation/synthetic-result', rootIdentity: '20:30', readerVersion: WSL_RESULTS_VERSION, selectedAt: '2026-09-15T01:02:03.000Z' };
async function fixture() { await fs.mkdir(fixtureRoot, { recursive: true }); return fs.mkdtemp(path.join(fixtureRoot, 'bindings-')); }
test('bindings persist per project, restore without WSL, and disconnect leaves other projects intact', async () => {
  const directory = await fixture(), a = createWslResultsSettings({ directory });
  assert.equal(await a.get('one'), null);
  await a.set('one', binding); await a.set('two', { ...binding, id: 'wsl-second-fixture' });
  const b = createWslResultsSettings({ directory }); assert.deepEqual(await b.get('one'), binding);
  await b.set('one', null); assert.equal(await a.get('one'), null); assert.equal((await a.get('two'))!.id, 'wsl-second-fixture');
});
test('corrupt or broadened persisted WSL binding fails closed', async () => {
  const directory = await fixture(), store = createWslResultsSettings({ directory });
  await fs.writeFile(path.join(directory, 'wsl-results-bindings.json'), JSON.stringify({ version: WSL_RESULTS_VERSION, bindings: [{ projectId: 'one', binding: { ...binding, distro: 'ROCKY9_WSL2' } }] }));
  await assert.rejects(store.get('one'), { code: 'STORAGE_FAILED' });
  await assert.rejects(store.set('one', null), { code: 'STORAGE_FAILED' });
});
