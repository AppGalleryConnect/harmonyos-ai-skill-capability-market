import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { listFiles, resolveInside } from '../../shared/io/fs-utils.mjs';

const nonEmptyText = value => typeof value === 'string' && value.trim().length > 0;

async function requireFile(file, context) {
  const info = await stat(file).catch(error => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!info?.isFile()) throw new Error(`${context}: missing or not a file: ${file}`);
}

export async function validateEvaluations(skillRoot, skillName) {
  const text = await readFile(path.join(skillRoot, 'evals', 'evals.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (text === null) return { status: 'SKIPPED', reason: 'LOCAL_EVALUATIONS_NOT_FOUND' };
  const data = JSON.parse(text);
  if (data.skill_name !== skillName) throw new Error('evals/evals.json skill_name must match Skill name');
  if (!Array.isArray(data.evals) || !data.evals.length) throw new Error('Evaluations must be a non-empty array');
  const ids = new Set();
  for (const entry of data.evals) {
    if (!Number.isSafeInteger(entry?.id) || entry.id < 1) throw new Error('Evaluation id must be a positive integer');
    if (ids.has(entry.id)) throw new Error(`Duplicate evaluation id: ${entry.id}`);
    ids.add(entry.id);
    for (const field of ['prompt', 'expected_output']) {
      if (!nonEmptyText(entry[field])) throw new Error(`Evaluation ${entry.id}: ${field} must contain text`);
    }
    if (!Array.isArray(entry.assertions) || !entry.assertions.length || !entry.assertions.every(nonEmptyText))
      throw new Error(`Evaluation ${entry.id}: assertions must contain non-empty text entries`);
    if (!Array.isArray(entry.files) || !entry.files.every(nonEmptyText))
      throw new Error(`Evaluation ${entry.id}: files must be an array of non-empty paths`);
    for (const resource of entry.files) {
      await requireFile(resolveInside(skillRoot, resource), `Evaluation ${entry.id} fixture ${resource}`);
    }
  }
  return ids.size;
}

// Read Markdown destinations without treating nested parentheses as the end of a path.
function destination(text) {
  const value = text.trimStart();
  if (value.startsWith('<')) return value.slice(1, value.indexOf('>'));
  let depth = 0, result = '';
  for (let i = 0; i < value.length; i++) {
    const character = value[i];
    if (character === '\\' && i + 1 < value.length) { result += character + value[++i]; continue; }
    if (character === '(') depth++;
    if (character === ')') { if (!depth) break; depth--; }
    if (/\s/.test(character) && !depth) break;
    result += character;
  }
  return result;
}

function localLinks(text) {
  const links = [];
  let fence = null;
  for (const raw of text.split(/\r?\n/)) {
    const marker = raw.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length
        && raw.trim() === marker[1]) fence = null;
      continue;
    }
    if (marker) { fence = marker[1]; continue; }
    if (/^(?: {4}|\t)/.test(raw)) continue;
    const line = raw.replace(/(`+).*?\1/g, '');
    const starts = [...line.matchAll(/(?<!\\)\]\(/g)].map(match => match.index + 2);
    const reference = line.match(/^ {0,3}\[[^\]]+\]:\s*/);
    if (reference) starts.push(reference[0].length);
    for (const start of starts) {
      const target = destination(line.slice(start));
      if (!target || target.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
      const file = decodeURIComponent(target.split(/[?#]/)[0]).replace(/\\([\\()[\] <>])/g, '$1');
      const fragment = target.includes('#') ? decodeURIComponent(target.slice(target.indexOf('#')+1)) : '';
      if (file || fragment) links.push({file,fragment});
    }
  }
  return links;
}

function localHtmlLinks(text) {
  const links = [];
  const markup = text.replace(/<!--[\s\S]*?-->/g, '');
  for (const match of markup.matchAll(/\b(?:href|src)\s*=\s*(["'])(.*?)\1/gi)) {
    const target = match[2].replaceAll('&amp;', '&');
    if (!target || target.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
    links.push({ file: decodeURIComponent(target.split(/[?#]/)[0]), fragment: target.includes('#') ? decodeURIComponent(target.slice(target.indexOf('#') + 1)) : '' });
  }
  return links;
}

function headingAnchors(text) {
  const anchors=new Set(),used=new Map();let fence=null;
  for(const line of text.split(/\r?\n/)) {
    const marker=line.match(/^ {0,3}(`{3,}|~{3,})/);
    if(fence){if(marker&&marker[1][0]===fence[0]&&marker[1].length>=fence.length&&line.trim()===marker[1])fence=null;continue;}
    if(marker){fence=marker[1];continue;}
    for(const tag of line.matchAll(/<[a-z][\w:-]*\b[^>]*\bid=["']([^"']+)["']/gi))anchors.add(tag[1]);
    const heading=line.match(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/);if(!heading)continue;
    const base=heading[1].replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/<[^>]+>/g,'')
      .replace(/[`*_~]/g,'').toLowerCase().replace(/[^\p{L}\p{N}\p{M}_ -]/gu,'').replace(/ /g,'-');
    const count=used.get(base)??0;used.set(base,count+1);anchors.add(base+(count?`-${count}`:''));
  }
  return anchors;
}

export async function validateGuideLinks(skillRoot) {
  const referenceRoot = path.join(skillRoot, 'references');
  const documents = ['SKILL.md', 'README.md'].map(file => path.join(skillRoot, file));
  const compatibility=path.join(skillRoot,'COMPATIBILITY.md');
  if(await stat(compatibility).then(info=>info.isFile()).catch(error=>{if(error.code==='ENOENT')return false;throw error;}))
    documents.push(compatibility);
  documents.push(...await listFiles(referenceRoot, file => file.endsWith('.md'),
    directory => path.relative(referenceRoot, directory) !== 'changelogs', { allowMissing: true }));
  documents.push(...await listFiles(path.join(skillRoot,'templates'), file => /\.(?:md|html)$/.test(file), () => true, { allowMissing: true }));
  documents.push(...await listFiles(path.join(skillRoot,'agents'), file => file.endsWith('.md'), () => true, { allowMissing: true }));
  const anchors=new Map();let count=0;
  for (const document of documents) {
    const text = await readFile(document, 'utf8');
    for (const link of document.endsWith('.html') ? localHtmlLinks(text) : localLinks(text)) {
      const file=link.file ? resolveInside(skillRoot,path.relative(skillRoot,path.resolve(path.dirname(document),link.file))) : document;
      const context=`${path.relative(skillRoot,document)} link ${link.file||'#'+link.fragment}`;
      await requireFile(file,context);
      if(link.fragment) {
        if(!anchors.has(file))anchors.set(file,headingAnchors(await readFile(file,'utf8')));
        if(!anchors.get(file).has(link.fragment))throw new Error(`${context}: missing anchor #${link.fragment}`);
      }
      count++;
    }
  }
  return { documents: documents.length, localLinks: count };
}

