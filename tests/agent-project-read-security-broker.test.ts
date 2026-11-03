import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import asyncFs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { captureFolderRoot } from '../apps/desktop/src/main/cloud/project-folder-files';
import { createProjectReadIoBudget, ProjectReadFsError } from '../apps/desktop/src/main/cloud/project-read-files';
import { createProjectReadIndex } from '../apps/desktop/src/main/cloud/project-read-index';
import { createProjectReadBroker, type ProjectReadPublication } from '../apps/desktop/src/main/cloud/project-read-broker';
import type { ProjectReadRef, ProjectReadRule, ProjectReadToolArguments, ProjectReadToolCall, ProjectReadToolName, ProjectReadToolResult, ProjectReadToolValue } from '../apps/desktop/src/shared/agent/agent-project-read';

const product = path.resolve('C:/work/analog_ai_workbench');
const parent = path.join(product, '.local/quality-evidence/20260911-agent-project-read-security-01/fixtures');
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const code = (value: string) => (error: unknown) => error instanceof ProjectReadFsError && error.code === value;
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const wireBytes = (publication: ProjectReadPublication) => Buffer.byteLength(JSON.stringify({ model: 'synthetic', messages: [{ role: 'tool', tool_call_id: publication.call.callId, content: JSON.stringify(publication.result) }] }));
type Hooks = { publishRule?: (rule: ProjectReadRule) => Promise<void>; install?: (rule: ProjectReadRule) => Promise<void>; publish?: (publication: ProjectReadPublication) => Promise<void>; canDeliver?: (publication: ProjectReadPublication) => boolean; authorize?: (call: ProjectReadToolCall) => boolean };
function call<M extends ProjectReadToolName>(toolName: M, arguments_: ProjectReadToolArguments[M], callId: string = randomUUID()): ProjectReadToolCall {
  return { sessionId: 'security-owned-session', messageId: 'message-' + callId, callId, toolName, arguments: arguments_ } as ProjectReadToolCall;
}
function value(result: ProjectReadToolResult): ProjectReadToolValue { assert.ok(result.ok, JSON.stringify(result)); return result.value; }
function under(target: string, base: string): string { const absolute = path.resolve(target), relative = path.relative(base, absolute); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); return absolute; }
function noLinks(target: string): void { let at = path.parse(target).root; for (const part of target.slice(at.length).split(path.sep)) { at = path.join(at, part); if (fs.existsSync(at)) assert.equal(fs.lstatSync(at).isSymbolicLink(), false); } }
async function fixture(body: (f: {
  base: string; write(name: string, text: string): void; broker: ReturnType<typeof createProjectReadBroker>; abort: AbortController;
  published: ProjectReadPublication[]; ruleRecords: ProjectReadRule[]; installed: ProjectReadRule[]; opens: string[];
  locate(): Promise<string>;
}) => Promise<void>, hooks: Hooks = {}) {
  assert.equal(path.resolve(process.cwd()).toLowerCase(), product.toLowerCase()); noLinks(parent);
  const base = under(path.join(parent, randomUUID()), parent); assert.equal(fs.existsSync(base), false); fs.mkdirSync(base, { recursive: true });
  const root = captureFolderRoot(randomUUID(), randomUUID(), base), abort = new AbortController(), runId = randomUUID();
  const project: ProjectReadRef = { projectId: root.projectId, bindingId: root.bindingId, name: 'Independent synthetic security', directoryName: 'synthetic', directorySegments: ['synthetic'], identity: sha(JSON.stringify(root.chain)) };
  const index = createProjectReadIndex({ root, identity: project.identity, owner: { kind: 'run', id: runId }, signal: abort.signal });
  const budget = createProjectReadIoBudget(), published: ProjectReadPublication[] = [], ruleRecords: ProjectReadRule[] = [], installed: ProjectReadRule[] = [], opens: string[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(asyncFs, 'open')!, originalOpen = asyncFs.open;
  Object.defineProperty(asyncFs, 'open', { ...descriptor, value: async (...parameters: Parameters<typeof asyncFs.open>) => { opens.push(under(String(parameters[0]), base)); return originalOpen(...parameters); } });
  const broker = createProjectReadBroker({ root, project, runId, signal: abort.signal, budget, index,
    authorize: request => request.sessionId === 'security-owned-session' && (hooks.authorize?.(request) ?? true),
    publishRule: async rule => { await hooks.publishRule?.(rule); ruleRecords.push(rule); },
    installRootRule: async rule => { assert.ok(ruleRecords.some(record => JSON.stringify(record) === JSON.stringify(rule))); await hooks.install?.(rule); installed.push(rule); },
    canDeliver: publication => hooks.canDeliver?.(publication) ?? true,
    publish: async publication => {
      assert.equal(publication.citations.length, publication.locators.length);
      for (const citation of publication.citations) {
        assert.equal(citation.runId, runId); assert.deepEqual(citation.project, project); assert.equal(citation.origin, null); assert.equal(citation.excerptSha256, sha(citation.excerpt));
        const locator = publication.locators.find(item => item.citationId === citation.citationId); assert.ok(locator);
        assert.equal(locator.file.fileIdentity, citation.fileIdentity); assert.equal(locator.file.relativePath, citation.relativePath); under(locator.file.absolutePath, base);
      }
      await hooks.publish?.(publication); published.push(publication);
    },
  });
  try { await body({ base, abort, broker, published, ruleRecords, installed, opens,
    write(name, contents) { const target = under(path.join(base, name), base); noLinks(path.dirname(target)); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, contents); },
    async locate() { const found = value(await broker.execute(call('project_find', { directoryId: null, query: 'document.txt', cursor: null, refresh: false }))); assert.equal(found.kind, 'find'); if (found.kind !== 'find') return assert.fail('find'); assert.equal(found.entries.length, 1); return found.entries[0]!.fileId!; },
  }); }
  finally {
    abort.abort(); try { await broker.close(); } finally {
      Object.defineProperty(asyncFs, 'open', descriptor); const resolved = fs.realpathSync.native(base); assert.equal(resolved.toLowerCase(), base.toLowerCase()); under(resolved, parent); noLinks(resolved); assert.match(path.basename(resolved), /^[0-9a-f-]{36}$/u); fs.rmSync(resolved, { recursive: true });
    }
  }
}
const readArgs = (fileId: string): ProjectReadToolArguments['project_read'] => ({ fileId, version: null, start: { line: 1, column: 1 }, cursor: null });

