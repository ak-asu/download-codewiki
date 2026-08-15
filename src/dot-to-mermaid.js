/**
 * Graphviz DOT -> Mermaid flowchart conversion.
 *
 * Works from DOT source rather than Graphviz's rendered SVG. Reading topology
 * back out of rendered geometry loses edges silently; the source states it.
 *
 * Tokenizer + recursive-descent parser over the DOT grammar
 * (https://graphviz.org/doc/info/lang.html), then a Mermaid emitter.
 */

// ---------------------------------------------------------------- tokenizer

const PUNCT = new Set(['{', '}', '[', ']', ';', ',', '=', ':']);
const KEYWORDS = new Set(['graph', 'digraph', 'subgraph', 'node', 'edge', 'strict']);

/**
 * Quoted-string values keep their backslash escapes intact. Unescaping happens
 * in escapeLabel, so a lone backslash in a label (`C:\path`) is not mistaken
 * for the start of an escape sequence and silently eaten.
 */
export function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];

    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }

    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // A '#' line is a C preprocessor directive in DOT: skip the whole line.
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }

    if (c === '-' && (src[i + 1] === '>' || src[i + 1] === '-')) {
      toks.push({ type: 'edgeop', value: src.slice(i, i + 2) });
      i += 2;
      continue;
    }

    if (PUNCT.has(c)) { toks.push({ type: 'punct', value: c }); i++; continue; }

    // Double-quoted string: \" escapes, backslash-newline continuation,
    // and "a" + "b" concatenation.
    if (c === '"') {
      let value = '';
      for (;;) {
        i++;
        while (i < n && src[i] !== '"') {
          if (src[i] === '\\') {
            if (src[i + 1] === '\n') { i += 2; continue; }   // line continuation
            value += src[i] + (src[i + 1] ?? '');
            i += 2;
            continue;
          }
          value += src[i++];
        }
        i++;
        let j = i;
        while (j < n && /\s/.test(src[j])) j++;
        if (src[j] === '+') {
          j++;
          while (j < n && /\s/.test(src[j])) j++;
          if (src[j] === '"') { i = j; continue; }
        }
        break;
      }
      toks.push({ type: 'id', value, quoted: true });
      continue;
    }

    // HTML-like string <...>, matched by balancing angle brackets.
    if (c === '<') {
      let depth = 0;
      let j = i;
      let value = '';
      while (j < n) {
        if (src[j] === '<') depth++;
        else if (src[j] === '>') {
          depth--;
          if (depth === 0) { value += '>'; j++; break; }
        }
        value += src[j++];
      }
      i = j;
      toks.push({ type: 'id', value, html: true });
      continue;
    }

    if (/[0-9.\-+]/.test(c)) {
      const m = /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)/.exec(src.slice(i));
      if (m) { toks.push({ type: 'id', value: m[0] }); i += m[0].length; continue; }
    }

    const m = /^[a-zA-Z_\u0080-\uffff][a-zA-Z_0-9\u0080-\uffff]*/.exec(src.slice(i));
    if (m) {
      const value = m[0];
      const keyword = value.toLowerCase();
      toks.push({ type: KEYWORDS.has(keyword) ? 'keyword' : 'id', value, keyword });
      i += value.length;
      continue;
    }

    i++; // unknown character: skip rather than throw, so malformed input degrades
  }
  return toks;
}

// ------------------------------------------------------------------ parser

