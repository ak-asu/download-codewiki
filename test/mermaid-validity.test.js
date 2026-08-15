/**
 * Asserts that generated diagrams are not merely well-formed strings but
 * something Mermaid actually accepts. Every escaper rule exists because a real
 * label broke this parse.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dotToMermaid } from '../src/dot-to-mermaid.js';
import { dotCorpus } from './helpers.js';

/**
 * Mermaid needs a DOM. Importing it bare fails with
 * "DOMPurify.sanitize is not a function", and on Node 22 assigning to
 * globalThis.navigator throws because it is a getter-only property.
 */
async function loadMermaid() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Element = dom.window.Element;
  globalThis.SVGElement = dom.window.SVGElement;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  globalThis.DOMPurify = (await import('dompurify')).default(dom.window);

  const mermaid = (await import('mermaid')).default;
  mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });
  return mermaid;
}

test('every diagram in the corpus parses as Mermaid', async () => {
  const mermaid = await loadMermaid();
  const corpus = dotCorpus();
  const failures = [];

  for (const { dot, repo } of corpus) {
    const src = dotToMermaid(dot);
    if (!src) { failures.push([repo, 'no output']); continue; }
    try {
      await mermaid.parse(src);
    } catch (err) {
      failures.push([repo, String(err.message).split('\n')[0]]);
    }
  }
  assert.deepEqual(failures, [], `Mermaid rejected ${failures.length} of ${corpus.length} diagrams`);
});

test('labels that previously broke the Mermaid lexer now parse', async () => {
  const mermaid = await loadMermaid();
  const tricky = {
    backticks: 'digraph{ a [label="`code` **bold**"]; }',
    'hash and quotes': 'digraph{ a [label="C# \\"x\\" #1 100%"]; }',
    'brackets and braces': 'digraph{ a [label="arr[0] {k:v} (n)"]; }',
    'pipe in label': 'digraph{ a [label="a|b;c,d"]; }',
    'arrow in edge label': 'digraph{ a->b [label="a -> b --x"]; }',
    'quotes in edge label': 'digraph{ a->b [label="say \\"hi\\""]; }',
    'unicode only': 'digraph{ "节点" -> "ノード"; }',
    emoji: 'digraph{ a [label="ok ✅ 🚀"]; }',
    'graphviz line breaks': 'digraph{ a [label="l1\\nl2\\ll3\\rl4"]; }',
    'html entities': 'digraph{ a [label="a &amp; b &lt;c&gt;"]; }',
    'record with ports': 'digraph{ a [shape=record,label="{<h>Head|line two}"]; }',
    'reserved words': 'digraph{ end -> graph; }',
  };

  for (const [name, dot] of Object.entries(tricky)) {
    const src = dotToMermaid(dot);
    assert.ok(src, `${name}: produced output`);
    await assert.doesNotReject(() => mermaid.parse(src), `${name}: Mermaid accepts it`);
  }
});
