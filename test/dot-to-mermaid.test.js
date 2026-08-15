import test from 'node:test';
import assert from 'node:assert/strict';
import { dotToMermaid, escapeLabel, parse } from '../src/dot-to-mermaid.js';
import { dotCorpus } from './helpers.js';

test('parses the DOT grammar constructs CodeWiki and Graphviz emit', async (t) => {
  const cases = {
    'edge chain': ['digraph{a->b->c;}', { nodes: 3, edges: 2 }],
    'group endpoints': ['digraph{ {a b} -> {c d}; }', { nodes: 4, edges: 4 }],
    'subgraph as endpoint': ['digraph{ subgraph cluster_0 {x; y} -> z; }', { nodes: 3, edges: 2 }],
    'ports and compass': ['digraph{ a:head:n -> b:f0; }', { nodes: 2, edges: 1 }],
    'html label': ['digraph{ a [label=<<b>Bold</b><br/>two>]; }', { nodes: 1, edges: 0 }],
    'record label': ['digraph{ a [shape=record, label="{<f0> A|<f1> B}"]; }', { nodes: 1, edges: 0 }],
    'quoted escapes': ['digraph{ "a\\"q" -> "b"; }', { nodes: 2, edges: 1 }],
    'string concatenation': ['digraph{ a [label="one" + " two"]; }', { nodes: 1, edges: 0 }],
    'line continuation': ['digraph{ a [label="one\\\ntwo"]; }', { nodes: 1, edges: 0 }],
    'comments': ['digraph{ // c\n /* b */ a->b; # pre\n}', { nodes: 2, edges: 1 }],
    'undirected graph': ['graph{ a -- b; }', { nodes: 2, edges: 1 }],
    'strict keyword': ['strict digraph{ a->b; }', { nodes: 2, edges: 1 }],
    'attribute defaults': ['digraph{ node[shape=diamond]; edge[style=dashed]; a->b; }', { nodes: 2, edges: 1 }],
    'unicode identifiers': ['digraph{ "节点A" -> "ノードB"; }', { nodes: 2, edges: 1 }],
    'empty attribute list': ['digraph{ a []; a->b []; }', { nodes: 2, edges: 1 }],
    'numeral identifiers': ['digraph{ 1 -> 2; }', { nodes: 2, edges: 1 }],
    'no semicolons': ['digraph{ a->b b->c }', { nodes: 3, edges: 2 }],
    'nested subgraphs': ['digraph{ subgraph cluster_a { subgraph cluster_b { x } y } }', { nodes: 2, edges: 0 }],
    'mermaid reserved names': ['digraph{ end -> graph; }', { nodes: 2, edges: 1 }],
    'comma-separated attrs': ['digraph{ a [color=red, shape=box, style=filled]; }', { nodes: 1, edges: 0 }],
    'trailing junk': ['digraph{ a->b; } trailing', { nodes: 2, edges: 1 }],
    'unterminated graph': ['digraph{ a->b;', { nodes: 2, edges: 1 }],
  };

  for (const [name, [src, expected]] of Object.entries(cases)) {
    await t.test(name, () => {
      const g = parse(src);
      assert.equal(g.nodes.size, expected.nodes, 'node count');
      assert.equal(g.edges.length, expected.edges, 'edge count');
      assert.ok(dotToMermaid(src), 'produces Mermaid');
    });
  }
});

test('returns null rather than throwing on input that is not a graph', () => {
  assert.equal(dotToMermaid('not dot at all'), null);
  assert.equal(dotToMermaid(''), null);
  assert.equal(dotToMermaid('digraph {}'), null);
});

test('escapes characters that break Mermaid\'s lexer', async (t) => {
  await t.test('backticks become entity codes', () => {
    // A raw backtick in a label ends Mermaid parsing with a lexical error.
    assert.equal(escapeLabel('`code`'), '#96;code#96;');
    assert.ok(!dotToMermaid('digraph{ a [label="`x`"]; }').includes('`x`'));
  });

  await t.test('hash and double quote become entity codes', () => {
    assert.equal(escapeLabel('C# "x"'), 'C#35; #quot;x#quot;');
  });

  await t.test('all three Graphviz line breaks become <br/>', () => {
    // \l (left-justified) is as common as \n in Graphviz labels.
    assert.equal(escapeLabel('l1\\nl2'), 'l1<br/>l2');
    assert.equal(escapeLabel('l1\\ll2'), 'l1<br/>l2');
    assert.equal(escapeLabel('l1\\rl2'), 'l1<br/>l2');
    assert.equal(escapeLabel('a\\lb\\lc\\l'), 'a<br/>b<br/>c');
  });

  await t.test('a lone backslash is not eaten as an escape', () => {
    assert.equal(escapeLabel('C:\\\\path'), 'C:\\path');
  });

  await t.test('record syntax becomes line breaks with ports removed', () => {
    assert.equal(escapeLabel('{<head>Name|field one|field two}'), 'Name<br/>field one<br/>field two');
  });

  await t.test('brackets, braces and parens survive inside quoted labels', () => {
    assert.equal(escapeLabel('arr[0] {k:v} (n)'), 'arr[0] {k:v} (n)');
  });
});

