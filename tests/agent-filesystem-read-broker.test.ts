import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { memory, base, A, B, type Row } from './helpers/filesystem-read-memory';
import { createHash, randomUUID } from 'node:crypto';
import { createFilesystemReadBroker, type ProjectReadPublication, type ProjectReadSharedQuota, type StoredFileSystemSource } from '../apps/desktop/src/main/cloud/project-read-broker';
import { createProjectReadIoBudget } from '../apps/desktop/src/main/cloud/project-read-files';
import { parseProjectReadEvent } from '../apps/desktop/src/shared/agent/agent-project-read-validation';
import { PROJECT_READ_LIMITS as L, type ProjectReadRef, type ProjectReadRule, type ProjectReadToolCall, type ProjectReadToolResult, type ProjectReadToolValue } from '../apps/desktop/src/shared/agent/agent-project-read';
import type { FileSystemToolArguments, FileSystemToolName } from '../apps/desktop/src/shared/agent/agent-filesystem-read';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

type Settings = { bound?: boolean; cwd?: string | null; protectedRoots?: readonly string[]; ioBytes?: number; quota?: ProjectReadSharedQuota; indexQuota?: { indexBytes: number; visitedCandidates: number } };
function fixture(t: TestContext, rows: Record<string, Row>, settings: Settings = {}) {
  const m = memory(t, rows), runId = randomUUID(), abort = new AbortController(), projectId = randomUUID();
  const project: ProjectReadRef = settings.bound
    ? { projectId, bindingId: randomUUID(), name: 'Synthetic A', directoryName: 'project-A', directorySegments: ['C', 'work', 'analog_ai_workbench', '.local', 'fs-broker-memory', 'project-A'], identity: digest('synthetic project A') }
    : { projectId, name: 'Unbound synthetic', bindingId: null, identity: null, directoryName: null, directorySegments: [] };
  const budget = createProjectReadIoBudget(settings.ioBytes), quota = settings.quota ?? { toolAttempts: 0, toolBytes: 0, citations: 0 };
  const indexQuota = settings.indexQuota ?? { indexBytes: 0, visitedCandidates: 0 }, publications: ProjectReadPublication[] = [], rules: ProjectReadRule[] = [], sources: StoredFileSystemSource[] = [], invalidEvents: unknown[] = [];
  let sequence = 2; // Sequence 1 belongs to the host's run.accepted event.
  const validate = (type: 'tool.completed' | 'project.rules', data: unknown) => {
    const event = { runId, sequence: sequence++, time: new Date().toISOString(), type, data };
    const parsed = parseProjectReadEvent(event);
    if (!parsed) invalidEvents.push(event);
    assert.ok(parsed, 'independent shared event parser rejected ' + JSON.stringify(event));
  };
  const broker = createFilesystemReadBroker({
    project, runId, signal: abort.signal, budget, quota, indexQuota,
    cwd: settings.cwd === undefined ? settings.bound ? A : null : settings.cwd, protectedRoots: settings.protectedRoots ?? [],
    register: value => { sources.push(value); },
    authorize: call => call.sessionId === 'synthetic-session',
    publishRule: async rule => { validate('project.rules', { rules: [rule] }); rules.push(rule); },
    canDeliver: () => true,
    publish: async publication => {
      validate('tool.completed', { ...publication.call, result: publication.result });
      assert.equal(publication.citations.length, publication.locators.length);
      for (const citation of publication.citations) {
        assert.equal(citation.runId, runId); assert.equal(citation.project.projectId, projectId);
        assert.equal(citation.excerptSha256, digest(citation.excerpt)); assert.ok(citation.location);
        assert.equal(publication.locators.find(row => row.citationId === citation.citationId)?.file.absolutePath, citation.location.absolutePath);
      }
      assert.ok(Buffer.byteLength(JSON.stringify(publication.result)) <= L.toolResultBytes);
      publications.push(publication);
    },
  });
  return { broker, m, project, budget, quota, indexQuota, publications, rules, sources, invalidEvents,
    async execute(call: ProjectReadToolCall) {
      try { return await broker.execute(call); }
      catch (error) { if (invalidEvents.length) assert.fail('invalid publication: ' + JSON.stringify(invalidEvents.at(-1))); throw error; }
    },
    async close() { await broker.close(); abort.abort(); },
  };
}
function call<K extends FileSystemToolName>(toolName: K, args: FileSystemToolArguments[K]): ProjectReadToolCall {
  const callId = randomUUID(); return { toolName, arguments: args, callId, sessionId: 'synthetic-session', messageId: 'message-' + callId } as ProjectReadToolCall;
}
type Data = Extract<ProjectReadToolValue, { kind: 'read' | 'search' | 'list' | 'find' }>;
function success(result: ProjectReadToolResult): Data {
  assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) return assert.fail('tool failed');
  assert.ok(['read', 'search', 'list', 'find'].includes(result.value.kind)); return result.value as Data;
}
function failure(result: ProjectReadToolResult, code: string, osCode?: string) {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (!result.ok) { assert.equal(result.error.code, code); if (osCode) assert.equal(result.error.osCode, osCode); }
}
const readArgs = (path: string | null, fileId: string | null = null): FileSystemToolArguments['fs_read'] => ({ path, fileId, version: null, start: { line: 1, column: 1 }, cursor: null });
const listArgs = (path: string | null, directoryId: string | null = null, refresh = false): FileSystemToolArguments['fs_list'] => ({ path, directoryId, cursor: null, refresh });
const searchArgs = (path: string | null, fileId: string | null = null, refresh = false, query = 'needle'): FileSystemToolArguments['fs_search'] => ({ path, fileId, directoryId: null, cursor: null, refresh, query });
async function pages(f: ReturnType<typeof fixture>, request: ProjectReadToolCall, expected: Data['kind']) {
  const values: Data[] = [];
  for (let step = 0; step < 24; step++) {
    const value = success(await f.execute(request)); assert.equal(value.kind, expected); values.push(value);
    if (value.coverage.complete) return values;
    const next = value.nextArguments; assert.ok(next, 'incomplete value must supply exact nextArguments');
    request = call(next.toolName, next.arguments);
  }
  return assert.fail('bounded continuation did not finish');
}
const readText = (values: Data[]) => values.map(value => value.kind === 'read' ? value.citation?.excerpt ?? '' : '').join('');
const readCitation = (values: Data[]) => {
  const last = values.filter(value => value.kind === 'read' && value.citation).at(-1);
  assert.ok(last?.kind === 'read' && last.citation); return last.citation;
};

