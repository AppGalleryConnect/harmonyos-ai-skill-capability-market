import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { loadChangelogIndex } from '../../shared/platform/changelog-index.mjs';
import { referenceDigest } from '../references/references.mjs';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const referenceRoot = path.join(skillRoot, 'references', 'changelogs');

test('bundled corpus has 24 intact ASCII-named source documents under seven API13+ versions', async () => {
  const index = await loadChangelogIndex(referenceRoot);
  const versions = (await readdir(referenceRoot, { withFileTypes: true })).filter(entry => !['.DS_Store', 'changelogs-index.json'].includes(entry.name));
  assert.equal(versions.length, 7);
  assert.ok(!versions.some(entry => entry.name === '5.0.0(12)'));
  assert.ok(versions.every(entry => entry.isDirectory()));
  const actual = [];
  for (const version of versions) {
    const files = (await readdir(path.join(referenceRoot, version.name), { withFileTypes: true }))
      .filter(entry => entry.name !== '.DS_Store');
    assert.ok(files.length > 0);
    assert.ok(files.every(entry => entry.isFile() && entry.name.endsWith('.md')));
    actual.push(...files.map(entry => path.posix.join(version.name, entry.name)));
  }
  assert.equal(index.documents.length, 24);
  assert.deepEqual(actual.sort(), index.documents.map(entry => entry.path).sort());
  assert.equal(new Set(actual.map(file => file.toLowerCase())).size, 24);
  assert.ok(actual.every(file => /^[\x20-\x7e]+$/.test(file)));
  assert.equal(index.overview.length, 195);
  assert.ok(index.overview.every(entry => entry.version !== '5.0.0(12)'));
  assert.ok(index.overview.every(entry => !Object.hasOwn(entry, 'originalSourceReference')));
  for (const document of index.documents) {
    assert.deepEqual(Object.keys(document).sort(), ['path', 'sha256']);
    const file = path.join(referenceRoot, document.path);
    assert.equal(await referenceDigest(file), document.sha256, document.path);
    const text = await readFile(file, 'utf8');
    for (const field of ['变更原因', '变更影响', '适配指导']) assert.ok(text.includes(`**${field}**`), document.path);
  }
});

test('current document paths handle Windows separators and reject unsafe or duplicate identities', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'changelog-中文 空格-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const refs = path.join(root, 'changelogs'), file = path.join(refs, 'changelogs-index.json');
  await mkdir(refs);
  await writeFile(path.join(root, 'changelogs-index.json'), '{');
  assert.deepEqual(await loadChangelogIndex(refs), { documents: [], overview: [] });
  const source = { path: path.posix.join('26.0.0', 'beta1-changes.md') };
  const document = { schemaVersion: 1, documents: [source], overview: [] };
  await writeFile(file, JSON.stringify(document));
  {
    const { source: indexSource, ...loaded } = await loadChangelogIndex(refs);
    assert.deepEqual(loaded, document);
    assert.equal(indexSource.file, file);
  }
  await writeFile(file, JSON.stringify({ ...document, documents: [{ path: source.path.replaceAll('/', '\\') }] }));
  assert.deepEqual((await loadChangelogIndex(refs)).documents, document.documents);
  for (const value of [path.posix.join('..', 'outside.md'), path.win32.join('C:\\', 'outside.md'),
    path.posix.join('/', 'outside.md'), '26.0.0/../outside.md', '26.0.0//file.md', '', 7]) {
    await writeFile(file, JSON.stringify({ ...document, documents: [{ path: value }] }));
    await assert.rejects(loadChangelogIndex(refs), /Invalid changelog document path/);
  }
  for (const duplicate of [source.path, source.path.toUpperCase(), source.path.replaceAll('/', '\\')]) {
    await writeFile(file, JSON.stringify({ ...document, documents: [source, { path: duplicate }] }));
    await assert.rejects(loadChangelogIndex(refs), /Duplicate changelog document path/);
  }
  await writeFile(file, '{');
  await assert.rejects(loadChangelogIndex(refs), SyntaxError);
});
