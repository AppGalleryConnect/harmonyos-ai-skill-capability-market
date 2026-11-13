import test from 'node:test';
import assert from 'node:assert/strict';
import { skillFrontmatter } from '../validation/skill-frontmatter.mjs';

test('Skill frontmatter reads LF, CRLF and BOM without changing the source', () => {
  const lf='---\nname: example\nmetadata:\n  version: "1.2.3"\n---\n内容\n';
  const expected=skillFrontmatter(lf);
  for(const input of [lf,lf.replaceAll('\n','\r\n'),'\ufeff'+lf,'\ufeff'+lf.replaceAll('\n','\r\n')])
    assert.deepEqual(skillFrontmatter(input),expected);
  assert.throws(()=>skillFrontmatter('name: example\n'),/YAML frontmatter/);
});
