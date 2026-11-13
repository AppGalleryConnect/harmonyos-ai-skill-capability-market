import test from 'node:test';
import assert from 'node:assert/strict';
import { portablePath, samePath, relativePathInside, comparableCodeLocation, parseCodeLocation } from '../platform/paths.mjs';

test('normalizes Windows path identity and portable report paths', () => {
  assert.equal(samePath('C:\\Work\\App\\Entry.ets', 'c:\\work\\app\\entry.ets', 'win32'), true);
  assert.equal(samePath('C:\\Work\\App', 'D:\\Work\\App', 'win32'), false);
  assert.equal(portablePath('entry\\src\\main\\A.ets'), 'entry/src/main/A.ets');
});

test('Windows containment and locations handle drives, UNC, casing and line numbers', () => {
  assert.equal(relativePathInside('C:\\工程 空格','c:/工程 空格/Entry/A.ts','win32'),'Entry/A.ts');
  assert.equal(relativePathInside('C:\\App','D:\\App\\A.ts','win32'),null);
  assert.equal(relativePathInside('C:\\App','C:\\Application\\A.ts','win32'),null);
  assert.equal(relativePathInside('C:\\App','C:\\App\\..\\secret.ts','win32'),null);
  assert.equal(relativePathInside('\\\\server\\share\\App','\\\\SERVER\\SHARE\\app\\A.ts','win32'),'A.ts');
  assert.equal(comparableCodeLocation('c:/WORK/App/Entry/A.ts:12:4','C:\\Work\\App','win32'),'entry/a.ts:12:4');
  assert.notEqual(comparableCodeLocation('Entry/A.ts:1',null,'darwin'),comparableCodeLocation('entry/A.ts:1',null,'darwin'));
});

test('Code Location splits only the numeric suffix on drives, UNC and relative paths', () => {
  for (const file of ['C:\\工程 空格\\A.ets', '\\\\server\\share\\A.ets', 'registered/src/A.ets']) {
    assert.deepEqual(parseCodeLocation(`${file}:12`), { file, line: 12, column: null });
    assert.deepEqual(parseCodeLocation(`${file}:12:4`), { file, line: 12, column: 4 });
  }
  for (const location of ['A.ets', 'A.ets:0', 'A.ets:1:0']) assert.throws(() => parseCodeLocation(location));
});