test('independent broker inherited state: verified rules precede new data and inherited citations consume the same fixed quota', async t => {
  await t.test('verified-record-and-phase', async () => fixture(async f => {
    const text = 'Scoped synthetic rule 甲🙂\\"\n'.repeat(140), rule: ProjectReadRule = { source: 'chapter/AGENTS.md', relativeDirectory: 'chapter', state: 'loaded', version: sha(text), normalizedSha256: sha(text), text };
    f.write('chapter/AGENTS.md', text); f.write('chapter/document.txt', 'new synthetic evidence');
    assert.throws(() => f.broker.acceptContinuationState({ citationCount: 8, rules: [] }), code('INVALID_REQUEST'));
    await f.broker.prepare();
    assert.throws(() => f.broker.acceptContinuationState({ citationCount: 8, rules: [rule] }), code('RULES_UNAVAILABLE'));
    const verified = await f.broker.verifyRules([rule]); assert.deepEqual(verified, [rule]);
    assert.throws(() => f.broker.acceptContinuationState({ citationCount: 8, rules: [{ ...rule, text: text + 'changed' }] }), code('RULES_UNAVAILABLE'));
    for (const count of [-1, 9, Number.NaN]) assert.throws(() => f.broker.acceptContinuationState({ citationCount: count, rules: verified }), code('INVALID_REQUEST'));
    assert.equal(f.broker.accounting().citations, 0); assert.equal(f.opens.some(file => path.basename(file) === 'document.txt'), false);
    f.broker.acceptContinuationState({ citationCount: 8, rules: verified }); assert.equal(f.broker.accounting().citations, 8);
    const output = value(await f.broker.execute(call('project_read', readArgs(await f.locate())))); assert.equal(output.kind, 'read'); if (output.kind !== 'read') return assert.fail('read');
    assert.equal(output.phase, 'data'); assert.deepEqual(output.rules, []); assert.equal(output.citation?.excerpt, 'new synthetic evidence'); assert.equal(f.broker.accounting().citations, 9);
    assert.throws(() => f.broker.acceptContinuationState({ citationCount: 0, rules: verified }), code('INVALID_REQUEST')); assert.equal(f.broker.accounting().citations, 9);
  }));
  await t.test('eight-inherited-plus-fifty-six-new', async () => fixture(async f => {
    f.write('document.txt', Array.from({ length: 70 }, (_, i) => 'needle-' + i).join('\n')); await f.broker.prepare();
    f.broker.acceptContinuationState({ citationCount: 8, rules: [] });
    let args: ProjectReadToolArguments['project_search'] = { directoryId: null, cursor: null, refresh: false, query: 'needle' }, final: ProjectReadToolResult | null = null;
    for (let i = 0; i < 32; i++) {
      final = await f.broker.execute(call('project_search', args));
      if (!final.ok) break; assert.equal(final.value.kind, 'search'); if (final.value.kind !== 'search') return assert.fail('search');
      assert.equal(final.value.coverage.complete, false); assert.ok(final.value.coverage.nextCursor); args = { ...args, cursor: final.value.coverage.nextCursor };
    }
    assert.ok(final && !final.ok); if (final && !final.ok) assert.equal(final.error.code, 'BUDGET_EXCEEDED');
    assert.equal(f.published.reduce((total, publication) => total + publication.citations.length, 0), 56); assert.equal(f.broker.accounting().citations, 64);
    const before = f.opens.length; assert.throws(() => f.broker.acceptContinuationState({ citationCount: 0, rules: [] }), code('INVALID_REQUEST'));
    const denied = await f.broker.execute(call('project_search', args)); assert.equal(denied.ok, false); assert.equal(f.broker.accounting().citations, 64); assert.equal(f.opens.length, before);
  }));
  await t.test('changed-accepted-rule-still-rejects-content', async () => fixture(async f => {
    const text = 'Original scoped rule', rule: ProjectReadRule = { source: 'chapter/AGENTS.md', relativeDirectory: 'chapter', state: 'loaded', version: sha(text), normalizedSha256: sha(text), text };
    f.write('chapter/AGENTS.md', text); f.write('chapter/document.txt', 'Must not reach model'); await f.broker.prepare();
    const verified = await f.broker.verifyRules([rule]); f.broker.acceptContinuationState({ citationCount: 8, rules: verified });
    const fileId = await f.locate(); f.write('chapter/AGENTS.md', 'Modified scoped rule');
    const denied = await f.broker.execute(call('project_read', readArgs(fileId))); assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.error.code, 'SOURCE_CHANGED');
    assert.equal(f.opens.some(file => path.basename(file) === 'document.txt'), false); assert.equal(f.broker.accounting().citations, 8); assert.equal(f.published.flatMap(publication => publication.citations).length, 0);
  }));
});

