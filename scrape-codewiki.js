/**
 * Usage: node scrape-codewiki.js <codewiki-url>
 * Example: node scrape-codewiki.js https://codewiki.google/github.com/microsoft/playwright
 *
 * Output:
 *   <owner>-<repo>.md   — markdown with inline Mermaid diagrams
 *   diagrams/           — SVG source files (one per diagram)
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { svgToMermaid } = require('./svg-to-mermaid');

const BASE_URL = process.argv[2] || 'https://codewiki.google/github.com/microsoft/playwright';
const DIAGRAMS_DIR = 'diagrams';

// Derive output filename from URL: .../owner/repo -> owner-repo.md
function outputFilename(url) {
  const parts = url.replace(/\/$/, '').split('/');
  const repo = parts.pop();
  const owner = parts.pop();
  return `${owner}-${repo}.md`;
}

async function run() {
  const outFile = outputFilename(BASE_URL);

  if (!fs.existsSync(DIAGRAMS_DIR)) fs.mkdirSync(DIAGRAMS_DIR);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });

  // Step 1: Load page
  console.log(`Loading ${BASE_URL} ...`);
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('svg').length > 0, { timeout: 15000 });
  await page.waitForTimeout(3000);

  // Step 2: Tag every SVG with its global index
  const totalSvgs = await page.evaluate(() => {
    document.querySelectorAll('svg').forEach((svg, i) => {
      svg.setAttribute('data-pw-idx', String(i));
    });
    return document.querySelectorAll('svg').length;
  });
  console.log(`Tagged ${totalSvgs} SVGs`);

  // Step 3: Extract base64-encoded SVG data from diagram elements
  console.log('Extracting SVG diagrams...');
  const svgDataMap = await page.evaluate(() => {
    const result = {};
    document.querySelectorAll('svg.svg-diagram').forEach(svg => {
      const idx = parseInt(svg.getAttribute('data-pw-idx'));
      const img = svg.querySelector('image');
      const href = img ? img.getAttribute('href') : null;
      if (href && href.startsWith('data:image/svg+xml;base64,')) {
        result[idx] = href.replace('data:image/svg+xml;base64,', '');
      }
    });
    return result;
  });

  const diagramFiles = {}; // global svg index -> svg filename
  const diagramMermaid = {}; // global svg index -> mermaid string (or null)
  for (const [idxStr, base64] of Object.entries(svgDataMap)) {
    const idx = parseInt(idxStr);
    // Fix dark-mode white colors so SVGs render on light backgrounds
    const svgContent = Buffer.from(base64, 'base64').toString('utf8')
      .replace(/stroke:\s*rgb\(255,\s*255,\s*255\)\s*!important/g, 'stroke: rgb(30, 30, 30) !important')
      .replace(/fill:\s*rgb\(255,\s*255,\s*255\)\s*!important/g, 'fill: rgb(30, 30, 30) !important');
    const filename = `${DIAGRAMS_DIR}/diagram-${String(idx + 1).padStart(3, '0')}.svg`;
    fs.writeFileSync(filename, svgContent, 'utf8');
    diagramFiles[idx] = filename;
    diagramMermaid[idx] = svgToMermaid(svgContent);
    process.stdout.write('.');
  }
  console.log(`\nSaved ${Object.keys(diagramFiles).length} SVG diagrams`);

  // Step 4: Extract section IDs
  const sectionIds = await page.evaluate(() =>
    Array.from(document.querySelectorAll('div[id]'))
      .map(el => el.id)
      .filter(id => id && !id.startsWith('clip') && !id.startsWith('bw') && !id.startsWith('cdk'))
  );
  console.log(`Extracting ${sectionIds.length} sections...`);

  // Step 5: Extract section text with inline [DIAGRAM:N] markers
  const sections = await page.evaluate((ids) => {
    function cleanText(text) {
      return text
        .split('\n')
        .map(l => l.trimEnd())
        .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''))
        .join('\n')
        .trim();
    }

    return ids.map(id => {
      const el = document.getElementById(id);
      if (!el) return null;

      const headingEl = el.querySelector('h1,h2,h3,h4');
      const heading = headingEl
        ? headingEl.innerText.trim().split('\n')[0]
        : id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

      const clone = el.cloneNode(true);

      // Replace each SVG with a [DIAGRAM:idx] marker
      clone.querySelectorAll('svg').forEach(s => {
        const idx = s.getAttribute('data-pw-idx');
        const marker = document.createElement('p');
        marker.textContent = `[DIAGRAM:${idx}]`;
        s.parentNode.replaceChild(marker, s);
      });

      // Remove child section divs to avoid duplicating their content
      clone.querySelectorAll('div[id]').forEach(child => {
        if (child.id !== id) child.remove();
      });

      return { id, heading, text: cleanText(clone.innerText) };
    }).filter(Boolean);
  }, sectionIds);

  await browser.close();

  // Step 6: Build markdown — resolve [DIAGRAM:N] markers to Mermaid blocks
  let output = `# CodeWiki: ${BASE_URL.split('/github.com/')[1] || BASE_URL}\nSource: ${BASE_URL}\n\n`;

  for (const section of sections) {
    const dashes = (section.id.match(/-/g) || []).length;
    const hLevel = dashes <= 1 ? '##' : '###';

    output += `${hLevel} ${section.heading}\n\n`;

    const text = section.text.replace(/\[DIAGRAM:(\d+)\]/g, (_, idxStr) => {
      const idx = parseInt(idxStr);
      const mermaid = diagramMermaid[idx];
      const svgFile = diagramFiles[idx];
      if (mermaid) {
        return `\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n\n`;
      } else if (svgFile) {
        return `\n\n![Diagram](${svgFile})\n\n`;
      }
      return '';
    });

    output += `${text}\n\n---\n\n`;
  }

  // Strip lingering UI artifacts
  output = output
    .replace(/spark\s*Powered by Gemini\s*/g, '')
    .replace(/zoom_in/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n');

  fs.writeFileSync(outFile, output, 'utf8');
  console.log(`Done! ${outFile} — ${(output.length / 1024).toFixed(1)} KB`);
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
