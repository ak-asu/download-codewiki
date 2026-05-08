const fs = require('fs');
const path = require('path');

/**
 * Parse a Graphviz SVG and return Mermaid flowchart syntax.
 * Returns null if parsing fails or yields no nodes.
 */
function svgToMermaid(svgContent) {
  // Extract the <g class="graph"> content (the main graph body)
  const graphBody = svgContent.replace(/[\s\S]*?<g id="graph0"[^>]*>/, '').replace(/<\/g>\s*<\/svg>[\s\S]*$/, '');

  // Decode HTML entities in text content
  function decode(s) {
    return s
      .replace(/&#45;/g, '-')
      .replace(/&#38;|&amp;/g, '&')
      .replace(/&#60;|&lt;/g, '<')
      .replace(/&#62;|&gt;/g, '>')
      .replace(/&#34;|&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  // Sanitize a string for use inside Mermaid quoted labels
  function sanitize(s) {
    let t = decode(s).replace(/"/g, "'").trim();
    // Graphviz record syntax: {label|sublabel} — strip outer braces, replace | with line break
    if (t.startsWith('{') && t.endsWith('}')) t = t.slice(1, -1);
    t = t.replace(/\|/g, '<br/>');
    return t;
  }

  // Make a safe Mermaid node ID (alphanumeric + underscore)
  function safeId(s) {
    return decode(s).replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  }

  // Extract clusters (subgraphs)
  const clusters = {}; // clusterId -> { label, nodeIds: Set }
  const clusterPattern = /<g id="(cluster[^"]+)"[^>]*class="cluster"[^>]*>\s*<title>([^<]*)<\/title>\s*<[^>]+>\s*<text[^>]*>([^<]*)<\/text>/g;
  let m;
  while ((m = clusterPattern.exec(graphBody)) !== null) {
    const [, id, title, label] = m;
    clusters[id] = { id: safeId(title || id), label: sanitize(label || title), nodeIds: new Set() };
  }

  // Extract nodes
  // Each node block: <g id="nodeN" class="node">...<title>ID</title>...<text>Label</text>...</g>
  const nodes = {}; // graphviz nodeId -> { mermaidId, label }
  const nodeBlockPattern = /<g id="node\d+"[^>]*class="node"[^>]*>([\s\S]*?)<\/g>/g;
  while ((m = nodeBlockPattern.exec(graphBody)) !== null) {
    const block = m[1];
    const titleM = block.match(/<title>([^<]+)<\/title>/);
    if (!titleM) continue;
    const rawId = titleM[1];

    // Collect all <text> lines in this node for the label
    const textParts = [];
    const textPattern = /<text[^>]*>([^<]+)<\/text>/g;
    let tm;
    while ((tm = textPattern.exec(block)) !== null) {
      const t = sanitize(tm[1]);
      if (t) textParts.push(t);
    }
    const label = textParts.join(' | ') || sanitize(rawId);

    nodes[rawId] = { mermaidId: safeId(rawId), label };
  }

  if (Object.keys(nodes).length === 0) return null;

  // Extract edges
  // Edge title format: "Source->Target" or "Source->Target" with optional edge label in <text>
  const edges = [];
  const edgeBlockPattern = /<g id="edge\d+"[^>]*class="edge"[^>]*>([\s\S]*?)<\/g>/g;
  while ((m = edgeBlockPattern.exec(graphBody)) !== null) {
    const block = m[1];
    const titleM = block.match(/<title>([^<]+)<\/title>/);
    if (!titleM) continue;
    const titleText = decode(titleM[1]);
    const arrowMatch = titleText.match(/^(.+?)-&gt;(.+)$/) || titleText.match(/^(.+?)->(.+)$/);
    if (!arrowMatch) continue;
    const [, src, dst] = arrowMatch;

    // Edge label (first <text> in the block)
    const labelM = block.match(/<text[^>]*>([^<]+)<\/text>/);
    const edgeLabel = labelM ? sanitize(labelM[1]) : '';

    edges.push({ src: src.trim(), dst: dst.trim(), label: edgeLabel });
  }

  // Build Mermaid output
  const lines = ['flowchart TD'];

  // Nodes
  for (const [, node] of Object.entries(nodes)) {
    lines.push(`  ${node.mermaidId}["${node.label}"]`);
  }

  // Edges
  for (const edge of edges) {
    const srcNode = nodes[edge.src];
    const dstNode = nodes[edge.dst];
    if (!srcNode || !dstNode) continue;
    if (edge.label) {
      lines.push(`  ${srcNode.mermaidId} -->|"${edge.label}"| ${dstNode.mermaidId}`);
    } else {
      lines.push(`  ${srcNode.mermaidId} --> ${dstNode.mermaidId}`);
    }
  }

  return lines.join('\n');
}

module.exports = { svgToMermaid };

// CLI usage: node svg-to-mermaid.js diagrams/diagram-003.svg
if (require.main === module) {
  const testFile = process.argv[2] || 'diagrams/diagram-003.svg';
  const content = fs.readFileSync(testFile, 'utf8');
  console.log(svgToMermaid(content) || '(no output)');
}
