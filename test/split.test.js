import test from 'node:test';
import assert from 'node:assert/strict';
import { slugifyFilename, splitDocument } from '../src/split.js';
import { buildDocument } from '../src/index.js';
import { normalizePayload, parseBatchExecute } from '../src/codewiki-client.js';
import { opencodeWiki } from './helpers.js';

const wiki = () => normalizePayload(parseBatchExecute(opencodeWiki()),
  { owner: 'anomalyco', repo: 'opencode' });

test('slugifyFilename keeps unicode letters and digits', () => {
  assert.equal(slugifyFilename('Core Application Packages'), 'Core-Application-Packages');
  assert.equal(slugifyFilename('C# (Mono) Build'), 'C-Mono-Build');
  assert.equal(slugifyFilename('中文 标题'), '中文-标题');
  assert.equal(slugifyFilename('***'), 'section');
  assert.equal(slugifyFilename('  spaced  out  '), 'spaced-out');
});

const sample = [
  '# CodeWiki: o/r', '', 'Intro prose.', '',
  '## One', '', 'One intro.', '',
  '### One A', '', 'Body of one A, linking to [two](#two).', '',
  '### One B', '', 'Body of one B.', '',
  '## Two', '', 'Body of two, linking to [one a](#one-a).', '',
].join('\n');

test('splits into an index plus one file per section', () => {
  const { files, index } = splitDocument(sample, { title: 'CodeWiki: o/r' });
  const names = files.map((f) => f.path).sort();

  assert.equal(index, '0-Index.md');
  assert.deepEqual(names, [
    '0-Index.md', '1-One.md', '1.1-One-A.md', '1.2-One-B.md', '2-Two.md',
  ]);
});

test('the index links to every section and subsection', () => {
  const { files } = splitDocument(sample, { title: 'CodeWiki: o/r', sourceUrl: 'https://x', sha: 'abc' });
  const idx = files.find((f) => f.path === '0-Index.md').content;

  assert.match(idx, /^# CodeWiki: o\/r$/m);
  assert.match(idx, /Source: https:\/\/x/);
  assert.match(idx, /Commit: `abc`/);
  assert.match(idx, /- \[1\. One\]\(\.\/1-One\.md\)/);
  assert.match(idx, /  - \[1\.1 One A\]\(\.\/1\.1-One-A\.md\)/);
  assert.match(idx, /- \[2\. Two\]\(\.\/2-Two\.md\)/);
  assert.match(idx, /Intro prose\./);
});

test('section files carry navigation back to their parent', () => {
  const { files } = splitDocument(sample, { title: 't' });
  const one = files.find((f) => f.path === '1-One.md').content;
  const oneA = files.find((f) => f.path === '1.1-One-A.md').content;

  assert.match(one, /\[← Back to index\]\(\.\/0-Index\.md\)/);
  assert.match(one, /## In this section/);
  assert.match(one, /- \[1\.1 One A\]\(\.\/1\.1-One-A\.md\)/);
  assert.match(oneA, /\[← Back to One\]\(\.\/1-One\.md\)/);
  assert.match(oneA, /Body of one A/);
});

test('cross-section anchor links are repointed at the owning file', () => {
  const { files } = splitDocument(sample, { title: 't' });
  const oneA = files.find((f) => f.path === '1.1-One-A.md').content;
  const two = files.find((f) => f.path === '2-Two.md').content;

  // A link that crossed a file boundary must name the file it landed in.
  assert.match(oneA, /\[two\]\(\.\/2-Two\.md#two\)/);
  assert.match(two, /\[one a\]\(\.\/1\.1-One-A\.md#one-a\)/);
});

test('filename collisions are disambiguated', () => {
  const dup = [
    '# T', '',
    '## Same Name', '', 'a', '',
    '## Same Name', '', 'b', '',
  ].join('\n');
  const { files } = splitDocument(dup, { title: 't' });
  const names = files.map((f) => f.path);
  assert.equal(new Set(names).size, names.length, `unique filenames: ${names}`);
});

test('a document with no sections still produces an index', () => {
  const { files, index } = splitDocument('# Only a title\n\nSome prose.', { title: 't' });
  assert.equal(files.length, 1);
  assert.equal(index, '0-Index.md');
});

test('splits the real opencode document', () => {
  const w = wiki();
  const doc = buildDocument(w, { owner: 'anomalyco', repo: 'opencode', diagrams: 'dot', toc: false });
  const { files } = splitDocument(doc.markdown, { title: 'CodeWiki: anomalyco/opencode' });

  assert.equal(new Set(files.map((f) => f.path)).size, files.length);
  // 11 top-level sections plus their subsections plus the index.
  assert.ok(files.length > 40, `expected many files, got ${files.length}`);

  for (const f of files) {
    assert.ok(f.content.trim().startsWith('#'), `${f.path} starts with a heading`);
    assert.doesNotMatch(f.content, /\]\(%2F/i, `${f.path} has no unrewritten links`);
  }
});