/** Parse DOT source into { directed, strict, attrs, nodes, edges, clusters }. */
export function parse(src) {
  const toks = tokenize(src);
  let p = 0;

  const peek = (k = 0) => toks[p + k];
  const isPunct = (v, k = 0) => peek(k)?.type === 'punct' && peek(k).value === v;
  const isKw = (v, k = 0) => peek(k)?.type === 'keyword' && peek(k).keyword === v;
  const eat = () => toks[p++];
  const expect = (v) => { if (isPunct(v)) return eat(); throw new Error(`DOT: expected '${v}'`); };

  const graph = {
    directed: false,
    strict: false,
    name: null,
    attrs: {},
    nodes: new Map(),
    edges: [],
    clusters: [],
  };

  function node(name) {
    if (!graph.nodes.has(name)) graph.nodes.set(name, { name, attrs: {}, cluster: null });
    return graph.nodes.get(name);
  }

  function parseAttrList() {
    const attrs = {};
    while (isPunct('[')) {
      eat();
      while (!isPunct(']')) {
        if (!peek()) return attrs;
        if (isPunct(';') || isPunct(',')) { eat(); continue; }
        const key = eat();
        if (isPunct('=')) {
          eat();
          const val = eat();
          if (key && val) attrs[String(key.value).toLowerCase()] = val.html ? { html: val.value } : val.value;
        } else if (key) {
          attrs[String(key.value).toLowerCase()] = 'true';
        }
      }
      expect(']');
    }
    return attrs;
  }

  // node_id : ID [ ':' port [ ':' compass ] ]
  function parseNodeId() {
    const t = eat();
    const name = t ? String(t.value) : '';
    while (isPunct(':')) { eat(); if (peek() && !isPunct('{')) eat(); }
    return name;
  }

  function parseStmtList(ctx) {
    const produced = [];
    while (peek() && !isPunct('}')) {
      if (isPunct(';') || isPunct(',')) { eat(); continue; }

      // graph/node/edge attribute defaults
      if ((isKw('graph') || isKw('node') || isKw('edge')) && isPunct('[', 1)) {
        const kind = eat().keyword;
        const attrs = parseAttrList();
        if (kind === 'node') Object.assign(ctx.nodeDefaults, attrs);
        else if (kind === 'edge') Object.assign(ctx.edgeDefaults, attrs);
        else Object.assign(ctx.graphAttrs, attrs);
        continue;
      }

      if (isKw('subgraph') || isPunct('{')) {
        let id = null;
        if (isKw('subgraph')) { eat(); if (peek() && !isPunct('{')) id = String(eat().value); }
        expect('{');
        const sub = {
          id: id ?? `_anon${ctx.anon++}`,
          isCluster: !!(id && /^cluster/i.test(id)),
          graphAttrs: { ...ctx.graphAttrs },
          nodeDefaults: { ...ctx.nodeDefaults },
          edgeDefaults: { ...ctx.edgeDefaults },
          anon: ctx.anon,
          clusters: ctx.clusters,
        };
        const inner = parseStmtList(sub);
        ctx.anon = sub.anon;
        expect('}');
        if (sub.isCluster) {
          sub.label = sub.graphAttrs.label ?? sub.id;
          ctx.clusters.push(sub);
          // innermost cluster wins
          for (const nm of inner) {
            const nd = graph.nodes.get(nm);
            if (nd && !nd.cluster) nd.cluster = sub.id;
          }
        }
        if (peek()?.type === 'edgeop') parseEdgeRHS(inner, ctx);
        produced.push(...inner);
        continue;
      }

      // ID '=' ID  -> graph attribute
      if (peek() && (peek().type === 'id' || peek().type === 'keyword') && isPunct('=', 1)) {
        const key = String(eat().value).toLowerCase();
        eat();
        const val = eat();
        if (val) ctx.graphAttrs[key] = val.html ? { html: val.value } : val.value;
        continue;
      }

      if (peek() && (peek().type === 'id' || peek().type === 'keyword')) {
        const name = parseNodeId();
        const nd = node(name);
        for (const [k, v] of Object.entries(ctx.nodeDefaults)) if (!(k in nd.attrs)) nd.attrs[k] = v;
        if (peek()?.type === 'edgeop') parseEdgeRHS([name], ctx);
        else Object.assign(nd.attrs, parseAttrList());
        produced.push(name);
        continue;
      }

      eat();
    }
    return produced;
  }

  function parseEdgeRHS(lhs, ctx) {
    let left = lhs;
    const hops = [];
    while (peek()?.type === 'edgeop') {
      const op = eat().value;
      let right;
      if (isKw('subgraph') || isPunct('{')) {
        if (isKw('subgraph')) { eat(); if (peek() && !isPunct('{')) eat(); }
        expect('{');
        const sub = {
          id: `_anon${ctx.anon++}`, isCluster: false,
          graphAttrs: { ...ctx.graphAttrs }, nodeDefaults: { ...ctx.nodeDefaults },
          edgeDefaults: { ...ctx.edgeDefaults }, anon: ctx.anon, clusters: ctx.clusters,
        };
        right = parseStmtList(sub);
        ctx.anon = sub.anon;
        expect('}');
      } else {
        const nm = parseNodeId();
        const nd = node(nm);
        for (const [k, v] of Object.entries(ctx.nodeDefaults)) if (!(k in nd.attrs)) nd.attrs[k] = v;
        right = [nm];
      }
      hops.push({ op, left, right });
      left = right;
    }
    const attrs = parseAttrList();
    for (const hop of hops) {
      for (const a of hop.left) {
        for (const b of hop.right) {
          graph.edges.push({ from: a, to: b, op: hop.op, attrs: { ...ctx.edgeDefaults, ...attrs } });
        }
      }
    }
  }

  if (isKw('strict')) { eat(); graph.strict = true; }
  if (isKw('digraph')) { eat(); graph.directed = true; }
  else if (isKw('graph')) { eat(); graph.directed = false; }
  else throw new Error('DOT: expected "graph" or "digraph"');
  if (peek() && !isPunct('{')) graph.name = String(eat().value);
  expect('{');

  const root = { graphAttrs: {}, nodeDefaults: {}, edgeDefaults: {}, clusters: graph.clusters, anon: 0 };
  parseStmtList(root);
  graph.attrs = root.graphAttrs;
  return graph;
}

