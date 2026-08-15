import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildToc, collectHeadings, insertToc, linkifyReferences, normalizeAnchors, outsideFences,
  rewriteLinks, splitFences,
} from '../src/markdown.js';
import { normalizePayload, parseBatchExecute } from '../src/codewiki-client.js';
import { fixtureJson, opencodeWiki } from './helpers.js';

const wiki = () => normalizePayload(parseBatchExecute(opencodeWiki()),
  { owner: 'anomalyco', repo: 'opencode' });

test('the fence scanner tracks fence character and length', async (t) => {
  await t.test('separates fenced from unfenced text', () => {
    const regions = splitFences('a\n```js\ncode\n```\nb');
    assert.deepEqual(regions.map((r) => r.fence), [false, true, false]);
    assert.equal(regions[1].text, '```js\ncode\n```');
  });

  await t.test('a ``` inside a ~~~ block does not close it', () => {
    const md = '~~~\n```\nstill inside\n```\n~~~\nafter';
    const regions = splitFences(md);
    assert.equal(regions.filter((r) => r.fence).length, 1);
    assert.match(regions.find((r) => r.fence).text, /still inside/);
  });

  await t.test('a longer closing fence is accepted', () => {
    const regions = splitFences('````\ncode\n`````\nafter');
    assert.equal(regions.filter((r) => r.fence).length, 1);
  });

  await t.test('an unterminated fence stays fenced to the end', () => {
    const regions = splitFences('a\n```\nnever closed');
    assert.equal(regions.at(-1).fence, true);
  });

  await t.test('outsideFences leaves fenced content byte-identical', () => {
    const md = 'x\n```\nx\n```\nx';
    assert.equal(outsideFences(md, (t2) => t2.replaceAll('x', 'y')), 'y\n```\nx\n```\ny');
  });
});

test('link rewriting reproduces the links CodeWiki itself renders', () => {
  // Oracle: every github.com href in the rendered opencode page.
  const w = wiki();
  const rewritten = rewriteLinks(w.markdown, { owner: 'anomalyco', repo: 'opencode', sha: w.sha });

  const produced = new Set(
    [...rewritten.matchAll(/\]\((https:\/\/github\.com\/[^)]+)\)/g)].map((m) => m[1]),
  );
  const rendered = new Set(fixtureJson('opencode-page-hrefs.json'));

  const notInPage = [...produced].filter((u) => !rendered.has(u));
  assert.deepEqual(notInPage, [], 'every link we produce also appears in the rendered page');
  assert.equal(produced.size, 587);

  // No encoded links should survive the pass.
  assert.doesNotMatch(rewritten, /\]\(%2F/i);
});

test('link rewriting follows CodeWiki\'s own URL rules', async (t) => {
  const opts = { owner: 'o', repo: 'r', sha: 'abc123' };
  const rewrite = (target) => rewriteLinks(`[x](${target})`, opts);

  await t.test('a file becomes a blob URL', () => {
    assert.equal(rewrite('%2Fo%2Fr%2Fsrc%2Fmain.js'),
      '[x](https://github.com/o/r/blob/abc123/src/main.js)');
  });

  await t.test('a line anchor is preserved', () => {
    assert.equal(rewrite('%2Fo%2Fr%2Fsrc%2Fmain.js#L42'),
      '[x](https://github.com/o/r/blob/abc123/src/main.js#L42)');
  });

  await t.test('a Markdown file with a line anchor gets ?plain=1', () => {
    // Without it GitHub renders the file and the line anchor does nothing.
    assert.equal(rewrite('%2Fo%2Fr%2FREADME.md#L10'),
      '[x](https://github.com/o/r/blob/abc123/README.md?plain=1#L10)');
  });

  await t.test('a Markdown file without a line anchor does not', () => {
    assert.equal(rewrite('%2Fo%2Fr%2FREADME.md'),
      '[x](https://github.com/o/r/blob/abc123/README.md)');
  });

  await t.test('the repository root becomes a tree URL', () => {
    assert.equal(rewrite('%2Fo%2Fr'), '[x](https://github.com/o/r/tree/abc123)');
  });

  await t.test('a directory uses blob, as CodeWiki does; GitHub redirects', () => {
    assert.equal(rewrite('%2Fo%2Fr%2Fsrc%2Flib'),
      '[x](https://github.com/o/r/blob/abc123/src/lib)');
  });

  await t.test('links to another repository are left alone', () => {
    const other = '[x](%2Fother%2Frepo%2Ffile.js)';
    assert.equal(rewriteLinks(other, opts), other);
  });

  await t.test('links inside code fences are left alone', () => {
    const md = '```\n[x](%2Fo%2Fr%2Fa.js)\n```';
    assert.equal(rewriteLinks(md, opts), md);
  });

  await t.test('a missing sha falls back to HEAD', () => {
    assert.equal(rewriteLinks('[x](%2Fo%2Fr%2Fa.js)', { owner: 'o', repo: 'r', sha: '' }),
      '[x](https://github.com/o/r/blob/HEAD/a.js)');
  });
});

