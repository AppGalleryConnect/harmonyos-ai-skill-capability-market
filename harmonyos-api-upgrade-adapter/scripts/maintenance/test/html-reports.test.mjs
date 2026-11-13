import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { validateGuideLinks, validateReportTemplates } from '../validation/skill-content.mjs';
import { initTask } from '../../shared/platform/task-context.mjs';
import { startReportPreview } from '../../report/preview.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'HTML结构 中文-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'templates'));
  await writeFile(path.join(root, 'SKILL.md'), '# Skill');
  await writeFile(path.join(root, 'README.md'), '# README');
  return root;
}
test('HTML模板参与本地资源和锚点校验，删除的MD不能成为隐含依赖', async t => {
  const root = await fixture(t);
  const template = path.join(root, 'templates', 'report.html');
  await writeFile(template, '<a href="removed-report.md">旧模板</a>');
  await assert.rejects(validateGuideLinks(root), /removed-report\.md/);
  await writeFile(template, '<section id="results"><h1>结果</h1></section><a href="#results">详情</a>');
  assert.equal((await validateGuideLinks(root)).localLinks, 1);
  await writeFile(template, '<a href="#missing">详情</a>');
  await assert.rejects(validateGuideLinks(root), /missing anchor/);
});
test('三类模板要求内联样式及唯一runtime区域，缺资源、外部CSS和脚本均拒绝', async t => {
  const root = await fixture(t);
  const source = '<html><head><style>body{color:#222}</style></head><body><!-- adapter:report --><!-- runtime:report --><main>内容</main><!-- /runtime:report --><!-- /adapter:report --></body></html>';
  for (const name of ['deprecated-report.html', 'upgrade-report.html', 'upgrade-test-report.html']) await writeFile(path.join(root, 'templates', name), source);
  assert.equal((await validateReportTemplates(root)).templates, 3);
  const target = path.join(root, 'templates', 'upgrade-test-report.html');
  await writeFile(target, source.replace('<style>body{color:#222}</style>', '<link rel="stylesheet" href="report.css">'));
  await assert.rejects(validateReportTemplates(root), /内联/);
  await writeFile(target, source.replace('<!-- /runtime:report -->', ''));
  await assert.rejects(validateReportTemplates(root), /runtime/);
  await writeFile(target, source.replace('<main>', '<script>run()</script><main>'));
  await assert.rejects(validateReportTemplates(root), /脚本/);
  await rm(target);
  await assert.rejects(validateReportTemplates(root), /ENOENT|missing/);
});

test('HTTP 预览保留报告相对资源并拒绝任务目录越界', async t => {
  const root = await fixture(t);
  const task = await initTask(root);
  const directory = path.join(task.taskDirectory, '报告 #');
  const outside = path.join(root, 'outside');
  await mkdir(directory);
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'outside');
  await symlink(outside, path.join(directory, '越界链接'), process.platform === 'win32' ? 'junction' : 'dir');
  const html = path.join(directory, '另存 #1.html');
  const body = '<html><a href="证据%20%231.txt">证据</a></html>';
  await writeFile(html, body);
  await writeFile(path.join(directory, '证据 #1.txt'), '本次证据');

  const preview = await startReportPreview({ taskFile: task.taskFile, html });
  t.after(preview.close);
  assert.equal(new URL(preview.url).hostname, '127.0.0.1');
  assert.equal(await (await fetch(preview.url)).text(), body);
  assert.equal(await (await fetch(new URL('证据%20%231.txt', preview.url))).text(), '本次证据');
  assert.equal((await fetch(new URL('越界链接/secret.txt', preview.url))).status, 403);
  assert.equal((await fetch(new URL('%2e%2e%2foutside/secret.txt', preview.url))).status, 403);
  assert.equal(await readFile(html, 'utf8'), body);
});
