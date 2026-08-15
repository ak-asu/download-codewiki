# download-codewiki

**Download [Google CodeWiki](https://codewiki.google/) documentation as clean Markdown, with Graphviz diagrams converted to Mermaid.**

Point it at any GitHub repository that CodeWiki has indexed and get a single
Markdown file — real tables, working links, correct heading structure, and
inline diagrams — or a cross-linked directory of per-section files.

```bash
npx download-codewiki anomalyco/opencode
```

```
Fetching CodeWiki for anomalyco/opencode ...
Found 55 sections at commit 284214c
Diagrams: 46/46 as mermaid
Done. anomalyco-opencode.md — 297.2 KB
```

## Why it is accurate

CodeWiki's web app fetches an entire wiki as structured data and renders it in
the browser. This tool reads that same data directly, so it starts from the
wiki's **original Markdown source** — including the **Graphviz DOT source** behind
every diagram — instead of trying to reconstruct it from rendered HTML.

That distinction is the whole ballgame. Measured against the source on
`anomalyco/opencode`:

| | Scraping the rendered page | Reading the source |
|---|---|---|
| Prose recovered | 71.7% | **100%** |
| Tables | 0 | **46** |
| Inline links | 0 | **948** |
| Diagram edges | 253 | **301** |
| Heading levels | collapsed to one | **preserved** |
| Runtime | 8.9s | **0.8s** |
| Install size | 111 MB (Chromium) | **~20 KB** |

No headless browser, no scraping, and one small dependency.

## Install

Requires **Node.js 20+**.

```bash
npx download-codewiki <repo>            # no install
npm install -g download-codewiki        # or install globally
```

From a clone:

```bash
git clone https://github.com/ak-asu/download-codewiki.git
cd download-codewiki
npm install
node bin/download-codewiki.js <repo>
```

## Usage

```bash
download-codewiki <repo> [options]
```

`<repo>` may be any of:

```
https://codewiki.google/github.com/<owner>/<repo>
https://github.com/<owner>/<repo>
<owner>/<repo>
```

### Options

| Option | Description |
|---|---|
| `--diagrams <mode>` | `mermaid` (default), `svg`, `dot`, or `both` |
| `--split` | One file per section instead of a single document |
| `--out <dir>` | Output directory (default: current directory) |
| `--no-toc` | Omit the generated table of contents |
| `--save-raw <file>` | Save the raw API response for offline reuse |
| `--from-raw <file>` | Build from a saved response instead of fetching |
| `-h, --help` | Show help |
| `-v, --version` | Show version |

### Examples

```bash
# Single Markdown file with inline Mermaid diagrams
download-codewiki anomalyco/opencode

# One file per section, cross-linked, for a large wiki
download-codewiki godotengine/godot --split

# Keep Google's own rendered SVGs instead of converting
download-codewiki microsoft/playwright --diagrams svg --out ./wiki

# Fetch once, then re-render offline as often as you like
download-codewiki anomalyco/opencode --save-raw opencode-raw.txt
download-codewiki anomalyco/opencode --from-raw opencode-raw.txt --diagrams both
```

## Diagram modes

CodeWiki draws its diagrams with Graphviz and ships both the DOT source and a
rendered SVG. You choose what lands in the Markdown.

| Mode | Output | Use when |
|---|---|---|
| `mermaid` *(default)* | ` ```mermaid ` blocks | You want diagrams that render inline on GitHub |
| `svg` | `diagrams/diagram-NNN.svg` + image links | You want Google's exact rendering |
| `dot` | ` ```dot ` blocks, untouched | You want the lossless source |
| `both` | Mermaid plus the source in a `<details>` | You want both |

Conversion works from the DOT source, so nothing is inferred from pixel
geometry: clusters become Mermaid subgraphs, edge labels and directions carry
over, and record labels become line breaks. A diagram that cannot be converted
keeps its DOT source rather than disappearing.

SVG output is recoloured for light backgrounds, since CodeWiki renders for dark.

## Output

**Default** — `<owner>-<repo>.md`, containing:

- a provenance header naming the source URL and the exact commit
- a linked table of contents mirroring CodeWiki's sidebar
- every section at its correct heading level
- GFM tables, fenced code, and inline diagrams
- links rewritten to permalinks pinned to that commit
  (`?plain=1` is added for line-anchored Markdown files, as CodeWiki does)

**With `--split`** — a `<owner>-<repo>/` directory:

```
<owner>-<repo>/
├── 0-Index.md                  landing page and full contents
├── 1-<Section>.md              a top-level section + links to its subsections
├── 1.1-<Subsection>.md         a subsection
└── diagrams/                   only with --diagrams svg
```

Links that pointed within the document are repointed at the file that now owns
the target heading, so cross-references keep working.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Unexpected internal error |
| 2 | Bad usage — unparseable repository or unknown flag |
| 3 | Network failure after retries |
| 4 | No CodeWiki exists for that repository |
| 5 | The CodeWiki API changed shape — this tool needs updating |

Exit code 4 is common and not a bug: CodeWiki only covers GitHub repositories
Google has indexed. Check the repository at <https://codewiki.google/> first.

## How it works

1. **Fetch** — one unauthenticated POST returns the whole wiki: Markdown source,
   per-section metadata, diagram DOT source and SVGs, and the commit SHA.
2. **Rewrite links** — repo-relative paths become permalinks to that commit.
3. **Normalise anchors** — CodeWiki's `{#id}` syntax renders as literal text on
   GitHub, so it is stripped and in-document links are repointed at GitHub's own
   heading slugs, duplicates included.
4. **Convert diagrams** — DOT source is parsed and re-emitted as Mermaid.
5. **Build the contents** — a nested, linked table of contents.
6. **Write** — one file, or a cross-linked directory.

Every text transform is fence-guarded: nothing inside a code block is touched,
and bytes that are not deliberately changed are preserved exactly.

## Development

```bash
npm test        # 127 tests, no network required
```

Tests run against recorded API responses for `opencode`, `godot` and
`playwright`, and assert every generated diagram against the real Mermaid
parser. The design and the measurements behind it are in
[`docs/superpowers/specs/`](docs/superpowers/specs/).

```
bin/download-codewiki.js   CLI entry point
src/codewiki-client.js     API call, response decoding, error mapping
src/markdown.js            fence-guarded transforms: links, anchors, contents
src/dot-to-mermaid.js      Graphviz DOT parser and Mermaid emitter
src/diagrams.js            diagram mode dispatch
src/split.js               per-section splitting
src/svg-to-mermaid.js      fallback converter for SVG-only diagrams
```

`scrape-codewiki.js` still works as before and forwards to the CLI.

## Notes

This reads a private endpoint of a Google product. It sends no credentials and
reads only what the public web page already loads, but the endpoint carries no
compatibility promise: if it changes, the tool exits with code 5 rather than
writing a damaged document.

## License

ISC
