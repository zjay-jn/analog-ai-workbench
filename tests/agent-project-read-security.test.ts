import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  decodeProjectText, pageProjectText, searchProjectText, projectTextRangeBytes, sliceProjectTextRange, ProjectTextError,
  type ProjectText, type ProjectTextPosition, type ProjectTextRange,
} from '../packages/agent-adapters/src/project-read-text';

// Independent A-12 pure-text evidence only. No filesystem, native, cloud or user data.
const limits = { maxBytes: 16 * 1024 * 1024, maxLines: 500000 };
const bytes = (value: string) => Buffer.from(value, 'utf8');
const text = (value: string) => decodeProjectText(bytes(value), limits);
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const errorCode = (expected: string) => (error: unknown) => error instanceof ProjectTextError && error.code === expected;

// Test oracle: direct scalar arrays, not the product's UTF-16 offsets or line index.
function scalarOffset(value: string, at: ProjectTextPosition): number {
  const lines = value.split('\n').map(line => Array.from(line));
  assert.ok(at.line >= 1 && at.line <= lines.length);
  assert.ok(at.column >= 1 && at.column <= lines[at.line - 1]!.length + 1);
  return lines.slice(0, at.line - 1).reduce((sum, line) => sum + line.length + 1, 0) + at.column - 1;
}
function excerpt(value: string, range: ProjectTextRange): string {
  return Array.from(value).slice(scalarOffset(value, range.start), scalarOffset(value, range.end)).join('');
}

test('project read independent coverage security: examined bytes follow normalized scalar ranges and never count the cached remainder', () => {
  const source = text('\ufeff甲🙂\r\n\r\ne\u0301🙂\r尾\n'), points = Array.from(source.text);
  const positions: ProjectTextPosition[] = [];
  source.text.split('\n').forEach((line, row) => {
    for (let column = 1; column <= Array.from(line).length + 1; column++) positions.push({ line: row + 1, column });
  });
  for (const start of positions) {
    const first = scalarOffset(source.text, start);
    assert.equal(projectTextRangeBytes(source, start, null), bytes(points.slice(first).join('')).length);
    for (const end of positions) {
      const last = scalarOffset(source.text, end);
      if (last < first) {
        assert.throws(() => projectTextRangeBytes(source, start, end), errorCode('INVALID_REQUEST'));
        assert.throws(() => sliceProjectTextRange(source, { start, end }), errorCode('INVALID_REQUEST'));
      } else {
        const expected = points.slice(first, last).join('');
        assert.equal(projectTextRangeBytes(source, start, end), bytes(expected).length);
        assert.equal(sliceProjectTextRange(source, { start, end }), expected);
      }
    }
  }
  for (const invalid of [{ line: 0, column: 1 }, { line: 1, column: 4 }, { line: 6, column: 1 }, { line: 1.5, column: 1 }, { line: 1, column: NaN }]) {
    assert.throws(() => projectTextRangeBytes(source, invalid, null), errorCode('INVALID_REQUEST'));
    assert.throws(() => projectTextRangeBytes(source, { line: 1, column: 1 }, invalid), errorCode('INVALID_REQUEST'));
    assert.throws(() => sliceProjectTextRange(source, { start: invalid, end: { line: 1, column: 1 } }), errorCode('INVALID_REQUEST'));
    assert.throws(() => sliceProjectTextRange(source, { start: { line: 1, column: 1 }, end: invalid }), errorCode('INVALID_REQUEST'));
  }
  for (const query of ['🙂', 'absent']) {
    let cursor: ProjectTextPosition | null = { line: 1, column: 1 }, examined = 0, pages = 0;
    while (cursor) {
      const page = searchProjectText(source, query, cursor, { maxMatches: 1, maxLines: 1, contextPoints: 0 });
      const actual = projectTextRangeBytes(source, cursor, page.next);
      const end = page.next === null ? points.length : scalarOffset(source.text, page.next);
      assert.equal(actual, bytes(points.slice(scalarOffset(source.text, cursor), end).join('')).length);
      examined += actual;
      if (++pages === 1) assert.ok(examined < bytes(source.text).length, 'one search page must not count the cached whole file');
      assert.ok(pages < 16); cursor = page.next;
    }
    assert.equal(examined, bytes(source.text).length);
  }
});