test('node identifiers are unique and never collide', async (t) => {
  await t.test('distinct names that sanitize alike stay distinct', () => {
    const out = dotToMermaid('digraph{ "a b" -> "a-b"; "a.b" -> "a/b"; }');
    const ids = [...out.matchAll(/^\s{2}(\w+)\[/gm)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, `ids must be unique: ${ids}`);
    assert.equal(ids.length, 4);
  });

  await t.test('names that sanitize to nothing get sequential ids', () => {
    // Previously these collapsed toward a shared "n_" prefix.
    const out = dotToMermaid('digraph{ "节点" -> "ノード"; "節點" -> "ノード"; }');
    const ids = [...out.matchAll(/^\s{2}(\w+)\[/gm)].map((m) => m[1]);
    assert.equal(new Set(ids).size, 3);
    for (const id of ids) assert.match(id, /^node\d+$/);
  });

  await t.test('Mermaid reserved words are suffixed', () => {
    const out = dotToMermaid('digraph{ end -> graph; }');
    assert.match(out, /end_\[/);
    assert.match(out, /graph_\[/);
    assert.doesNotMatch(out, /^\s{2}end\[/m);
  });
});

test('maps Graphviz semantics onto Mermaid', async (t) => {
  await t.test('rankdir sets flowchart direction', () => {
    assert.match(dotToMermaid('digraph{rankdir=LR; a->b;}'), /^flowchart LR/);
    assert.match(dotToMermaid('digraph{rankdir=TD; a->b;}'), /^flowchart TD/);
    assert.match(dotToMermaid('digraph{a->b;}'), /^flowchart TD/);
  });

  await t.test('edge styles map to Mermaid connectors', () => {
    assert.match(dotToMermaid('digraph{a->b [style=dashed];}'), /-\.->/);
    assert.match(dotToMermaid('digraph{a->b [dir=both];}'), /<-->/);
    assert.match(dotToMermaid('graph{a--b;}'), / --- /);
  });

  await t.test('edge labels are carried through', () => {
    assert.match(dotToMermaid('digraph{a->b [label="calls"];}'), /-->\|"calls"\|/);
  });

  await t.test('clusters become subgraphs', () => {
    const out = dotToMermaid('digraph{ subgraph cluster_x { label="Group"; a; b } a->b; }');
    assert.match(out, /subgraph \w+\["Group"\]/);
    assert.match(out, /^\s{2}end$/m);
  });

  await t.test('shapes map to Mermaid node forms', () => {
    assert.match(dotToMermaid('digraph{a [shape=diamond];}'), /\{"a"\}/);
    assert.match(dotToMermaid('digraph{a [shape=ellipse];}'), /\(\("a"\)\)/);
    assert.match(dotToMermaid('digraph{a [shape=cylinder];}'), /\[\("a"\)\]/);
  });
});

test('converts every diagram in the captured corpus without loss', () => {
  const corpus = dotCorpus();
  assert.ok(corpus.length >= 90, `expected a real corpus, got ${corpus.length}`);

  let nodes = 0; let edges = 0; let labelled = 0;
  let outNodes = 0; let outEdges = 0; let outLabelled = 0;

  for (const { dot } of corpus) {
    const g = parse(dot);
    nodes += g.nodes.size;
    edges += g.edges.length;
    // An explicit label="" is not a label; emitting |""| would render an
    // empty label box. The corpus contains four such edges.
    labelled += g.edges.filter((e) => e.attrs.label !== undefined && e.attrs.label !== '').length;

    const mermaid = dotToMermaid(dot);
    assert.ok(mermaid, 'every corpus graph converts');

    for (const line of mermaid.split('\n').slice(1)) {
      const t = line.trim();
      if (!t || t === 'end' || t.startsWith('subgraph')) continue;
      if (/(-->|---|-\.->|-\.-|<-->|<-\.->)/.test(t)) {
        outEdges++;
        if (t.includes('|')) outLabelled++;
      } else if (/^\S+[[({]/.test(t)) outNodes++;
    }
  }

  assert.equal(outNodes, nodes, 'every node reaches the output');
  assert.equal(outEdges, edges, 'every edge reaches the output');
  assert.equal(outLabelled, labelled, 'every edge label reaches the output');
});
