/**
 * End-to-end coverage over the real opencode payload, including explicit
 * regression tests for the two reported issues.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDocument } from '../src/index.js';
import { normalizePayload, parseBatchExecute } from '../src/codewiki-client.js';
import { collectHeadings, splitFences } from '../src/markdown.js';
import { transformDiagrams } from '../src/diagrams.js';
import { opencodeWiki } from './helpers.js';

const wiki = () => normalizePayload(parseBatchExecute(opencodeWiki()),
  { owner: 'anomalyco', repo: 'opencode' });
const build = (options = {}) =>
  buildDocument(wiki(), { owner: 'anomalyco', repo: 'opencode', ...options });

function unfenced(md) {
  return splitFences(md).filter((r) => !r.fence).map((r) => r.text).join('\n');
}

test('issue #1: tables survive as Markdown tables', () => {
  const { markdown } = build();
  const rows = unfenced(markdown).match(/^\s*\|.*\|\s*$/gm) ?? [];

  // The DOM scraper produced zero of these.
  assert.equal(rows.length, 46);
  // A real header separator proves it is a table, not text containing pipes.
  assert.match(markdown, /^\|\s*:?-{3,}/m);
  assert.match(markdown, /\| Mechanism\/Agent Name \| Purpose \| File Path \|/);
});

test('issue #2: content is distributed across its sections', async (t) => {
  const { markdown } = build();
  const headings = collectHeadings(markdown);
  const lines = markdown.split('\n');

  const bodies = headings.map((h, i) => {
    const end = i + 1 < headings.length ? headings[i + 1].line : lines.length;
    return { title: h.title, chars: lines.slice(h.line + 1, end).join('\n').trim().length };
  });

  await t.test('no single section swallows the document', () => {
    const largest = Math.max(...bodies.map((b) => b.chars));
    // The reported file had 98% of its content under the first heading.
    assert.ok(largest / markdown.length < 0.15,
      `largest section holds ${(100 * largest / markdown.length).toFixed(1)}% of the document`);
  });

  await t.test('sections are not left empty', () => {
    const thin = bodies.filter((b) => b.chars < 80);
    // Only the table-of-contents heading has no prose of its own.
    assert.ok(thin.length <= 1, `${thin.length} near-empty sections: ${thin.map((b) => b.title)}`);
  });

  await t.test('the heading hierarchy matches CodeWiki\'s section tree', () => {
    const levels = headings.reduce((acc, h) => {
      acc[h.level] = (acc[h.level] ?? 0) + 1;
      return acc;
    }, {});
    // CodeWiki's tree is 1/12/38/7 once the two body headings it emits
    // without an id are counted; the TOC heading adds one more level 2.
    assert.equal(levels[1], 1);
    assert.equal(levels[2], 13);
    assert.equal(levels[3], 38);
    assert.equal(levels[4], 7);
  });

  await t.test('a linked table of contents is present', () => {
    assert.match(markdown, /^## Table of Contents$/m);
    const entries = markdown.split('\n').filter((l) => /^\s*- \[.+\]\(#.+\)$/.test(l));
    assert.ok(entries.length >= 55, `expected a full TOC, got ${entries.length} entries`);
  });
});

test('inline links are preserved and made absolute', () => {
  const { markdown } = build();
  const links = new Set(
    [...unfenced(markdown).matchAll(/\]\((https:\/\/github\.com\/[^)]+)\)/g)].map((m) => m[1]),
  );

  // The DOM scrapers produced zero inline links. 587 come from the prose,
  // the rest from the linkified References lines.
  assert.ok(links.size >= 587, `expected at least the 587 prose links, got ${links.size}`);
  assert.equal(links.size, 617);
  assert.doesNotMatch(markdown, /\]\(%2F/i);

  // Nothing repo-relative is left unlinked on a References line.
  const bareReferences = markdown.split('\n')
    .filter((l) => l.startsWith('References:'))
    .filter((l) => /(^|[\s,])\/anomalyco\/opencode/.test(l));
  assert.deepEqual(bareReferences, []);
});

test('no CodeWiki UI chrome reaches the output', () => {
  const { markdown } = build();
  for (const junk of ['Powered by Gemini', 'zoom_in', 'content_copy', 'On this page',
    'Gemini can make mistakes']) {
    assert.doesNotMatch(markdown, new RegExp(junk), `"${junk}" must not appear`);
  }
});

test('diagram modes each produce their own output', async (t) => {
  await t.test('mermaid converts every diagram', () => {
    const doc = build({ diagrams: 'mermaid' });
    assert.equal(doc.diagrams.total, 46);
    assert.equal(doc.diagrams.converted, 46);
    assert.equal(doc.diagrams.failed, 0);
    assert.equal((doc.markdown.match(/^```mermaid$/gm) ?? []).length, 46);
    assert.doesNotMatch(doc.markdown, /^```dot$/m);
    assert.equal(doc.files.length, 0);
  });

  await t.test('dot leaves the source untouched', () => {
    const doc = build({ diagrams: 'dot' });
    assert.equal((doc.markdown.match(/^```dot$/gm) ?? []).length, 46);
    assert.doesNotMatch(doc.markdown, /^```mermaid$/m);
  });

  await t.test('svg writes files and references them', () => {
    const doc = build({ diagrams: 'svg' });
    assert.equal(doc.files.length, 46);
    assert.equal((doc.markdown.match(/!\[Diagram \d+\]\(diagrams\/diagram-\d{3}\.svg\)/g) ?? []).length, 46);
    for (const f of doc.files) {
      assert.match(f.path, /^diagrams\/diagram-\d{3}\.svg$/);
      assert.match(f.content, /^<\?xml|^<svg/);
      // Dark-mode white is repainted for light backgrounds.
      assert.doesNotMatch(f.content, /stroke:\s*rgb\(255, 255, 255\)\s*!important/);
    }
  });

  await t.test('both keeps the source alongside the diagram', () => {
    const doc = build({ diagrams: 'both' });
    assert.equal((doc.markdown.match(/^```mermaid$/gm) ?? []).length, 46);
    assert.equal((doc.markdown.match(/^```dot$/gm) ?? []).length, 46);
    assert.equal((doc.markdown.match(/<summary>Graphviz source<\/summary>/g) ?? []).length, 46);
  });

  await t.test('an unconvertible diagram keeps its source rather than vanishing', () => {
    const md = '```dot\nthis is not a graph\n```';
    const out = transformDiagrams(md, { mode: 'mermaid', sections: [] });
    assert.equal(out.markdown, md);
    assert.equal(out.failed, 1);
    assert.equal(out.converted, 0);
  });

  await t.test('an unknown mode is rejected', () => {
    assert.throws(() => transformDiagrams('', { mode: 'png' }), /Unknown diagram mode/);
  });
});

test('the document records where it came from', () => {
  const { markdown } = build();
  const w = wiki();
  assert.match(markdown, /^<!-- Generated by download-codewiki from https:\/\/codewiki\.google\/github\.com\/anomalyco\/opencode/);
  assert.ok(markdown.includes(w.sha));
});

test('every sentence of the source survives the pipeline', () => {
  // The DOM scrapers recovered 71.7% and 74.8% of these.
  const w = wiki();
  const strip = (md) => unfenced(md)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();

  const source = strip(w.markdown);
  const output = strip(build().markdown);

  const sentences = source.split(/(?<=\.) /)
    .map((s) => s.trim())
    .filter((s) => s.length > 80 && s.length < 220);

  assert.ok(sentences.length > 200, `expected a real sample, got ${sentences.length}`);
  const missing = sentences.filter((s) => !output.includes(s));
  assert.deepEqual(missing.slice(0, 3), [], `${missing.length} of ${sentences.length} sentences lost`);
});
