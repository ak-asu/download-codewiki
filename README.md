# download-codewiki

**Download and convert Google CodeWiki documentation to Markdown with Mermaid diagrams.**

A Node.js tool that scrapes architecture documentation from [Google's CodeWiki](https://codewiki.google/) for any GitHub repository, automatically converting embedded SVG diagrams to Mermaid format and generating a clean Markdown document.

## Features

- 🔍 **Automated scraping** of CodeWiki pages using Playwright
- 📊 **SVG to Mermaid conversion** for diagram embedding in Markdown
- 📝 **Clean Markdown output** with organized sections
- 🎨 **Diagram fallback** to SVG images if Mermaid conversion fails
- 🏗️ **Directory organization** with separate diagram files

## Prerequisites

- Node.js 16+
- npm or yarn

## Installation

```bash
git clone https://github.com/ak-asu/download-codewiki.git
cd download-codewiki
npm install
```

## Usage

```bash
node scrape-codewiki.js <codewiki-url>
```

### Example

```bash
node scrape-codewiki.js https://codewiki.google/github.com/microsoft/playwright
```

This command:
1. Fetches the CodeWiki page for the Microsoft Playwright repository
2. Extracts all documentation sections and diagrams
3. Converts SVG diagrams to Mermaid flowchart syntax
4. Generates `microsoft-playwright.md` with inline diagrams
5. Saves SVG source files to `diagrams/` directory

## Output

The tool generates:

- **`{owner}-{repo}.md`** — Main markdown file containing:
  - Repository title and source link
  - All documentation sections with hierarchy
  - Embedded Mermaid diagram blocks (inline)
  - SVG image fallbacks for failed conversions
  
- **`diagrams/`** — Directory containing:
  - Individual SVG files: `diagram-001.svg`, `diagram-002.svg`, etc.
  - Color-corrected for light backgrounds

## How It Works

1. **Page Loading** — Uses Playwright to headlessly load the CodeWiki page
2. **SVG Extraction** — Tags and extracts all embedded SVG diagrams
3. **Color Correction** — Fixes dark-mode white colors for light backgrounds
4. **SVG-to-Mermaid** — Parses Graphviz SVGs and converts to Mermaid syntax
5. **Section Extraction** — Captures documentation sections with proper heading hierarchy
6. **Markdown Generation** — Combines text and diagrams into a single Markdown file

## Dependencies

- **playwright** `^1.59.1` — Headless browser automation for scraping

## File Structure

```
.
├── package.json              # Project dependencies
├── scrape-codewiki.js        # Main scraper script
├── svg-to-mermaid.js         # SVG to Mermaid converter
├── README.md                 # This file
└── diagrams/                 # Generated diagram files (created on first run)
```

## Development

The project uses CommonJS modules. To modify or extend:

- `scrape-codewiki.js` — Main orchestration logic
- `svg-to-mermaid.js` — Diagram parsing and conversion algorithm

## License

ISC
