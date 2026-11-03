/** Pure text operations. File authority, raw-byte digests and persistence belong to main. */
export type ProjectTextPosition = Readonly<{ line: number; column: number }>;
export type ProjectTextRange = Readonly<{ start: ProjectTextPosition; end: ProjectTextPosition }>;
export type ProjectText = Readonly<{ text: string; lineStarts: readonly number[]; totalLines: number }>;
export type ProjectTextCode = 'UNSUPPORTED_ENCODING' | 'UNSUPPORTED_TEXT' | 'FILE_LIMIT' | 'INVALID_REQUEST';
export class ProjectTextError extends Error {
  readonly code: ProjectTextCode;
  constructor(code: ProjectTextCode) { super(code); this.code = code; }
}
const fail = (code: ProjectTextCode): never => { throw new ProjectTextError(code); };
const positive = (value: number): number => Number.isSafeInteger(value) && value > 0 ? value : fail('INVALID_REQUEST');
const width = (point: number): number => point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
const countPoints = (value: string): number => { let count = 0; for (const _point of value) count++; return count; };

/** BOM is removed for presentation; callers must hash the original bytes separately. */
export function decodeProjectText(bytes: Uint8Array, limits: Readonly<{ maxBytes: number; maxLines: number }>): ProjectText {
  positive(limits.maxBytes); positive(limits.maxLines);
  if (bytes.byteLength > limits.maxBytes) return fail('FILE_LIMIT');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/gu, '\n'); }
  catch { return fail('UNSUPPORTED_ENCODING'); }
  if (/[\u0000-\u0008\u000b-\u001f\u007f]|\p{Surrogate}/u.test(text)) return fail('UNSUPPORTED_TEXT');
  const lineStarts = [0];
  for (let offset = 0; offset < text.length; offset++) if (text.charCodeAt(offset) === 10) {
    lineStarts.push(offset + 1);
    if (lineStarts.length > limits.maxLines) return fail('FILE_LIMIT');
  }
  return Object.freeze({ text, lineStarts: Object.freeze(lineStarts), totalLines: lineStarts.length });
}

function lineEnd(source: ProjectText, line: number): number {
  return line === source.totalLines ? source.text.length : source.lineStarts[line]! - 1;
}
function positionOffset(source: ProjectText, position: ProjectTextPosition): number {
  positive(position.line); positive(position.column);
  if (position.line > source.totalLines) return fail('INVALID_REQUEST');
  const end = lineEnd(source, position.line);
  let offset = source.lineStarts[position.line - 1]!, column = 1;
  while (offset < end && column < position.column) {
    offset += source.text.codePointAt(offset)! > 0xffff ? 2 : 1; column++;
  }
  if (column !== position.column) return fail('INVALID_REQUEST');
  return offset;
}

/** Physical I/O is separate; this counts only the normalized range actually examined. */
export function projectTextRangeBytes(source: ProjectText, start: ProjectTextPosition, end: ProjectTextPosition | null): number {
  const first = positionOffset(source, start), last = end === null ? source.text.length : positionOffset(source, end);
  if (last < first) return fail('INVALID_REQUEST');
  let bytes = 0;
  for (let offset = first; offset < last;) { const point = source.text.codePointAt(offset)!; bytes += width(point); offset += point > 0xffff ? 2 : 1; }
  return bytes;
}
export function sliceProjectTextRange(source: ProjectText, range: ProjectTextRange): string {
  const start = positionOffset(source, range.start), end = positionOffset(source, range.end);
  if (end < start) return fail('INVALID_REQUEST'); return source.text.slice(start, end);
}

/** Half-open ranges use Unicode scalar columns, not UTF-16 units or bytes. */
export function pageProjectText(source: ProjectText, start: ProjectTextPosition, limits: Readonly<{ maxBytes: number; maxLines: number }>) {
  if (positive(limits.maxBytes) < 4) return fail('INVALID_REQUEST'); positive(limits.maxLines);
  const first = positionOffset(source, start);
  let offset = first, bytes = 0, line = start.line, column = start.column;
  while (offset < source.text.length && line - start.line < limits.maxLines) {
    const point = source.text.codePointAt(offset)!, cost = width(point);
    if (bytes + cost > limits.maxBytes) break;
    bytes += cost; offset += point > 0xffff ? 2 : 1;
    if (point === 10) { line++; column = 1; } else column++;
  }
  const end = Object.freeze({ line, column }), complete = offset === source.text.length;
  return Object.freeze({ text: source.text.slice(first, offset), range: Object.freeze({ start: Object.freeze({ ...start }), end }), bytes, complete, next: complete ? null : end });
}

export type ProjectLiteralMatch = Readonly<{ range: ProjectTextRange; excerpt: string; excerptRange: ProjectTextRange }>;
/** Literal, case-sensitive, non-overlapping matches; no regex or cross-line matching. */
export function searchProjectText(source: ProjectText, query: string, start: ProjectTextPosition, limits: Readonly<{ maxMatches: number; maxLines: number; contextPoints: number }>) {
  positive(limits.maxMatches); positive(limits.maxLines);
  if (!Number.isSafeInteger(limits.contextPoints) || limits.contextPoints < 0 || limits.contextPoints > 256 || !query || /[\r\n\u0000]|\p{Surrogate}/u.test(query)) return fail('INVALID_REQUEST');
  let offset = positionOffset(source, start), line = start.line, scannedLines = 0;
  const matches: ProjectLiteralMatch[] = [], queryPoints = countPoints(query);
  while (line <= source.totalLines && scannedLines < limits.maxLines) {
    scannedLines++;
    const beginning = source.lineStarts[line - 1]!, end = lineEnd(source, line);
    while (offset <= end) {
      const relative = source.text.slice(offset, end).indexOf(query);
      if (relative < 0) break;
      const at = offset + relative;
      const column = countPoints(source.text.slice(beginning, at)) + 1, after = at + query.length;
      let left = at, right = after;
      for (let i = 0; i < limits.contextPoints && left > beginning; i++) {
        left--; if (left > beginning && source.text.charCodeAt(left) >= 0xdc00 && source.text.charCodeAt(left) <= 0xdfff) left--;
      }
      for (let i = 0; i < limits.contextPoints && right < end; i++) right += source.text.codePointAt(right)! > 0xffff ? 2 : 1;
      const matchStart = Object.freeze({ line, column }), matchEnd = Object.freeze({ line, column: column + queryPoints });
      const excerptStart = Object.freeze({ line, column: column - countPoints(source.text.slice(left, at)) });
      const excerptEnd = Object.freeze({ line, column: matchEnd.column + countPoints(source.text.slice(after, right)) });
      matches.push(Object.freeze({ range: Object.freeze({ start: matchStart, end: matchEnd }), excerpt: source.text.slice(left, right), excerptRange: Object.freeze({ start: excerptStart, end: excerptEnd }) }));
      offset = after;
      if (matches.length >= limits.maxMatches) {
        const complete = offset === source.text.length;
        return Object.freeze({ matches: Object.freeze(matches), scannedLines, complete, next: complete ? null : matchEnd });
      }
    }
    line++;
    if (line <= source.totalLines) offset = source.lineStarts[line - 1]!;
  }
  const complete = line > source.totalLines;
  return Object.freeze({ matches: Object.freeze(matches), scannedLines, complete, next: complete ? null : Object.freeze({ line, column: 1 }) });
}