function nextRead(previous: ProjectReadToolArguments['project_read'], result: Extract<ProjectReadToolValue, { kind: 'read' }>): ProjectReadToolArguments['project_read'] {
  assert.ok(result.next && result.coverage.nextCursor); return { fileId: previous.fileId, version: result.citation?.version ?? result.resume?.version ?? previous.version, start: result.next, cursor: result.coverage.nextCursor };
}

test('independent broker rules: complete ancestral bytes precede body I/O under actual nested JSON escaping', async t => {
  for (const vector of ['two-7k', 'escaped-8k', 'near-path-limit'] as const) await t.test(vector, async () => {
    let rejectedCandidate = 0;
    const ceiling = vector === 'near-path-limit' ? 10000 : 8192;
    await fixture(async f => {
      const directory = vector === 'near-path-limit' ? Array.from({ length: 8 }, () => '资'.repeat(82)).join('/') : 'chapter/section';
      const expected = vector === 'two-7k'
        ? new Map([['chapter/AGENTS.md', '甲🙂"\\'.repeat(796) + 'abcd'], ['chapter/section/AGENTS.md', '次'.repeat(2389) + 'x']])
        : new Map([[directory + '/AGENTS.md', '"\\'.repeat(4096)]]);
      for (const [source, rule] of expected) { assert.equal(Buffer.byteLength(rule), vector === 'two-7k' ? 7168 : 8192); f.write(source, rule); }
      if (vector === 'near-path-limit') assert.ok(Buffer.byteLength(directory + '/AGENTS.md') >= 1980 && Buffer.byteLength(directory + '/AGENTS.md') <= 2048);
      const raw = 'BEGIN ' + '🙂"\\'.repeat(1200) + ' END\r\n'; f.write(directory + '/document.txt', raw);
      await f.broker.prepare(); assert.equal(f.installed[0]?.state, 'absent');
      let request = readArgs(await f.locate()), finished = false, startedData = false, collected = '';
      const chunks = new Map<string, { text: string; id: string; done: boolean }>();
      for (let page = 0; page < 40; page++) {
        const output = value(await f.broker.execute(call('project_read', request))); assert.equal(output.kind, 'read'); if (output.kind !== 'read') return assert.fail('read');
        if (output.phase === 'rules') {
          assert.equal(startedData, false); assert.equal(output.citation, null); assert.equal(output.empty, false); assert.equal(output.coverage.returned, 0);
          assert.equal(f.opens.some(file => file.endsWith(path.sep + 'document.txt')), false, 'rules must complete before ordinary body I/O');
          assert.equal(output.rules.length, 1);
          for (const chunk of output.rules) {
            const prior = chunks.get(chunk.source) ?? { text: '', id: chunk.ruleId, done: false };
            assert.equal(prior.id, chunk.ruleId); assert.equal(prior.done, false); assert.equal(chunk.offsetBytes, Buffer.byteLength(prior.text));
            assert.equal(chunk.endBytes - chunk.offsetBytes, Buffer.byteLength(chunk.text)); assert.ok(chunk.endBytes > chunk.offsetBytes); assert.ok(Buffer.byteLength(chunk.text) <= 4096);
            const original = expected.get(chunk.source); assert.ok(original); assert.equal(chunk.totalBytes, Buffer.byteLength(original)); assert.equal(chunk.version, sha(original)); assert.equal(chunk.normalizedSha256, sha(original));
            assert.ok(f.ruleRecords.some(rule => rule.source === chunk.source && rule.text === original));
            chunks.set(chunk.source, { text: prior.text + chunk.text, id: prior.id, done: chunk.complete });
          }
        } else {
          startedData = true; for (const [source, original] of expected) { assert.equal(chunks.get(source)?.text, original); assert.equal(chunks.get(source)?.done, true); }
          if (output.citation) { collected += output.citation.excerpt; assert.equal(output.citation.version, sha(raw)); assert.equal(output.citation.normalizedSha256, sha(raw.replace(/\r\n/g, '\n'))); }
        }
        if (output.coverage.complete) { finished = true; break; }
        request = nextRead(request, output);
      }
      assert.equal(finished, true); assert.equal(collected, raw.replace(/\r\n/g, '\n')); assert.ok(rejectedCandidate > 0, 'test must force a smaller escaped result');
      for (const publication of f.published) { assert.ok(wireBytes(publication) <= ceiling); assert.ok(Buffer.byteLength(JSON.stringify(publication.result)) <= 12288); }
    }, { canDeliver: publication => { const fits = wireBytes(publication) <= ceiling; if (!fits) rejectedCandidate++; return fits; } });
  });
});

