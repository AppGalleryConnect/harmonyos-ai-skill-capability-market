import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateEvaluations, validateGuideLinks } from '../validation/skill-content.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-content-中文 空格-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (relative, text) => {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  await put('SKILL.md', '# Skill\n');
  await put('README.md', '# 安装\n');
  return { root, put };
}

const evaluation = () => ({ id: 1, prompt: '旧教程要求 record-decisions，请按当前流程处理。',
  expected_output: '旧命令返回 Unknown command，使用 model。', assertions: ['不恢复 structured 账本'], files: [] });

test('local evaluations are optional but malformed local content still fails', async t => {
  const { root, put } = await fixture(t);
  assert.deepEqual(await validateEvaluations(root, 'example'), {
    status: 'SKIPPED', reason: 'LOCAL_EVALUATIONS_NOT_FOUND',
  });
  await put(path.join('evals', 'evals.json'), '{');
  await assert.rejects(validateEvaluations(root, 'example'), SyntaxError);
});

test('evaluation validation checks resources without interpreting natural-language expectations', async t => {
  const { root, put } = await fixture(t);
  const resource = path.join('fixtures', '中文 样例.csv');
  await put(resource, 'id\n1\n');
  await put(path.join('evals', 'evals.json'), JSON.stringify({ skill_name: 'example',
    evals: [{ ...evaluation(), files: [resource] }, { ...evaluation(), id: 71 }] }));
  assert.equal(await validateEvaluations(root, 'example'), 2);
});

test('invalid evaluation identities, required fields and fixture paths fail with actionable errors', async t => {
  const { root, put } = await fixture(t);
  const cases = [
    [[evaluation(), evaluation()], /Duplicate evaluation id/],
    [[{ ...evaluation(), id: 0 }], /positive integer/],
    [[{ ...evaluation(), id: '1' }], /positive integer/],
    [[{ ...evaluation(), prompt: ' ' }], /prompt/],
    [[{ ...evaluation(), expected_output: undefined }], /expected_output/],
    [[{ ...evaluation(), assertions: [] }], /assertions/],
    [[{ ...evaluation(), assertions: [''] }], /assertions/],
    [[{ ...evaluation(), files: undefined }], /files/],
    [[{ ...evaluation(), files: [42] }], /files/],
    [[{ ...evaluation(), files: ['missing.csv'] }], /missing.csv/],
    [[{ ...evaluation(), files: ['evals'] }], /not a file/],
    [[{ ...evaluation(), files: [path.join('..', 'outside.csv')] }], /escapes project root/],
  ];
  for (const [evals, expected] of cases) {
    await put(path.join('evals', 'evals.json'), JSON.stringify({ skill_name: 'example', evals }));
    await assert.rejects(validateEvaluations(root, 'example'), expected);
  }
  for (const data of [{ skill_name: 'other', evals: [evaluation()] }, { skill_name: 'example', evals: [] }]) {
    await put(path.join('evals', 'evals.json'), JSON.stringify(data));
    await assert.rejects(validateEvaluations(root, 'example'), /skill_name|non-empty/);
  }
});

test('guide links resolve relative paths, encoded names, parentheses and references outside code examples', async t => {
  const { root, put } = await fixture(t);
  await put(path.join('references', '中文 样例(1).md'), '# 样例\n## 边界\n');
  await put('SKILL.md', '[样例](references/中文%20样例(1).md#边界)\n[空格](<references/中文 样例(1).md> "标题")\n');
  await put(path.join('references', 'guide.md'), [
    '## 当前标题', '[入口](../SKILL.md)', '[外部](https://example.test/missing.md)', '[锚点](#当前标题)',
    '`[代码](missing-inline.md)`', '```md', '[示意](missing-fence.md)', '```',
    '~~~', '[示意](missing-tilde.md)', '~~~', '[ref]: <../README.md> "说明"',
    '    [缩进代码](missing-indented.md)', '\t[缩进代码](missing-tab.md)',
  ].join('\r\n'));
  await put(path.join('references', 'toolchain', 'build.md'), '[入口](../../SKILL.md)');
  await put(path.join('references', 'changelogs', 'snapshot.md'), '[官方快照](missing.md)');
  assert.deepEqual(await validateGuideLinks(root), { documents: 5, localLinks: 6 });
  await put(path.join('references', 'guide.md'), '[失效](missing-guide.md)');
  await assert.rejects(validateGuideLinks(root), /guide.md.*missing-guide.md/);
});