export async function validateReportTemplates(skillRoot) {
  for (const name of ['deprecated-report', 'upgrade-report', 'upgrade-test-report']) {
    const text = await readFile(path.join(skillRoot, 'templates', name + '.html'), 'utf8');
    if (!/<style>[\s\S]+?<\/style>/i.test(text) || /<link\b[^>]*rel=["']stylesheet["']/i.test(text))
      throw new Error(`${name}: HTML 报告必须保留内联样式`);
    if (/<script\b/i.test(text)) throw new Error(`${name}: 报告模板不能依赖脚本`);
    if (name !== 'upgrade-test-report' && (text.split('<!-- adapter:report -->').length !== 2
      || text.split('<!-- /adapter:report -->').length !== 2 || text.indexOf('<!-- adapter:report -->') > text.indexOf('<!-- /adapter:report -->')))
      throw new Error(`${name}: 缺少唯一 adapter 内容区域`);
    if (name === 'upgrade-test-report' && (text.split('<!-- runtime:report -->').length !== 2
      || text.split('<!-- /runtime:report -->').length !== 2 || text.indexOf('<!-- runtime:report -->') > text.indexOf('<!-- /runtime:report -->')))
      throw new Error(`${name}: 缺少唯一 runtime 内容区域`);
  }
  return { templates: 3, inlineStyles: true };
}