test('project read independent text security: normalization preserves source distinctions without silently replacing invalid bytes', () => {
  const first = bytes('\ufeffalpha\r\nbeta\rgamma\n'), second = bytes('alpha\nbeta\ngamma\n');
  const decoded = decodeProjectText(first, limits);
  assert.equal(decoded.text, 'alpha\nbeta\ngamma\n');
  assert.equal(decoded.totalLines, 4);
  assert.notEqual(hash(first), hash(second));
  assert.equal(hash(bytes(decoded.text)), hash(second));
  assert.equal(text('\ufeff\ufeffinside\r\n').text, '\ufeffinside\n');
  for (const invalid of [[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe4, 0xb8]]) {
    assert.throws(() => decodeProjectText(Uint8Array.from(invalid), limits), errorCode('UNSUPPORTED_ENCODING'));
  }
  for (const control of [0, 1, 8, 11, 12, 14, 31, 127]) {
    assert.throws(() => text('before' + String.fromCodePoint(control) + 'after'), errorCode('UNSUPPORTED_TEXT'));
  }
  assert.equal(text('tab\there\n').text, 'tab\there\n');
  first.fill(0);
  assert.equal(decoded.text, 'alpha\nbeta\ngamma\n');
  assert.ok(Object.isFrozen(decoded) && Object.isFrozen(decoded.lineStarts));
});

test('project read independent text security: byte and line ceilings include BOM, multibyte scalars and the final empty line', () => {
  const raw = bytes('\ufeff甲🙂\n');
  assert.equal(raw.byteLength, 11);
  assert.equal(decodeProjectText(raw, { maxBytes: 11, maxLines: 2 }).text, '甲🙂\n');
  assert.throws(() => decodeProjectText(raw, { maxBytes: 10, maxLines: 2 }), errorCode('FILE_LIMIT'));
  assert.throws(() => decodeProjectText(raw, { maxBytes: 11, maxLines: 1 }), errorCode('FILE_LIMIT'));
  assert.equal(text('').totalLines, 1);
  for (const bad of [0, -0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => decodeProjectText(bytes('x'), { maxBytes: bad, maxLines: 1 }), errorCode('INVALID_REQUEST'));
    assert.throws(() => decodeProjectText(bytes('x'), { maxBytes: 1, maxLines: bad }), errorCode('INVALID_REQUEST'));
  }
  const upper = new Uint8Array(limits.maxBytes).fill(0x78);
  assert.equal(decodeProjectText(upper, limits).text.length, limits.maxBytes);
  assert.throws(() => decodeProjectText(new Uint8Array(limits.maxBytes + 1), limits), errorCode('FILE_LIMIT'));
});

test('project read independent fragment security: every scalar start obeys exact half-open range and output byte budgets', () => {
  const original = '🙂甲e\u0301\t\n\n𐐷z\ufeff尾\n', source = text(original);
  const lines = original.split('\n');
  let checked = 0;
  for (let row = 0; row < lines.length; row++) {
    for (let col = 1; col <= Array.from(lines[row]!).length + 1; col++) {
      for (const maxBytes of [4, 5, 7, 8, 12]) for (const maxLines of [1, 2]) {
        const start = { line: row + 1, column: col };
        const page = pageProjectText(source, start, { maxBytes, maxLines });
        assert.equal(page.text, excerpt(original, page.range));
        assert.equal(page.bytes, bytes(page.text).length);
        assert.ok(page.bytes <= maxBytes);
        assert.equal(page.text.includes('\ufffd'), false);
        const first = scalarOffset(original, start), end = scalarOffset(original, page.range.end);
        assert.ok(end >= first);
        assert.equal(page.complete, end === Array.from(original).length);
        assert.deepEqual(page.next, page.complete ? null : page.range.end);
        if (!page.complete) assert.ok(end > first, 'incomplete pages must make progress');
        assert.ok(page.range.end.line - start.line <= maxLines);
        const preserved = { ...page.range.start };
        start.column = 999;
        assert.deepEqual(page.range.start, preserved);
        assert.ok(Object.isFrozen(page) && Object.isFrozen(page.range) && Object.isFrozen(page.range.end));
        checked++;
      }
    }
  }
  assert.ok(checked > 100);
});

