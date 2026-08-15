/**
 * Diagram handling.
 *
 * CodeWiki embeds each diagram twice: as Graphviz DOT source inside a ```dot
 * fence in the Markdown, and as a pre-rendered SVG in the section records.
 * Which one reaches the output is the caller's choice.
 */

import { dotToMermaid } from './dot-to-mermaid.js';
import { svgToMermaid } from './svg-to-mermaid.js';

export const DIAGRAM_MODES = ['mermaid', 'svg', 'dot', 'both'];

const DOT_FENCE = /^([ \t]*)```dot[ \t]*\n([\s\S]*?)\n[ \t]*```[ \t]*$/gm;

/**
 * CodeWiki renders diagrams for a dark background. Repaint pure white strokes
 * and fills so the SVG stays legible on a light one.
 */
export function recolorSvg(svg) {
  return String(svg)
    .replace(/stroke:\s*rgb\(255,\s*255,\s*255\)\s*!important/g, 'stroke: rgb(30, 30, 30) !important')
    .replace(/fill:\s*rgb\(255,\s*255,\s*255\)\s*!important/g, 'fill: rgb(30, 30, 30) !important');
}

/**
 * Index the SVGs carried by section records, keyed by their DOT source, so a
 * ```dot fence can be matched to its rendering exactly rather than by position.
 */
function indexSvgs(sections = []) {
  const byDot = new Map();
  const ordered = [];
  for (const s of sections) {
    if (!s?.svg) continue;
    ordered.push(s.svg);
    if (s.dot) byDot.set(s.dot.trim(), s.svg);
  }
  return { byDot, ordered };
}

/**
 * Replace every ```dot block according to `mode`.
 *
 * Returns { markdown, files, converted, failed }. `files` lists SVGs the caller
 * should write, as { path, content } relative to the output directory.
 */
export function transformDiagrams(md, {
  mode = 'mermaid',
  sections = [],
  diagramDir = 'diagrams',
} = {}) {
  if (!DIAGRAM_MODES.includes(mode)) {
    throw new Error(`Unknown diagram mode "${mode}". Expected one of: ${DIAGRAM_MODES.join(', ')}`);
  }

  const { byDot, ordered } = indexSvgs(sections);
  const files = [];
  let index = 0;
  let converted = 0;
  let failed = 0;

  const markdown = md.replace(DOT_FENCE, (whole, indent, dot) => {
    index += 1;
    const svg = byDot.get(dot.trim()) ?? ordered[index - 1] ?? null;

    if (mode === 'dot') return whole;

    if (mode === 'svg') {
      if (!svg) { failed += 1; return whole; }
      const file = `${diagramDir}/diagram-${String(index).padStart(3, '0')}.svg`;
      files.push({ path: file, content: recolorSvg(svg) });
      converted += 1;
      return `${indent}![Diagram ${index}](${file})`;
    }

    // A diagram we cannot convert stays as DOT source. Leaving the source in
    // place loses rendering, not content.
    const mermaid = dotToMermaid(dot) ?? (svg ? svgToMermaid(recolorSvg(svg)) : null);
    if (!mermaid) { failed += 1; return whole; }
    converted += 1;

    const block = `${indent}\`\`\`mermaid\n${mermaid}\n${indent}\`\`\``;
    if (mode === 'mermaid') return block;

    return `${block}\n\n${indent}<details>\n${indent}<summary>Graphviz source</summary>\n\n` +
      `${indent}\`\`\`dot\n${dot}\n${indent}\`\`\`\n\n${indent}</details>`;
  });

  return { markdown, files, converted, failed, total: index };
}
