import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeProjectText, pageProjectText, searchProjectText, ProjectTextError, type ProjectTextPosition } from '../packages/agent-adapters/src/project-read-text';

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: string) => decodeProjectText(encode(value), { maxBytes: 16 * 1024 * 1024, maxLines: 500000 });
const code = (expected: string) => (error: unknown) => error instanceof ProjectTextError && error.code === expected;

test('project text preserves normalized lines and the trailing empty line while rejecting malformed or binary bytes', () => {
  const source = decode('\ufeff甲\r\n乙\r丙\n');
  assert.equal(source.text, '甲\n乙\n丙\n'); assert.equal(source.totalLines, 4);
  assert.deepEqual(source.lineStarts, [0, 2, 4, 6]);
  assert.throws(() => decodeProjectText(new Uint8Array([0xc0, 0xaf]), { maxBytes: 10, maxLines: 2 }), code('UNSUPPORTED_ENCODING'));
  assert.throws(() => decode('hello\u0000world'), code('UNSUPPORTED_TEXT'));
  assert.throws(() => decodeProjectText(encode('abcd'), { maxBytes: 3, maxLines: 1 }), code('FILE_LIMIT'));
  assert.throws(() => decodeProjectText(encode('a\nb\n'), { maxBytes: 10, maxLines: 2 }), code('FILE_LIMIT'));
});

test('project text pages reconstruct Unicode and long lines without dropping a scalar or inventing a line', () => {
  const original = '甲🙂乙\n' + '🙂长'.repeat(9000) + '\n末尾\n', source = decode(original);
  let next: ProjectTextPosition | null = { line: 1, column: 1 }, result = '', pages = 0;
  while (next) {
    const current: ProjectTextPosition = next;
    const page = pageProjectText(source, current, { maxBytes: 17, maxLines: 2 });
    assert.ok(page.bytes <= 17); assert.equal(page.bytes, encode(page.text).byteLength);
    assert.equal(page.text.includes('\ufffd'), false); assert.deepEqual(page.range.start, current);
    result += page.text; next = page.next; pages++;
    if (next) assert.ok(next.line > current.line || next.line === current.line && next.column > current.column);
  }
  assert.equal(result, original); assert.ok(pages > 1000);
  assert.deepEqual(pageProjectText(source, { line: 1, column: 2 }, { maxBytes: 4, maxLines: 1 }).range.end, { line: 1, column: 3 });
  assert.throws(() => pageProjectText(source, { line: 1, column: 5 }, { maxBytes: 8, maxLines: 1 }), code('INVALID_REQUEST'));
});

test('project text line pages retain empty documents and final blank lines as explicit positions', () => {
  const empty = pageProjectText(decode(''), { line: 1, column: 1 }, { maxBytes: 4, maxLines: 1 });
  assert.equal(empty.text, ''); assert.equal(empty.complete, true); assert.equal(empty.next, null);
  const source = decode('one\n\nthree\n');
  const first = pageProjectText(source, { line: 1, column: 1 }, { maxBytes: 1024, maxLines: 2 });
  assert.equal(first.text, 'one\n\n'); assert.deepEqual(first.next, { line: 3, column: 1 });
  const last = pageProjectText(source, first.next!, { maxBytes: 1024, maxLines: 1 });
  assert.equal(last.text, 'three\n'); assert.deepEqual(last.range.end, { line: 4, column: 1 }); assert.equal(last.complete, true);
});

test('project literal search returns actual Unicode columns and cannot turn partial no-match into complete absence', () => {
  const source = decode('nothing\n🙂甲 target 甲 target\nlast');
  const initial = searchProjectText(source, 'target', { line: 1, column: 1 }, { maxMatches: 1, maxLines: 1, contextPoints: 2 });
  assert.equal(initial.matches.length, 0); assert.equal(initial.complete, false); assert.deepEqual(initial.next, { line: 2, column: 1 });
  const one = searchProjectText(source, 'target', initial.next!, { maxMatches: 1, maxLines: 1, contextPoints: 2 });
  assert.deepEqual(one.matches[0]!.range, { start: { line: 2, column: 4 }, end: { line: 2, column: 10 } });
  assert.equal(one.matches[0]!.excerpt, '甲 target 甲');
  const two = searchProjectText(source, 'target', one.next!, { maxMatches: 5, maxLines: 3, contextPoints: 0 });
  assert.equal(two.matches.length, 1); assert.deepEqual(two.matches[0]!.range.start, { line: 2, column: 13 }); assert.equal(two.complete, true);
  assert.equal(searchProjectText(source, 'TARGET', { line: 1, column: 1 }, { maxMatches: 5, maxLines: 10, contextPoints: 0 }).matches.length, 0);
  assert.throws(() => searchProjectText(source, 'target\nlast', { line: 1, column: 1 }, { maxMatches: 2, maxLines: 2, contextPoints: 0 }), code('INVALID_REQUEST'));
});

test('project search and fragment read discover a target beyond one MiB and ten thousand lines', () => {
  const ordinary = 'ordinary synthetic source record ' + 'x'.repeat(48);
  const source = decode(Array.from({ length: 16001 }, (_, index) => index === 15000 ? 'verified-late-target: 271828' : ordinary).join('\n'));
  assert.ok(encode(source.text).byteLength > 1024 * 1024); assert.equal(source.totalLines, 16001);
  let next: ProjectTextPosition | null = { line: 1, column: 1 }, pages = 0, found: ProjectTextPosition | undefined;
  while (next) {
    const page = searchProjectText(source, 'verified-late-target', next, { maxMatches: 20, maxLines: 2000, contextPoints: 12 });
    if (page.matches.length) found = page.matches[0]!.range.start;
    next = page.next; pages++;
  }
  assert.deepEqual(found, { line: 15001, column: 1 }); assert.ok(pages > 5);
  const page = pageProjectText(source, found!, { maxBytes: 128, maxLines: 1 });
  assert.equal(page.text, 'verified-late-target: 271828\n'); assert.deepEqual(page.next, { line: 15002, column: 1 });
});