// ----------------------------------------------------------------- emitter

const MERMAID_RESERVED = new Set([
  'graph', 'subgraph', 'end', 'class', 'classdef', 'click', 'style', 'linkstyle',
  'direction', 'flowchart', 'default', 'o', 'x',
]);

/**
 * Escape a label for use inside a Mermaid `["..."]` quoted string.
 *
 * Backtick, '#' and '"' are escaped as HTML entity codes: Mermaid's lexer
 * treats all three as significant even inside quotes.
 */
export function escapeLabel(raw) {
  let s = String(raw);

  // Single left-to-right pass so `\\l` (escaped backslash then l) is not
  // mistaken for the line-break escape `\l`.
  s = s.replace(/\\([\s\S])/g, (_, c) => {
    if (c === 'l' || c === 'n' || c === 'r') return '\n';
    if (c === '\\' || c === '"') return c;
    if ('GNETHL'.includes(c)) return '';   // graphviz name placeholders
    return '\\' + c;                       // not an escape: keep both chars
  });

  // Graphviz record label: {<port> Label | field | field}
  s = s.replace(/^\s*\{([\s\S]*)\}\s*$/, '$1');
  s = s.replace(/<[a-zA-Z_][a-zA-Z0-9_]*>/g, '');
  s = s.replace(/\|/g, '\n');

  s = s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');

  s = s.replace(/#/g, '#35;').replace(/"/g, '#quot;').replace(/`/g, '#96;');
  s = s.replace(/\n/g, '<br/>');
  return s.replace(/[ \t]+/g, ' ').trim();
}

/** Reduce a Graphviz HTML-like label to text, preserving <br/> breaks. */
export function htmlLabelToText(html) {
  let s = String(html).replace(/^</, '').replace(/>$/, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(td|tr|th|p|div)>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

const SHAPE_WRAP = {
  box: ['["', '"]'], rect: ['["', '"]'], rectangle: ['["', '"]'], square: ['["', '"]'],
  none: ['["', '"]'], plaintext: ['["', '"]'], plain: ['["', '"]'], record: ['["', '"]'],
  note: ['["', '"]'], tab: ['["', '"]'], house: ['["', '"]'],
  mrecord: ['("', '")'],
  ellipse: ['(("', '"))'], oval: ['(("', '"))'], circle: ['(("', '"))'],
  doublecircle: ['((("', '")))'],
  diamond: ['{"', '"}'], mdiamond: ['{"', '"}'],
  parallelogram: ['[/"', '"/]'],
  cylinder: ['[("', '")]'], folder: ['[("', '")]'],
  hexagon: ['{{"', '"}}'],
  component: ['[["', '"]]'], box3d: ['[["', '"]]'],
  cds: ['>"', '"]'],
};

const DIRECTION = { tb: 'TD', td: 'TD', lr: 'LR', rl: 'RL', bt: 'BT' };

function attrValue(v) {
  if (v && typeof v === 'object' && 'html' in v) return htmlLabelToText(v.html);
  return v;
}

/**
 * Deterministic, collision-free Mermaid identifiers.
 *
 * Two distinct DOT names must never collapse onto one Mermaid id, and a name
 * that sanitizes away entirely (a CJK-only id) gets a sequential fallback
 * rather than degenerating toward a shared prefix.
 */
function makeIdFactory(prefix = 'node') {
  const used = new Set();
  const map = new Map();
  let counter = 0;
  return (raw) => {
    const key = String(raw);
    if (map.has(key)) return map.get(key);
    let base = key.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    if (!/[a-zA-Z0-9]/.test(base)) base = `${prefix}${++counter}`;
    else if (/^[0-9]/.test(base)) base = `n_${base}`;
    if (MERMAID_RESERVED.has(base.toLowerCase())) base += '_';
    let id = base;
    let k = 2;
    while (used.has(id)) id = `${base}_${k++}`;
    used.add(id);
    map.set(key, id);
    return id;
  };
}

/**
 * Convert Graphviz DOT source to a Mermaid flowchart.
 * Returns null when the source cannot be parsed or contains no nodes,
 * so callers can fall back to the original block.
 */
export function dotToMermaid(dotSource) {
  let g;
  try { g = parse(dotSource); } catch { return null; }
  if (!g.nodes.size) return null;

  const dir = DIRECTION[String(attrValue(g.attrs.rankdir) ?? 'TB').toLowerCase()] ?? 'TD';
  const idOf = makeIdFactory();
  const clusterIdOf = makeIdFactory('cluster');
  const lines = [`flowchart ${dir}`];
  const emitted = new Set();

  const nodeLine = (nd) => {
    const shape = String(attrValue(nd.attrs.shape) ?? 'box').toLowerCase();
    const rawLabel = nd.attrs.label !== undefined ? attrValue(nd.attrs.label) : nd.name;
    const label = escapeLabel(rawLabel === '' ? nd.name : rawLabel);
    const [open, close] = SHAPE_WRAP[shape] ?? SHAPE_WRAP.box;
    return `${idOf(nd.name)}${open}${label}${close}`;
  };

  for (const cl of g.clusters) {
    const members = [...g.nodes.values()].filter((nd) => nd.cluster === cl.id);
    if (!members.length) continue;
    lines.push(`  subgraph ${clusterIdOf(cl.id)}["${escapeLabel(attrValue(cl.label) ?? cl.id)}"]`);
    for (const nd of members) {
      lines.push(`    ${nodeLine(nd)}`);
      emitted.add(nd.name);
    }
    lines.push('  end');
  }

  for (const nd of g.nodes.values()) {
    if (!emitted.has(nd.name)) lines.push(`  ${nodeLine(nd)}`);
  }

  for (const e of g.edges) {
    const style = String(attrValue(e.attrs.style) ?? '').toLowerCase();
    const edgeDir = String(attrValue(e.attrs.dir) ?? '').toLowerCase();
    const dashed = /dashed|dotted/.test(style);
    const undirected = e.op === '--' || edgeDir === 'none';
    const both = edgeDir === 'both';

    let arrow;
    if (undirected) arrow = dashed ? '-.-' : '---';
    else if (both) arrow = dashed ? '<-.->' : '<-->';
    else arrow = dashed ? '-.->' : '-->';

    const raw = e.attrs.label !== undefined ? attrValue(e.attrs.label)
      : (e.attrs.xlabel !== undefined ? attrValue(e.attrs.xlabel) : '');
    const label = escapeLabel(raw);
    lines.push(`  ${idOf(e.from)} ${label ? `${arrow}|"${label}"|` : arrow} ${idOf(e.to)}`);
  }

  return lines.join('\n');
}