test('References lines are linkified', async (t) => {
  const opts = { owner: 'o', repo: 'r', sha: 'abc123' };

  await t.test('each bare path becomes a link', () => {
    const out = linkifyReferences('References: /o/r/core, /o/r/main/main.cpp', opts);
    assert.equal(out,
      'References: [`/o/r/core`](https://github.com/o/r/blob/abc123/core), '
      + '[`/o/r/main/main.cpp`](https://github.com/o/r/blob/abc123/main/main.cpp)');
  });

  await t.test('paths for other repositories are left alone', () => {
    const line = 'References: /other/repo/core';
    assert.equal(linkifyReferences(line, opts), line);
  });

  await t.test('a line that is not a path list is left alone', () => {
    const line = 'References: see the manual for details';
    assert.equal(linkifyReferences(line, opts), line);
  });

  await t.test('fenced content is untouched', () => {
    const md = '```\nReferences: /o/r/core\n```';
    assert.equal(linkifyReferences(md, opts), md);
  });

  await t.test('every References line in the real document is linkified', () => {
    const w = wiki();
    const out = linkifyReferences(rewriteLinks(w.markdown, { owner: 'anomalyco', repo: 'opencode', sha: w.sha }),
      { owner: 'anomalyco', repo: 'opencode', sha: w.sha });
    const lines = out.split('\n').filter((l) => l.startsWith('References:'));
    assert.equal(lines.length, 54);
    for (const line of lines) assert.match(line, /\[`\/anomalyco\/opencode/);
  });
});

test('heading collection honours code fences', () => {
  const md = [
    '# Title {#t}',
    '```bash',
    '# this is a shell comment, not a heading',
    '```',
    '## Real {#r}',
  ].join('\n');

  const headings = collectHeadings(md);
  assert.deepEqual(headings.map((h) => h.title), ['Title', 'Real']);
  assert.deepEqual(headings.map((h) => h.level), [1, 2]);
  assert.deepEqual(headings.map((h) => h.codewikiAnchor), ['t', 'r']);
});

test('anchors are stripped and in-document links repointed', async (t) => {
  await t.test('{#id} is removed from the heading', () => {
    // GitHub renders {#id} as literal text.
    const out = normalizeAnchors('## Section Title {#some-long-codewiki-id}');
    assert.equal(out, '## Section Title');
  });

  await t.test('links to the old id follow it to the GitHub slug', () => {
    const md = '## Section Title {#codewiki-nested-id}\n\nSee [it](#codewiki-nested-id).';
    const out = normalizeAnchors(md);
    assert.match(out, /\[it\]\(#section-title\)/);
  });

  await t.test('duplicate headings get GitHub\'s numeric suffixes', () => {
    // opencode really does have two "Canonicalization of node_modules".
    const md = '## Dup {#a}\n\n## Dup {#b}\n\n[one](#a) [two](#b)';
    const out = normalizeAnchors(md);
    assert.match(out, /\[one\]\(#dup\)/);
    assert.match(out, /\[two\]\(#dup-1\)/);
  });

  await t.test('unknown anchors are left untouched', () => {
    const md = '## A {#a}\n\n[x](#not-a-heading)';
    assert.match(normalizeAnchors(md), /\[x\]\(#not-a-heading\)/);
  });

  await t.test('the whole opencode document loses every {#id}', () => {
    const out = normalizeAnchors(wiki().markdown);
    assert.doesNotMatch(out, /^#{1,6} .*\{#/m);
  });
});

test('the table of contents mirrors the heading tree', async (t) => {
  const md = [
    '# Wiki', '', '## One {#one}', '', 'text', '',
    '### One A {#one-a}', '', 'text', '',
    '## Two {#two}', '', 'text',
  ].join('\n');

  await t.test('nests by heading level', () => {
    const toc = buildToc(collectHeadings(md));
    assert.equal(toc, [
      '## Table of Contents', '',
      '- [One](#one)',
      '  - [One A](#one-a)',
      '- [Two](#two)',
      '',
    ].join('\n'));
  });

  await t.test('is inserted before the first section, after the title', () => {
    const out = insertToc(md, buildToc(collectHeadings(md)));
    assert.ok(out.indexOf('## Table of Contents') > out.indexOf('# Wiki'));
    assert.ok(out.indexOf('## Table of Contents') < out.indexOf('## One'));
  });

  await t.test('is omitted when there is nothing to organise', () => {
    assert.equal(buildToc(collectHeadings('# Only a title')), '');
  });

  await t.test('covers every section of the real document', () => {
    const w = wiki();
    const normalized = normalizeAnchors(w.markdown);
    const headings = collectHeadings(normalized);
    const toc = buildToc(headings);
    const entries = toc.split('\n').filter((l) => l.trim().startsWith('- ')).length;

    assert.equal(entries, headings.filter((h) => h.level > 1).length);
    // 55 anchored sections plus two body headings CodeWiki emits without an
    // id, less the document's single h1 title.
    assert.equal(entries, 57);
    assert.equal(collectHeadings(w.markdown).filter((h) => h.codewikiAnchor).length, 55);
  });

  await t.test('a heading containing a link does not nest links in the TOC', () => {
    // CodeWiki really emits: ### Canonicalization of [`node_modules`](…)
    const md = [
      '# W', '',
      '## Canonicalization of [`node_modules`](https://example.com/x#L37)', '', 'text', '',
      '## Plain', '', 'text',
    ].join('\n');

    const headings = collectHeadings(md);
    assert.equal(headings[1].title, 'Canonicalization of node_modules');
    assert.equal(headings[1].slug, 'canonicalization-of-node_modules');

    const toc = buildToc(headings);
    assert.match(toc,
      /^- \[Canonicalization of node_modules\]\(#canonicalization-of-node_modules\)$/m);
    assert.doesNotMatch(toc, /\]\(https/);
  });
});
