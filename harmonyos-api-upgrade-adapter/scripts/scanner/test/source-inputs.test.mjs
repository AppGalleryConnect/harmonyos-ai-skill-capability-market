import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, realpath, writeFile, symlink } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import ts from 'typescript';
import { createArkTsProgram } from '../deprecated/arkts-deprecations.mjs';

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'source-inputs-')));
  const entry = path.join(root, 'application source'), file = path.join(entry, 'Main.ts');
  await mkdir(entry);
  const project = { root, sourceFiles: [file], modules: [] };
  const catalog = { ts, sourceFiles: new Map(), toolchain: { sdkRoot: root }, etsOptions: {} };
  return { root, entry, file, project, catalog };
}

test('binary file dependencies never become TS sources or binary text inputs', async () => {
  const f = await fixture(), extensions = ['.har', '.hap', '.hsp', '.app', '.abc', '.so', '.a', '.o', '.dll', '.exe', '.bin', ''];
  const dependencies = {}, imports = [];
  for (const [index, extension] of extensions.entries()) {
    const name = `binary${index}`, file = path.join(f.root, `artifact${extension}`);
    await writeFile(file, gzipSync(Buffer.from([0, 255, 254, index])));
    dependencies[name] = `file:${path.relative(f.entry, file).split(path.sep).join('/')}`;
    imports.push(`import { value as v${index} } from '${name}';`);
  }
  await writeFile(path.join(f.entry, 'oh-package.json5'), JSON.stringify({ dependencies }));
  await writeFile(f.file, imports.join('\n'));
  const context = createArkTsProgram(f.project, f.catalog, { compilerOptions: { noLib: true } });
  assert.deepEqual(context.program.getSourceFiles().map(source => path.normalize(source.fileName)), [path.normalize(f.file)]);
  assert.equal(context.unresolvedImports.length, extensions.length);

});

test('package main binaries are excluded while existing text declarations remain usable', async () => {
  const f = await fixture();
  for (const [name, types] of [['opaque', false], ['typed', true]]) {
    const root = path.join(f.entry, 'oh_modules', name);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'oh-package.json5'), JSON.stringify({ main: 'payload.hap', ...(types ? { types: 'Index.d.ts' } : {}) }));
    await writeFile(path.join(root, 'payload.hap'), gzipSync(Buffer.from('not source')));
    if (types) await writeFile(path.join(root, 'Index.d.ts'), 'export declare const value: number;');
  }
  await writeFile(f.file, "import { value } from 'typed'; import { missing } from 'opaque'; const n: number = value;");
  const context = createArkTsProgram(f.project, f.catalog, { compilerOptions: { noLib: true } });
  assert.equal(context.program.getSourceFiles().length, 2);
  assert.ok(context.program.getSourceFiles().every(source => source.fileName.endsWith('.ts')));
  assert.deepEqual(context.unresolvedImports.map(item => item.module), ['opaque']);
});

test('binary roots, overlays and directory aliases cannot bypass the source whitelist', async () => {
  const f = await fixture(), binary = path.join(f.root, 'payload.har'), alias = path.join(f.root, 'source alias');
  await writeFile(binary, gzipSync(Buffer.from('archive')));
  await writeFile(path.join(f.entry, 'payload.har'), gzipSync(Buffer.from('archive')));
  await writeFile(f.file, 'export const value = 1;');
  await symlink(f.entry, alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.project.sourceFiles.push(binary);
  const context = createArkTsProgram(f.project, f.catalog, { overlays: new Map([[binary, 'pretend source']]), compilerOptions: { noLib: true } });
  assert.equal(context.program.getSourceFile(binary), undefined);
  assert.equal(context.resolveModule(path.join(alias, 'payload.har'), f.file), null);
  assert.equal(context.resolveModule(path.join(alias, 'Main.ts'), f.file), f.file);
  assert.equal(context.program.getSourceFiles().length, 1);
});