test('independent broker established version: null or mismatched continuation fields cannot replace the signed next request', async () => {
  await fixture(async f => {
    f.write('document.txt', 'verified source '.repeat(1200)); await f.broker.prepare();
    const firstArgs = readArgs(await f.locate()), first = value(await f.broker.execute(call('project_read', firstArgs)));
    assert.equal(first.kind, 'read'); if (first.kind !== 'read') return assert.fail('read'); assert.ok(first.citation && !first.coverage.complete);
    const next = nextRead(firstArgs, first), before = f.published.flatMap(item => item.citations).length;
    for (const bad of [{ ...next, version: null }, { ...next, version: '0'.repeat(64) }, { ...next, start: { line: 1, column: 1 } }, { ...next, fileId: 'foreign-file' }]) {
      try { const result = await f.broker.execute(call('project_read', bad)); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'CURSOR_STALE'); }
      catch (error) { assert.ok(error instanceof ProjectReadFsError); assert.equal(error.code, 'INVALID_REQUEST'); }
      assert.equal(f.published.flatMap(item => item.citations).length, before);
    }
    const valid = value(await f.broker.execute(call('project_read', next))); assert.equal(valid.kind, 'read'); if (valid.kind !== 'read') return assert.fail('read');
    assert.equal(valid.citation?.range.start.column, next.start.column); assert.equal(valid.citation?.version, first.citation.version);
  });
});