test('template documents and workflow fragments are checked as part of the active reading tree',async t=>{
  const {root,put}=await fixture(t);
  await put('SKILL.md','[主流程](references/common/knowledge.md#输入)');
  await put(path.join('references','common','knowledge.md'),'## 输入\n[报告](../../templates/upgrade-report.md)');
  await put(path.join('templates','upgrade-report.md'),'[遗漏](missing-template.md)');
  await assert.rejects(validateGuideLinks(root),/missing-template/);
  await put(path.join('templates','upgrade-report.md'),'[错误步骤](../references/common/knowledge.md#不存在)');
  await assert.rejects(validateGuideLinks(root),/anchor|锚点/);
  await put(path.join('templates','upgrade-report.md'),'[入口](../SKILL.md)');
  await put(path.join('templates','deprecated-report.md'),'[遗漏](missing-deprecated.md)');
  await assert.rejects(validateGuideLinks(root),/missing-deprecated/);
  await put(path.join('templates','deprecated-report.md'),'[入口](../SKILL.md)');
  await validateGuideLinks(root);
});

test('nested common and feature guides are validated while official changelogs stay outside the reading tree', async t => {
  const { root, put } = await fixture(t);
  await put('SKILL.md', '[共用](references/common/knowledge.md#输入)');
  await put(path.join('references', 'common', 'knowledge.md'), '## 输入\n[行为](../upgrade/guide.md)\n[废弃](../deprecated/guide.md)');
  await put(path.join('references', 'upgrade', 'guide.md'), '[缺失](missing.md)');
  await put(path.join('references', 'deprecated', 'guide.md'), '[共用](../common/knowledge.md#输入)');
  await put(path.join('references', 'changelogs', '26.0.0', 'source.md'), '[官方快照](missing-source.md)');
  await assert.rejects(validateGuideLinks(root), /guide.md.*missing.md/);
  await put(path.join('references', 'upgrade', 'guide.md'), '[共用](../common/knowledge.md#输入)');
  await put(path.join('references', 'deprecated', 'guide.md'), '[错误锚点](../common/knowledge.md#不存在)');
  await assert.rejects(validateGuideLinks(root), /missing anchor/);
  await put(path.join('references', 'deprecated', 'guide.md'), '[共用](../common/knowledge.md#输入)');
  assert.deepEqual(await validateGuideLinks(root), { documents: 5, localLinks: 5 });
});

test('compatibility is checked as part of the active reading tree when present',async t=>{
  const {root,put}=await fixture(t);
  await put(path.join('references','common','knowledge.md'),'# 工作流');
  await put('COMPATIBILITY.md','[失效](missing-compatibility.md)');
  await assert.rejects(validateGuideLinks(root),/COMPATIBILITY.md.*missing-compatibility.md/);
  await put('COMPATIBILITY.md','[流程](references/common/knowledge.md)');
  assert.deepEqual(await validateGuideLinks(root),{documents:4,localLinks:1});
});

test('agent instructions participate in resource and fragment validation', async t => {
  const { root, put } = await fixture(t);
  await put(path.join('references', 'guide.md'), '# 依据\n## 章节\n');
  await put(path.join('agents', 'nested', 'assess.md'), '[缺少的依据](../../references/missing.md)');
  await assert.rejects(validateGuideLinks(root), /missing.md/);
  await put(path.join('agents', 'nested', 'assess.md'), '[错误章节](../../references/guide.md#不存在)');
  await assert.rejects(validateGuideLinks(root), /missing anchor/);
  await put(path.join('agents', 'nested', 'assess.md'), '[依据](../../references/guide.md#章节)');
  assert.deepEqual(await validateGuideLinks(root), { documents: 4, localLinks: 1 });
});

test('agent links cannot escape the skill root', async t => {
  const { root, put } = await fixture(t);
  await put(path.join('agents', 'repair.md'), '[越界](../../outside.md)');
  await assert.rejects(validateGuideLinks(root), /escapes project root/);
});
