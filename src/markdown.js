/**
 * Markdown transforms.
 *
 * These are surgical, fence-guarded string edits rather than an AST round-trip.
 * CodeWiki's Markdown is already correct; re-serialising it through a parser
 * rewrites list markers, wrapping and escaping across the whole document. Every
 * byte we do not deliberately change is preserved.
 */

import GithubSlugger from 'github-slugger';

/**
 * Split Markdown into alternating fenced and unfenced regions.
 *
 * Tracks the opening fence character and run length so a ``` inside a ~~~ block,
 * or a shorter fence inside a longer one, cannot desynchronise the scan.
 */
export function splitFences(md) {
  const regions = [];
  let buf = [];
  let open = null; // { char, len }

  // A region holds whole lines. Zero-line regions are dropped: regions are
  // rejoined with '\n', so an empty one would insert a blank line that was
  // never in the source.
  const flush = (fence) => {
    if (buf.length) regions.push({ fence, text: buf.join('\n') });
    buf = [];
  };

  for (const line of md.split('\n')) {
    const m = /^(\s{0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (m) {
      const char = m[2][0];
      const len = m[2].length;
      const info = m[3];
      if (!open) {
        // An opening ``` fence's info string may not contain a backtick.
        if (!(char === '`' && info.includes('`'))) {
          flush(false);
          open = { char, len };
          buf.push(line);
          continue;
        }
      } else if (char === open.char && len >= open.len && !info.trim()) {
        buf.push(line);
        flush(true);
        open = null;
        continue;
      }
    }
    buf.push(line);
  }
  flush(!!open);
  return regions;
}

/** Apply a transform only to text outside fenced code blocks. */
export function outsideFences(md, fn) {
  return splitFences(md).map((r) => (r.fence ? r.text : fn(r.text))).join('\n');
}

/**
 * Rewrite CodeWiki's percent-encoded repo-relative links to absolute GitHub URLs.
 *
 * Mirrors what the CodeWiki UI emits, including `?plain=1` for line-anchored
 * Markdown files and `/blob/` for directories (GitHub 301-redirects those to
 * `/tree/`). Verified to reproduce all 587 links on anomalyco/opencode exactly.
 */
/**
 * Map one repo-relative CodeWiki path to its GitHub URL.
 * Returns null when the path belongs to a different repository.
 */
export function toGithubUrl(repoPath, { owner, repo, sha }) {
  const m = /^\/([^/#]+)\/([^/#]+)((?:\/[^#]*)?)(#.*)?$/.exec(repoPath);
  if (!m) return null;

  const [, linkOwner, linkRepo, rest = '', fragment = ''] = m;
  if (linkOwner.toLowerCase() !== owner.toLowerCase()) return null;
  if (linkRepo.toLowerCase() !== repo.toLowerCase()) return null;

  const base = `https://github.com/${owner}/${repo}`;
  const ref = sha || 'HEAD';
  const filePath = rest.replace(/^\//, '');
  if (!filePath) return `${base}/tree/${ref}`;

  const isMarkdown = /\.(md|markdown)$/i.test(filePath);
  const hasLineAnchor = /^#L\d/.test(fragment);
  const query = isMarkdown && hasLineAnchor ? '?plain=1' : '';
  return `${base}/blob/${ref}/${filePath}${query}${fragment}`;
}

export function rewriteLinks(md, options) {
  return outsideFences(md, (text) =>
    text.replace(/\]\((%2[Ff][^)\s]*)\)/g, (whole, encoded) => {
      let decoded;
      try { decoded = decodeURIComponent(encoded); } catch { return whole; }
      const url = toGithubUrl(decoded, options);
      return url ? `](${url})` : whole;
    }));
}

/**
 * Linkify the bare paths on CodeWiki's `References:` lines.
 *
 * These list each section's source files as plain text. Every other path in
 * the document becomes a clickable link, so leaving these bare is an
 * inconsistency rather than a fidelity gain.
 */
export function linkifyReferences(md, options) {
  return outsideFences(md, (text) =>
    text.replace(/^(References:[ \t]*)(.+)$/gm, (whole, prefix, list) => {
      const parts = list.split(',').map((s) => s.trim()).filter(Boolean);
      if (!parts.length || !parts.every((p) => p.startsWith('/'))) return whole;

      let changed = false;
      const linked = parts.map((p) => {
        const url = toGithubUrl(p, options);
        if (!url) return p;
        changed = true;
        return `[\`${p}\`](${url})`;
      });
      return changed ? prefix + linked.join(', ') : whole;
    }));
}

const HEADING_WITH_ID = /^(#{1,6})[ \t]+(.*?)[ \t]*\{#([^}]+)\}[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*$/;

/**
 * Reduce heading markup to the text a reader sees.
 *
 * CodeWiki emits headings containing inline links and code spans, e.g.
 * "Canonicalization of [`node_modules`](…)". GitHub slugs the rendered text,
 * and a table-of-contents label must not nest a link inside a link.
 */
export function headingText(markup) {
  return String(markup)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Collect the document's headings, honouring code fences so a `#` comment
 * inside a shell snippet is never mistaken for a heading.
 */
export function collectHeadings(md) {
  const headings = [];
  const slugger = new GithubSlugger();
  let offset = 0;

  for (const region of splitFences(md)) {
    const lines = region.text.split('\n');
    if (!region.fence) {
      lines.forEach((line, i) => {
        const withId = HEADING_WITH_ID.exec(line);
        const plain = withId ? null : HEADING.exec(line);
        const m = withId ?? plain;
        if (!m) return;
        const markup = m[2].trim();
        if (!markup) return;
        const title = headingText(markup);
        if (!title) return;
        headings.push({
          line: offset + i,
          level: m[1].length,
          title,
          markup,
          codewikiAnchor: withId ? withId[3] : null,
          slug: slugger.slug(title),
        });
      });
    }
    offset += lines.length;
  }
  return headings;
}

/**
 * Strip CodeWiki's `{#anchor}` heading syntax and repoint in-document links.
 *
 * `{#id}` is Pandoc/Obsidian syntax; GitHub renders it as literal text in the
 * heading. Links that referenced those ids are remapped to the GitHub slug of
 * the same heading, so nothing breaks.
 */
export function normalizeAnchors(md, headings = collectHeadings(md)) {
  const map = new Map();
  for (const h of headings) if (h.codewikiAnchor) map.set(h.codewikiAnchor, h.slug);

  const stripped = outsideFences(md, (text) =>
    text.replace(/^(#{1,6})[ \t]+(.*?)[ \t]*\{#([^}]+)\}[ \t]*$/gm, '$1 $2'));

  return outsideFences(stripped, (text) =>
    text.replace(/\]\(#([^)]+)\)/g, (whole, id) => (map.has(id) ? `](#${map.get(id)})` : whole)));
}

/**
 * Build a nested table of contents from the heading tree.
 *
 * This is what CodeWiki shows in its sidebar, and what the generated Markdown
 * was missing: headings existed but were neither linked nor visibly organised.
 */
export function buildToc(headings, { title = 'Table of Contents', linkFor = (h) => `#${h.slug}` } = {}) {
  const body = headings.filter((h) => h.level > 1);
  if (body.length < 2) return '';

  const minLevel = Math.min(...body.map((h) => h.level));
  const lines = body.map((h) => {
    const indent = '  '.repeat(h.level - minLevel);
    return `${indent}- [${escapeLinkText(h.title)}](${linkFor(h)})`;
  });
  return `## ${title}\n\n${lines.join('\n')}\n`;
}

/** Escape characters that would break a Markdown link label. */
export function escapeLinkText(text) {
  return String(text).replace(/([\[\]])/g, '\\$1');
}

/**
 * Insert the table of contents after the document's first heading and its
 * immediately following prose, keeping the top of the file readable.
 */
export function insertToc(md, toc) {
  if (!toc) return md;
  const lines = md.split('\n');
  const first = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (first === -1) return `${toc}\n${md}`;

  let insertAt = first + 1;
  while (insertAt < lines.length && !/^#{2,6}\s+\S/.test(lines[insertAt])) insertAt++;

  return [...lines.slice(0, insertAt), toc, ...lines.slice(insertAt)].join('\n');
}

/** Normalise excessive blank lines without touching fenced content. */
export function tidy(md) {
  return `${outsideFences(md, (t) => t.replace(/[ \t]+$/gm, '').replace(/\n{4,}/g, '\n\n\n')).trim()}\n`;
}