test('independent broker preparation: root rule durability and installation precede tool admission', async () => {
  const entered = gate(), released = gate();
  await fixture(async f => {
    f.write('AGENTS.md', 'root scope synthetic rule'); f.write('document.txt', 'body');
    const work = f.broker.prepare();
    try {
      await Promise.race([entered.promise, work.then(() => assert.fail('prepare bypassed durable gate'))]);
      assert.equal(f.installed.length, 0); assert.equal(f.ruleRecords.length, 0);
      await assert.rejects(f.broker.execute(call('pilot_sum', { values: [2, 3] })), code('CAPABILITY_DENIED'));
      released.release(); await work; assert.equal(f.ruleRecords.length, 1); assert.equal(f.installed.length, 1); assert.equal(f.installed[0]?.text, 'root scope synthetic rule');
      assert.equal(value(await f.broker.execute(call('pilot_sum', { values: [2, 3] }))).kind, 'sum');
    } finally { released.release(); await work.catch(() => {}); }
  }, { publishRule: async () => { entered.release(); await released.promise; } });
});

test('independent broker root persistence failure leaves tools unprepared', async () => {
  await fixture(async f => {
    f.write('AGENTS.md', 'synthetic rule'); f.write('document.txt', 'body');
    await assert.rejects(f.broker.prepare(), code('STORAGE_FAILED'));
    assert.equal(f.ruleRecords.length, 0); assert.equal(f.installed.length, 0); assert.equal(f.published.length, 0);
    await assert.rejects(f.broker.execute(call('project_list', { directoryId: null, cursor: null, refresh: false })), code('CAPABILITY_DENIED'));
    assert.equal(f.opens.some(file => file.endsWith('document.txt')), false);
  }, { publishRule: async () => { throw new Error('synthetic durable rule write failed'); } });
});

test('independent broker changed local rule: subsequent chunks and data stop at the recorded version', async () => {
  await fixture(async f => {
    const original = 'q'.repeat(8192); f.write('scope/AGENTS.md', original); f.write('scope/document.txt', 'body'); await f.broker.prepare();
    const firstArgs = readArgs(await f.locate()), first = value(await f.broker.execute(call('project_read', firstArgs)));
    assert.equal(first.kind, 'read'); if (first.kind !== 'read') return assert.fail('read'); assert.equal(first.phase, 'rules');
    f.write('scope/AGENTS.md', 'r'.repeat(8192));
    const result = await f.broker.execute(call('project_read', nextRead(firstArgs, first)));
    assert.deepEqual(result, { ok: false, error: { code: 'SOURCE_CHANGED' }, coverage: null });
    assert.equal(f.published.flatMap(item => item.citations).length, 0); assert.equal(f.opens.some(file => file.endsWith('document.txt')), false);
  });
});

test('independent broker durable citation: concurrent callID reuse commits once and preserves admission boundaries', async () => {
  const entered = gate(), released = gate(); let allowed = true, waiting: ProjectReadPublication | undefined;
  await fixture(async f => {
    f.write('document.txt', 'a verified synthetic answer'); await f.broker.prepare(); const request = call('project_read', readArgs(await f.locate()));
    const before = f.broker.accounting(), work = f.broker.execute(request), duplicate = f.broker.execute(request); assert.equal(work, duplicate);
    try {
      await Promise.race([entered.promise, work.then(() => assert.fail('citation returned before durable publication'))]);
      assert.ok(waiting?.citations.length === 1 && waiting.locators.length === 1); assert.equal(f.published.length, 1);
      assert.equal(f.broker.accounting().citations, before.citations); assert.equal(f.broker.accounting().toolBytes, before.toolBytes);
      await assert.rejects(f.broker.execute({ ...request, messageId: 'changed-message' }), code('CONFLICT'));
      await assert.rejects(f.broker.execute(call('pilot_sum', { values: [1] })), code('BUSY'));
      released.release(); const result = await work; assert.equal(result.ok, true); const after = f.broker.accounting();
      assert.equal(after.citations, 1); assert.equal(f.published.length, 2); assert.equal(await f.broker.execute(request), result); assert.deepEqual(f.broker.accounting(), after);
      assert.equal(f.published.length, 2); allowed = false; await assert.rejects(f.broker.execute(request), code('CAPABILITY_DENIED')); allowed = true;
      f.abort.abort(); await assert.rejects(f.broker.execute(request), code('CANCELLED'));
    } finally { released.release(); await work.catch(() => {}); }
  }, { authorize: () => allowed, publish: async publication => { if (publication.citations.length) { waiting = publication; entered.release(); await released.promise; } } });
});

