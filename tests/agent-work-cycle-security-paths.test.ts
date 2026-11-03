import test from 'node:test';
import assert from 'node:assert/strict';
import { isWorkCycleRelativePath } from '../apps/desktop/src/shared/agent/agent-work-cycle';

test('C1 work paths reject Windows device aliases in every component', () => {
  // Independent Win32 naming oracle, including ISO-8859-1 superscript digits.
  // https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file
  const devices = ['CON', 'PRN', 'AUX', 'NUL',
    ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
    ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
    ...['¹', '²', '³'].flatMap(digit => [`COM${digit}`, `LPT${digit}`])];
  const admitted = devices.flatMap(device => [device, `${device.toLowerCase()}.txt`, `out/${device}.csv`, `${device}/result.txt`])
    .filter(value => isWorkCycleRelativePath(value));
  assert.deepEqual(admitted, [], 'device names must not enter ordinary work-file I/O');
});

test('C1 work paths reject host locators, alternate streams and traversal spellings', () => {
  const invalid = ['', '/', '/absolute.txt', '//server/share', 'C:relative.txt', 'C:/absolute.txt',
    '\\\\server\\share', '\\\\?\\C:\\file.txt', '\\\\.\\NUL', 'a\\b.txt', 'a:stream',
    '.', '..', '../a', 'a/../b', 'a/./b', 'a//b', 'a/', 'a. /b', 'a./b', 'a /b',
    'x\u0000.txt', 'x\n.txt', 'x\ud800.txt', 'a<b', 'a?b', 'a|b', 'a*b', 'a"b'];
  assert.deepEqual(invalid.filter(value => isWorkCycleRelativePath(value)), []);
});

test('C1 work paths retain ordinary analysis filenames without treating lookalikes as devices', () => {
  for (const value of ['analysis.py', 'results/summary.csv', '分析/结果.json', 'COM10.txt', 'com1-data.csv', 'data/.config']) {
    assert.equal(isWorkCycleRelativePath(value), true, value);
  }
});
