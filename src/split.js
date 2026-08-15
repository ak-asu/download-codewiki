/**
 * Split a wiki document into cross-linked per-section files.
 *
 * Sections are derived from the heading tree of the already-transformed
 * Markdown, so splitting stays independent of how the document was fetched.
 */

import { collectHeadings, escapeLinkText, splitFences } from './markdown.js';

/** Filename-safe slug that keeps unicode letters and digits. */
export function slugifyFilename(text) {
  const s = String(text)
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || 'section';
}

/**
 * Build the file set for a split output.
 *
 * Returns { files: [{ path, content }], index } where `index` is the landing
 * page. Anchor links between sections are repointed at the file that now owns
 * the target heading, so cross-references survive the split.
 */
export function splitDocument(markdown, { title, sourceUrl, sha, tocTitle = 'Contents' } = {}) {
  const headings = collectHeadings(markdown);
  const lines = markdown.split('\n');

  const body = headings.filter((h) => h.level > 1);
  if (body.length < 2) {
    return { files: [{ path: '0-Index.md', content: markdown }], index: '0-Index.md' };
  }

  const topLevel = Math.min(...body.map((h) => h.level));
  const subLevel = (() => {
    const deeper = body.filter((h) => h.level > topLevel).map((h) => h.level);
    return deeper.length ? Math.min(...deeper) : topLevel + 1;
  })();

  const slice = (from, to) => lines.slice(from, to).join('\n').trim();

  // Group headings into top-level sections, each with its subsections.
  const tops = body.filter((h) => h.level === topLevel);
  const usedNames = new Set();
  const uniqueName = (base) => {
    let name = base;
    let k = 2;
    while (usedNames.has(name.toLowerCase())) name = `${base}-${k++}`;
    usedNames.add(name.toLowerCase());
    return name;
  };

  const sections = tops.map((head, i) => {
    const start = head.line;
    const end = i + 1 < tops.length ? tops[i + 1].line : lines.length;
    const subs = body.filter((h) => h.level === subLevel && h.line > start && h.line < end);
    const number = i + 1;
    const file = uniqueName(`${number}-${slugifyFilename(head.title)}`) + '.md';
    return {
      head,
      number,
      file,
      intro: slice(start + 1, subs.length ? subs[0].line : end),
      subs: subs.map((sub, j) => ({
        head: sub,
        label: `${number}.${j + 1}`,
        file: uniqueName(`${number}.${j + 1}-${slugifyFilename(sub.title)}`) + '.md',
        content: slice(sub.line + 1, j + 1 < subs.length ? subs[j + 1].line : end),
      })),
    };
  });

  // slug -> owning file, for rewriting cross-section anchor links.
  const owner = new Map();
  for (const s of sections) {
    owner.set(s.head.slug, s.file);
    for (const sub of s.subs) owner.set(sub.head.slug, sub.file);
  }
  // Deeper headings belong to whichever file contains them.
  for (const h of body) {
    if (owner.has(h.slug)) continue;
    let found = null;
    for (const s of sections) {
      if (h.line > s.head.line) found = s.file;
      for (const sub of s.subs) if (h.line > sub.head.line) found = sub.file;
    }
    if (found) owner.set(h.slug, found);
  }

  const repoint = (text, selfFile) =>
    splitFences(text).map((r) => (r.fence ? r.text : r.text.replace(
      /\]\(#([^)]+)\)/g,
      (whole, slug) => {
        const target = owner.get(slug);
        if (!target) return whole;
        return target === selfFile ? whole : `](./${target}#${slug})`;
      },
    ))).join('\n');

  const files = [];
  const indexFile = '0-Index.md';

  for (const s of sections) {
    let md = `# ${s.head.title}\n\n[← Back to index](./${indexFile})\n\n`;
    if (s.intro) md += `${s.intro}\n\n`;
    if (s.subs.length) {
      md += `## In this section\n\n`;
      for (const sub of s.subs) md += `- [${s.number === 0 ? '' : `${sub.label} `}${escapeLinkText(sub.head.title)}](./${sub.file})\n`;
    }
    files.push({ path: s.file, content: repoint(tidyBlock(md), s.file) });

    for (const sub of s.subs) {
      const content = `# ${sub.head.title}\n\n[← Back to ${escapeLinkText(s.head.title)}](./${s.file})\n\n${sub.content}\n`;
      files.push({ path: sub.file, content: repoint(tidyBlock(content), sub.file) });
    }
  }

  const preamble = slice(0, tops[0].line);
  let index = `# ${title}\n\n`;
  if (sourceUrl) index += `Source: ${sourceUrl}\n`;
  if (sha) index += `Commit: \`${sha}\`\n`;
  index += '\n';
  if (preamble) index += `${stripFirstHeading(preamble)}\n\n`;
  index += `## ${tocTitle}\n\n`;
  for (const s of sections) {
    index += `- [${s.number}. ${escapeLinkText(s.head.title)}](./${s.file})\n`;
    for (const sub of s.subs) {
      index += `  - [${sub.label} ${escapeLinkText(sub.head.title)}](./${sub.file})\n`;
    }
  }
  files.push({ path: indexFile, content: repoint(tidyBlock(index), indexFile) });

  return { files, index: indexFile };
}

/** Drop the document's own title and any leading HTML comment. */
function stripFirstHeading(text) {
  return text
    .replace(/^\s*<!--[\s\S]*?-->\s*/, '')
    .replace(/^#\s+.*\n?/, '')
    .trim();
}

function tidyBlock(text) {
  return `${text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