test('independent broker cancel at publication: a persisted late citation is never returned as a successful tool result', async () => {
  const entered = gate(), released = gate();
  await fixture(async f => {
    f.write('document.txt', 'bounded synthetic evidence'); await f.broker.prepare(); const request = call('project_read', readArgs(await f.locate()));
    const work = f.broker.execute(request);
    try {
      await Promise.race([entered.promise, work.then(() => assert.fail('result bypassed cancellation gate'))]);
      f.abort.abort(); released.release(); await assert.rejects(work, code('CANCELLED'));
      assert.equal(f.broker.accounting().citations, 0); assert.equal(f.published.flatMap(item => item.citations).length, 1, 'durability callback may finish after cancellation');
      const attempts = f.broker.accounting().toolAttempts; await assert.rejects(f.broker.execute(request), code('CANCELLED')); assert.equal(f.broker.accounting().toolAttempts, attempts);
    } finally { released.release(); await work.catch(() => {}); }
  }, { publish: async publication => { if (publication.citations.length) { entered.release(); await released.promise; } } });
});

test('independent broker publication failures: denied escaped context and failed storage cannot return evidence', async t => {
  for (const failure of ['context', 'storage'] as const) await t.test(failure, async () => {
    await fixture(async f => {
      f.write('document.txt', 'a small synthetic document'); await f.broker.prepare(); const request = call('project_read', readArgs(await f.locate()));
      if (failure === 'storage') await assert.rejects(f.broker.execute(request), code('STORAGE_FAILED'));
      else assert.deepEqual(await f.broker.execute(request), { ok: false, error: { code: 'BUDGET_EXCEEDED' }, coverage: null });
      assert.equal(f.published.flatMap(item => item.citations).length, 0); assert.equal(f.broker.accounting().citations, 0); assert.ok(f.broker.accounting().physicalReadBytes > 0);
    }, { canDeliver: publication => failure !== 'context' || publication.citations.length === 0, publish: async publication => { if (failure === 'storage' && publication.citations.length) throw new Error('synthetic store failure'); } });
  });
});

test('independent broker rule limits: single-file and combined raw ceilings stop ordinary content', async t => {
  await t.test('single-root', async () => {
    await fixture(async f => { f.write('AGENTS.md', 'x'.repeat(8193)); f.write('document.txt', 'body'); await assert.rejects(f.broker.prepare(), code('RULES_LIMIT')); assert.equal(f.opens.length, 0); assert.equal(f.installed.length, 0); });
  });
  await t.test('combined-ancestors', async () => {
    await fixture(async f => {
      f.write('AGENTS.md', 'x'); f.write('a/AGENTS.md', 'x'.repeat(8192)); f.write('a/b/AGENTS.md', 'y'.repeat(8192)); f.write('a/b/document.txt', 'body');
      await f.broker.prepare(); const result = await f.broker.execute(call('project_read', readArgs(await f.locate())));
      assert.deepEqual(result, { ok: false, error: { code: 'RULES_LIMIT' }, coverage: null }); assert.equal(f.opens.some(file => file.endsWith('document.txt')), false); assert.equal(f.published.flatMap(item => item.citations).length, 0);
    });
  });
});

test('independent broker index error bridge: omitted deep scope keeps partial coverage on the published tool failure', async () => {
  await fixture(async f => {
    const directory = Array.from({ length: 25 }, (_, n) => 'd' + n).join('/'); f.write(directory + '/document.txt', 'late-target'); await f.broker.prepare();
    const result = await f.broker.execute(call('project_search', { directoryId: null, query: 'late-target', cursor: null, refresh: false }));
    assert.equal(result.ok, false); if (result.ok) return assert.fail('partial failure expected'); assert.equal(result.error.code, 'SCOPE_LIMIT'); assert.ok(result.coverage);
    assert.equal(result.coverage.complete, false); assert.equal(result.coverage.limitReason, 'scope'); assert.ok(result.coverage.remaining.directories! > 0);
    assert.equal(result.coverage.scannedFiles, 0); assert.equal(result.coverage.scannedBytes, 0); assert.equal(f.published.length, 1); assert.deepEqual(f.published[0]?.result, result);
  });
});