test('filesystem manager: bound A reads absolute B and relative ../B with physical B provenance', async t => {
  const file = B + '\\same.log', f = fixture(t, { [A]: { directory: true }, [file]: { text: 'outside project\n' } }, { bound: true });
  try {
    const absolute = await pages(f, call('fs_read', readArgs(file)), 'read');
    const relative = await pages(f, call('fs_read', readArgs('../source-B/same.log')), 'read');
    assert.equal(readText(absolute), 'outside project\n'); assert.equal(readText(relative), 'outside project\n');
    assert.equal(readCitation(absolute).location?.absolutePath, file);
    assert.equal(readCitation(relative).location?.sourceId, readCitation(absolute).location?.sourceId);
    assert.equal(f.publications[0]?.citations[0]?.project.bindingId, f.project.bindingId);
    assert.equal(f.sources.length, 1); assert.deepEqual(f.m.seen.listed, []);
  } finally { await f.close(); }
});
test('filesystem manager: unbound absolute directory/file works while relative input reports no cwd', async t => {
  const file = B + '\\README', f = fixture(t, { [file]: { text: 'unbound data\n' } });
  try {
    failure(await f.execute(call('fs_read', readArgs('README'))), 'CWD_UNAVAILABLE');
    assert.equal(f.sources.length, 0);
    assert.equal(readText(await pages(f, call('fs_read', readArgs(file)), 'read')), 'unbound data\n');
    const values = await pages(f, call('fs_list', listArgs(B)), 'list');
    assert.ok(values.some(value => value.kind === 'list' && value.entries.some(entry => entry.name === 'README')));
    assert.ok(f.publications.flatMap(p => p.citations).every(c => c.project.bindingId === null));
  } finally { await f.close(); }
});
test('filesystem manager: equal filenames and AGENTS stay isolated across alternating sources', async t => {
  const f = fixture(t, {
    [A + '\\AGENTS.md']: { text: 'only source A rules\n' }, [B + '\\AGENTS.md']: { text: 'only source B rules\n' },
    [A + '\\same.log']: { text: 'A'.repeat(8000) }, [B + '\\same.log']: { text: 'B'.repeat(8000) },
  });
  try {
    const firstA = success(await f.execute(call('fs_read', readArgs(A + '\\same.log'))));
    const firstB = success(await f.execute(call('fs_read', readArgs(B + '\\same.log'))));
    assert.equal(firstA.phase, 'rules'); assert.equal(firstB.phase, 'rules');
    assert.notEqual(firstA.source?.sourceId, firstB.source?.sourceId);
    assert.equal(firstA.rules[0]?.sourceRef?.sourceId, firstA.source?.sourceId); assert.equal(firstB.rules[0]?.sourceRef?.sourceId, firstB.source?.sourceId);
    assert.ok(firstA.nextArguments && firstB.nextArguments);
    const a = await pages(f, call(firstA.nextArguments.toolName, firstA.nextArguments.arguments), 'read');
    const b = await pages(f, call(firstB.nextArguments.toolName, firstB.nextArguments.arguments), 'read');
    assert.equal(readText(a), 'A'.repeat(8000)); assert.equal(readText(b), 'B'.repeat(8000));
    assert.notEqual(readCitation(a).fileId, readCitation(b).fileId); assert.notEqual(readCitation(a).version, readCitation(b).version);
    assert.equal(new Set(f.rules.filter(r => r.state === 'loaded').map(r => r.sourceRef?.sourceId)).size, 2);
    assert.deepEqual(f.m.seen.listed, []);
  } finally { await f.close(); }
});
test('filesystem manager: direct single-file search follows issued nextArguments with zero parent enumeration', async t => {
  const file = B + '\\single.out', text = Array.from({ length: 24 }, (_, i) => 'needle ' + i).join('\n');
  const f = fixture(t, { [file]: { text }, [B + '\\neighbor.out']: { text: 'needle must not enter scope' } });
  try {
    const values = await pages(f, call('fs_search', searchArgs(file)), 'search');
    assert.ok(values.length > 1); const matches = values.flatMap(v => v.kind === 'search' ? v.matches : []);
    assert.equal(matches.length, 24); assert.equal(new Set(matches.map(m => m.match.start.line)).size, 24);
    const ids = new Set(matches.map(m => m.fileId)); assert.equal(ids.size, 1);
    for (const value of values) {
      assert.equal(value.coverage.scope.kind, 'windows_filesystem');
      if (value.coverage.scope.kind === 'windows_filesystem') assert.equal(value.coverage.scope.absoluteDirectory, file);
      if (value.nextArguments) { assert.equal(value.nextArguments.toolName, 'fs_search'); if (value.nextArguments.toolName === 'fs_search') { assert.equal(value.nextArguments.arguments.path, null); assert.equal(value.nextArguments.arguments.directoryId, null); assert.ok(ids.has(value.nextArguments.arguments.fileId!)); } }
    }
    assert.deepEqual(f.m.seen.listed, []); assert.ok(f.m.seen.opened.every(name => name === file));
  } finally { await f.close(); }
});
test('filesystem manager: issued single-file refresh gets a new identity without changing another source', async t => {
  const file = A + '\\same.log', other = B + '\\same.log';
  const f = fixture(t, { [file]: { text: 'old needle', ino: 101n }, [other]: { text: 'other needle', ino: 201n } });
  try {
    const oldA = readCitation(await pages(f, call('fs_read', readArgs(file)), 'read'));
    const oldB = readCitation(await pages(f, call('fs_read', readArgs(other)), 'read'));
    f.m.rows[file] = { text: 'fresh needle', ino: 102n, mtime: 2n };
    const refreshed = await pages(f, call('fs_search', searchArgs(null, oldA.fileId, true, 'fresh')), 'search');
    const match = refreshed.flatMap(v => v.kind === 'search' ? v.matches : [])[0]; assert.ok(match);
    assert.notEqual(match.fileId, oldA.fileId); assert.notEqual(match.version, oldA.version);
    failure(await f.execute(call('fs_read', readArgs(null, oldA.fileId))), 'CURSOR_STALE');
    const stillB = readCitation(await pages(f, call('fs_read', readArgs(null, oldB.fileId)), 'read'));
    assert.equal(stillB.fileId, oldB.fileId); assert.equal(stillB.location?.sourceId, oldB.location?.sourceId);
    assert.deepEqual(f.m.seen.listed, []);
  } finally { await f.close(); }
});
test('filesystem manager: directory refresh routes its new root ID through all next pages', async t => {
  const rows: Record<string, Row> = { [B + '\\other.txt']: { text: 'b' } };
  for (let i = 0; i < 75; i++) rows[A + '\\entry-' + i + '.log'] = { text: 'a' };
  const f = fixture(t, rows);
  try {
    const first = success(await f.execute(call('fs_list', listArgs(A)))), rootId = first.coverage.scope.directoryId;
    assert.ok(rootId && first.nextArguments);
    const other = success(await f.execute(call('fs_list', listArgs(B))));
    const refreshed = await pages(f, call('fs_list', listArgs(null, rootId, true)), 'list');
    const newRootId = refreshed[0]!.coverage.scope.directoryId; assert.ok(newRootId); assert.notEqual(newRootId, rootId);
    const names = refreshed.flatMap(v => v.kind === 'list' ? v.entries.map(e => e.name) : []);
    assert.equal(names.length, 75); assert.equal(new Set(names).size, 75);
    assert.ok(refreshed.every(v => v.coverage.scope.directoryId === newRootId));
    failure(await f.execute(call(first.nextArguments.toolName, first.nextArguments.arguments)), 'CURSOR_STALE');
    const otherAgain = success(await f.execute(call('fs_list', listArgs(null, other.coverage.scope.directoryId))));
    assert.equal(otherAgain.coverage.scope.directoryId, other.coverage.scope.directoryId);
  } finally { await f.close(); }
});
test('filesystem manager: missing, type, private-root and root OS errors stay distinct', async t => {
  const file = B + '\\notes.log', privateFile = B + '\\actual-store\\record.json', deniedDirectory = base + '\\denied';
  const f = fixture(t, { [file]: { text: 'plain' }, [privateFile]: { text: 'synthetic private' }, [deniedDirectory]: { directory: true, directoryError: 'EACCES' } }, { protectedRoots: [B + '\\actual-store'] });
  try {
    failure(await f.execute(call('fs_read', readArgs(B + '\\missing.log'))), 'PATH_NOT_FOUND', 'ENOENT');
    failure(await f.execute(call('fs_read', readArgs(B))), 'NOT_A_FILE');
    failure(await f.execute(call('fs_list', listArgs(file))), 'NOT_A_DIRECTORY');
    failure(await f.execute(call('fs_read', readArgs(privateFile))), 'PATH_POLICY_DENIED');
    failure(await f.execute(call('fs_list', listArgs(deniedDirectory))), 'ACCESS_DENIED', 'EACCES');
    assert.equal(f.m.seen.opened.includes(privateFile), false); assert.equal(f.m.seen.metadata.includes(privateFile), false);
  } finally { await f.close(); }
});
test('filesystem manager: candidate quota is shared across two distinct sources', async t => {
  const indexQuota = { indexBytes: 0, visitedCandidates: L.runCandidates - 1 };
  const f = fixture(t, { [A + '\\a.log']: { text: 'a' }, [B + '\\b.log']: { text: 'b' } }, { indexQuota });
  try {
    await pages(f, call('fs_read', readArgs(A + '\\a.log')), 'read'); assert.equal(indexQuota.visitedCandidates, L.runCandidates);
    failure(await f.execute(call('fs_read', readArgs(B + '\\b.log'))), 'SCOPE_LIMIT');
    assert.equal(indexQuota.visitedCandidates, L.runCandidates);
  } finally { await f.close(); }
  assert.equal(indexQuota.indexBytes, 0);
});
test('filesystem manager: physical read budget cannot restart when source changes', async t => {
  const f = fixture(t, { [A + '\\a.log']: { text: 'a'.repeat(48) }, [B + '\\b.log']: { text: 'b'.repeat(48) } }, { ioBytes: 128 });
  try {
    await pages(f, call('fs_read', readArgs(A + '\\a.log')), 'read'); assert.equal(f.budget.evidence().physicalReadBytes, 96);
    failure(await f.execute(call('fs_read', readArgs(B + '\\b.log'))), 'BUDGET_EXCEEDED');
    assert.equal(f.budget.evidence().physicalReadBytes, 128); assert.equal(f.budget.remaining(), 0);
  } finally { await f.close(); }
});
test('filesystem manager: citation capacity and index memory capacity are shared', async t => {
  const quota = { toolAttempts: 0, toolBytes: 0, citations: L.citations - 1 }, indexQuota = { indexBytes: 0, visitedCandidates: 0 };
  const f = fixture(t, { [A + '\\a.log']: { text: 'a' }, [B + '\\b.log']: { text: 'b' } }, { quota, indexQuota });
  try {
    await pages(f, call('fs_read', readArgs(A + '\\a.log')), 'read'); assert.equal(quota.citations, L.citations);
    failure(await f.execute(call('fs_read', readArgs(B + '\\b.log'))), 'BUDGET_EXCEEDED'); assert.equal(quota.citations, L.citations);
    assert.ok(indexQuota.indexBytes > 0);
  } finally { await f.close(); }
  assert.equal(indexQuota.indexBytes, 0);
});
test('filesystem manager: a precharged index ceiling cannot reset through fresh sources', async t => {
  const indexQuota = { indexBytes: L.indexBytes - 100, visitedCandidates: 0 };
  const f = fixture(t, { [A + '\\a.log']: { text: 'a' }, [B + '\\b.log']: { text: 'b' } }, { indexQuota });
  try {
    failure(await f.execute(call('fs_list', listArgs(A))), 'SCOPE_LIMIT');
    failure(await f.execute(call('fs_list', listArgs(B))), 'SCOPE_LIMIT');
    assert.equal(indexQuota.indexBytes, L.indexBytes - 100);
  } finally { await f.close(); }
  assert.equal(indexQuota.indexBytes, L.indexBytes - 100);
});
