/**
 * Graphviz *rendered SVG* -> Mermaid.
 *
 * Fallback only. Recovering topology from rendered output is lossy: measured
 * against DOT source across 92 real diagrams this recovers 522 of 567 edges.
 * `dot-to-mermaid.js` is the primary path; this exists for the case where a
 * diagram record ever carries an SVG with no DOT source.
 */

import { escapeLabel } from './dot-to-mermaid.js';

function decodeEntities(s) {
  return String(s)
    .replace(/&#45;/g, '-')
    .replace(/&#60;|&lt;/g, '<')
    .replace(/&#62;|&gt;/g, '>')
    .replace(/&#34;|&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#38;|&amp;/g, '&');
}

/** Convert a Graphviz-generated SVG to Mermaid. Returns null if it yields no nodes. */
export function svgToMermaid(svgContent) {
  const body = String(svgContent)
    .replace(/[\s\S]*?<g[^>]*id="graph0"[^>]*>/, '')
    .replace(/<\/g>\s*<\/svg>[\s\S]*$/, '');
  if (!body) return null;

  const idFor = (() => {
    const used = new Set();
    const map = new Map();
    let counter = 0;
    return (raw) => {
      if (map.has(raw)) return map.get(raw);
      let base = raw.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
      if (!/[a-zA-Z0-9]/.test(base)) base = `node${++counter}`;
      else if (/^[0-9]/.test(base)) base = `n_${base}`;
      let id = base;
      let k = 2;
      while (used.has(id)) id = `${base}_${k++}`;
      used.add(id);
      map.set(raw, id);
      return id;
    };
  })();

  const nodes = new Map();
  const nodeBlock = /<g[^>]*class="node"[^>]*>([\s\S]*?)<\/g>/g;
  let m;
  while ((m = nodeBlock.exec(body)) !== null) {
    const block = m[1];
    const title = /<title>([\s\S]*?)<\/title>/.exec(block);
    if (!title) continue;
    const name = decodeEntities(title[1]).trim();

    const parts = [];
    const textPattern = /<text[^>]*>([\s\S]*?)<\/text>/g;
    let t;
    while ((t = textPattern.exec(block)) !== null) {
      const line = decodeEntities(t[1]).trim();
      if (line) parts.push(line);
    }
    nodes.set(name, { name, label: parts.join('\n') || name });
  }
  if (!nodes.size) return null;

  const edges = [];
  const edgeBlock = /<g[^>]*class="edge"[^>]*>([\s\S]*?)<\/g>/g;
  while ((m = edgeBlock.exec(body)) !== null) {
    const block = m[1];
    const title = /<title>([\s\S]*?)<\/title>/.exec(block);
    if (!title) continue;
    const text = decodeEntities(title[1]);
    const arrow = /^([\s\S]+?)-(?:>|-)([\s\S]+)$/.exec(text);
    if (!arrow) continue;
    const label = /<text[^>]*>([\s\S]*?)<\/text>/.exec(block);
    edges.push({
      from: arrow[1].trim(),
      to: arrow[2].trim(),
      label: label ? decodeEntities(label[1]).trim() : '',
    });
  }

  const lines = ['flowchart TD'];
  for (const node of nodes.values()) {
    lines.push(`  ${idFor(node.name)}["${escapeLabel(node.label)}"]`);
  }
  for (const edge of edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    const label = escapeLabel(edge.label);
    const conn = label ? `-->|"${label}"|` : '-->';
    lines.push(`  ${idFor(edge.from)} ${conn} ${idFor(edge.to)}`);
  }
  return lines.join('\n');
}
