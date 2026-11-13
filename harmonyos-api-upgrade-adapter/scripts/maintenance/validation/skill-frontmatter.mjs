export function skillFrontmatter(input) {
  const text = input.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error('SKILL.md must start with YAML frontmatter');
  return { text, lines: match[1].split('\n') };
}