test('project read independent fragment security: byte or UTF-16 offsets cannot masquerade as scalar positions', () => {
  const source = text('🙂甲\nend');
  assert.equal(pageProjectText(source, { line: 1, column: 2 }, { maxBytes: 4, maxLines: 1 }).text, '甲\n');
  assert.equal(pageProjectText(source, { line: 1, column: 3 }, { maxBytes: 4, maxLines: 1 }).text, '\n');
  for (const position of [{ line: 1, column: 4 }, { line: 1, column: 8 }, { line: 0, column: 1 }, { line: 3, column: 1 }, { line: 2, column: 5 }, { line: 1.5, column: 1 }, { line: 1, column: Infinity }]) {
    assert.throws(() => pageProjectText(source, position, { maxBytes: 8, maxLines: 2 }), errorCode('INVALID_REQUEST'));
    assert.throws(() => searchProjectText(source, 'end', position, { maxMatches: 1, maxLines: 2, contextPoints: 0 }), errorCode('INVALID_REQUEST'));
  }
});

test('project read independent search security: repeated continuation preserves literal matches, scope and true complete absence', () => {
  const original = 'outside-prefix\n🙂.[甲 .[\nnomatch\n.[🙂.[\nfinal .[', source = text(original);
  const expected = [{ line: 2, column: 2 }, { line: 2, column: 6 }, { line: 4, column: 1 }, { line: 4, column: 4 }, { line: 5, column: 7 }];
  const found: ProjectTextPosition[] = [];
  let next: ProjectTextPosition | null = { line: 1, column: 1 }, turns = 0;
  while (next) {
    const start: ProjectTextPosition = next;
    const page = searchProjectText(source, '.[', start, { maxMatches: 1, maxLines: 1, contextPoints: 1 });
    assert.ok(page.scannedLines <= 1 && page.matches.length <= 1);
    for (const match of page.matches) {
      assert.equal(excerpt(original, match.range), '.[');
      assert.equal(excerpt(original, match.excerptRange), match.excerpt);
      assert.equal(match.range.start.line, match.range.end.line);
      assert.ok(scalarOffset(original, match.range.start) >= scalarOffset(original, start));
      found.push(match.range.start);
    }
    if (!page.complete) {
      assert.ok(page.next);
      assert.ok(scalarOffset(original, page.next) > scalarOffset(original, start));
    }
    next = page.next;
    assert.ok(++turns <= 16);
  }
  assert.deepEqual(found, expected);
  const first = searchProjectText(source, 'does-not-exist', { line: 1, column: 1 }, { maxMatches: 20, maxLines: 1, contextPoints: 0 });
  assert.equal(first.matches.length, 0); assert.equal(first.complete, false);
  const complete = searchProjectText(source, 'does-not-exist', { line: 1, column: 1 }, { maxMatches: 20, maxLines: 10, contextPoints: 0 });
  assert.equal(complete.matches.length, 0); assert.equal(complete.complete, true); assert.equal(complete.next, null);
  for (const invalid of ['', '\n', '\r', '\u0000', '\ud800', '\udc00']) {
    assert.throws(() => searchProjectText(source, invalid, { line: 1, column: 1 }, { maxMatches: 1, maxLines: 1, contextPoints: 0 }), errorCode('INVALID_REQUEST'));
  }
});

test('project read independent large-source security: a late scalar reference survives bounded search and fragment reconstruction', () => {
  const record = 'synthetic entry: ' + 'q'.repeat(90);
  const rows = Array.from({ length: 12009 }, () => record);
  rows[12004] = '🙂 verified-value = 161803; ' + '甲🙂'.repeat(9000);
  const original = rows.join('\r\n'), source: ProjectText = text(original);
  assert.ok(bytes(original).length > 1024 * 1024);
  assert.equal(source.totalLines, 12009);
  let cursor: ProjectTextPosition | null = { line: 1, column: 1 }, target: ProjectTextPosition | undefined, pages = 0;
  while (cursor) {
    const page = searchProjectText(source, 'verified-value = 161803', cursor, { maxMatches: 1, maxLines: 257, contextPoints: 0 });
    if (page.matches.length) { assert.equal(target, undefined); target = page.matches[0]!.range.start; }
    cursor = page.next;
    assert.ok(++pages < 64);
  }
  assert.deepEqual(target, { line: 12005, column: 3 });
  let start = target!, collected = '', fragments = 0;
  while (start.line === 12005) {
    const page = pageProjectText(source, start, { maxBytes: 6144, maxLines: 1 });
    assert.equal(page.text, excerpt(source.text, page.range));
    collected += page.text;
    assert.ok(page.next); start = page.next;
    assert.ok(++fragments < 16);
  }
  assert.equal(collected, Array.from(rows[12004]!).slice(2).join('') + '\n');
  assert.deepEqual(start, { line: 12006, column: 1 });
  assert.ok(fragments > 8);
});
