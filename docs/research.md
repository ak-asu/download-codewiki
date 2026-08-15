# download-codewiki: RPC-based extraction pipeline

**Date:** 2026-08-15
**Status:** Implemented. 127 tests passing, verified live against `opencode`,
`godot` and `playwright`. Nothing committed — all changes are in the working tree.
**Resolves:** [#1 tables not correct](https://github.com/ak-asu/download-codewiki/issues/1), [#2 markdown file is not segmented correctly](https://github.com/ak-asu/download-codewiki/issues/2)

## Problem

`scrape-codewiki.js` loads a CodeWiki page in Playwright and reconstructs Markdown
from the rendered DOM using `element.innerText`. Every reported defect follows from
that single choice.

`innerText` returns a visual text rendering. It flattens `<table>` to
space-separated text (issue #1), discards every `href` (948 links lost on
`anomalyco/opencode`), drops list markers, and emits UI chrome — `zoom_in`,
`Powered by Gemini`, `On this page`, `Gemini can make mistakes` — into the output.

Section splitting compounds it. The scraper enumerates `div[id]` containers and
derives heading depth by counting hyphens in the DOM id. Because a parent section's
`div` contains its children's text, and child removal runs after the text is taken,
98% of the document lands under the first heading. Measured on the file attached to
issue #2 (`godotengine-godot.md`): 293,282 of 299,401 characters under one heading,
65 of 73 headings with an effectively empty body, 73 headings captured against 82
real sections, and zero tables, links, and list items.

Diagram conversion has an independent defect. `svg-to-mermaid.js` recovers graph
structure by regex-matching Graphviz's *rendered SVG output* — reading geometry to
infer topology. Over the 92 real diagrams in the evaluation corpus it recovers
522 of 567 edges, losing 45 across 13 diagrams, two of which lose every edge. The
loss is silent: the output is valid Mermaid, just incomplete.

## Root cause

The rendered DOM is a lossy projection of the wiki. CodeWiki's Angular client
obtains the wiki as structured data and renders it; the scraper then tries to
invert that rendering. The upstream data is available directly.

## Key discovery

The client fetches the entire wiki in a single unauthenticated RPC:

```
POST https://codewiki.google/_/BoqAngularSdlcAgentsUi/data/batchexecute?rpcids=VSX6ub&rt=c
Content-Type: application/x-www-form-urlencoded;charset=UTF-8
X-Same-Domain: 1

f.req=[[["VSX6ub","[\"https://github.com/<owner>/<repo>\"]",null,"generic"]]]&
```

Verified to require no browser, no cookies, and no session token. `rpcids` and
`rt=c` are the only required query parameters.

The response is Google's chunked `batchexecute` envelope: a `)]}'` prologue, then
alternating length lines and JSON frames. The `wrb.fr` frame for `VSX6ub` carries a
JSON-encoded string which decodes to:

| Path | Contents |
|---|---|
| `payload[0][0]` | `[repoFullName, commitSha]` |
| `payload[0][1]` | Section records (see below) |
| `payload[1]` | `[[null, requestedUrl], available, statusCode]` |
| `payload[2]` | **The complete wiki as a single Markdown document** |

`payload[2]` is authoritative: correct `##`/`###` hierarchy, `{#anchor}` heading
ids, real GFM tables, fenced code, and every diagram inline as a ` ```dot ` block
holding its original Graphviz source. It is the document the client renders.

**One request returns the whole wiki.** There is no pagination, no per-section
fetch, and no crawl. `godotengine/godot` — 82 sections, 502 KB of Markdown —
arrives in a single 2.1 MB response. Nothing in the CodeWiki UI requires a second
request, so "multi-page" support is a question about how many *output* files to
write, never about how many pages to fetch.

Each section record is a 10-element array; the fields this project uses are:

| Index | Contents |
|---|---|
| 0 | Section title |
| 1 | Heading level (1–4) |
| 7 | Illustration slot (see below) |
| 9 | Anchor id, `#`-prefixed |

Index 2 (summary) is generation metadata: the model's rationale for the section.
It is rendered nowhere and does not appear in `payload[2]`; this project ignores it.

Index 3 lists the section's source files. It *is* present in `payload[2]`, flattened
into a `References: /owner/repo/a, /owner/repo/b` line per section — 54 such lines on
`opencode`, 81 on `godot`, 31 on `playwright`. Interestingly the CodeWiki UI does
**not** render them; they exist only in the exported Markdown. They arrive as bare
text rather than links, so this project linkifies them (see Stage 2) for consistency
with every other path reference in the document.

Field 7 is not a diagram list but an *illustration* oneof, with three observed
variants. On `anomalyco/opencode`'s 55 sections there are 54 such records:

| Variant | Shape | Count |
|---|---|---|
| GFM table | `[meta, [markdownTable]]` | 5 |
| Graphviz diagram | `[meta, null, [dotSource, renderedSvg]]` | 46 |
| Code sample | `[meta, null, null, [fencedCodeBlock]]` | 3 |

One section has no illustration at all (`null`). Treating this field as
"diagrams" is the mistake to avoid: two of the three variants are not diagrams,
and the 46 Graphviz records match exactly the 46 ` ```dot ` fences in `payload[2]`
and the 46 `svg.svg-diagram` elements in the rendered page.

All three variants are already inlined in `payload[2]`. Only the Graphviz variant
carries information `payload[2]` lacks — the pre-rendered SVG — which the
`--diagrams svg` mode uses.

### Availability signalling

When no wiki exists, `payload[0]` is `null` and `payload[1]` reports the request:

| Case | `payload[1]` | Meaning |
|---|---|---|
| `anomalyco/opencode` | `[[null, url], true, 3]` | Ready |
| `gitlab.com/gitlab-org/gitlab` | `[[null, url], null, 4]` | Unsupported host |
| `torvalds/linux`, nonexistent repos | `[[null, url]]` | Not indexed; no status code |

The client treats a null `payload[0]` as "unavailable" and reports the status code
when one is present. It must not assume a status code exists.

## Evaluation

Three pipelines were built and measured against `payload[2]` as ground truth:
**A** = the current `innerText` scraper, **B** = a DOM walker that serialises the
article element tag by tag (converting tables, lists and code blocks properly) and
splits its output into per-section files, **C** = the RPC pipeline prototype.
Target: `anomalyco/opencode`, 55 sections.

B is the strongest form of the DOM approach, included to test whether the reported
defects can be fixed without changing where the data comes from.

| Metric | Truth | A | B | C |
|---|---|---|---|---|
| Prose recall | 100% | 71.7% | 74.8% | **100%** |
| Heading levels | 1/12/38/7 | 1/1/54 | 50/12/–/7 | **1/12/38/7** |
| Largest section share | 4.1% | 97.0% | 3.7% | 4.9% |
| Table rows | 46 | 0 | 46 | **46** |
| Inline links | 948 | 0 | 0 † | **948** |
| Diagram edges | 301 | 253 | 253 | **301** |
| UI junk strings | 0 | 4 | 0 | **0** |
| Runtime | — | 8.9s | 5.6s | **0.8s** |
| Install footprint | — | 111 MB | 111 MB | ~20 KB |

† B's inline serialiser emits an `<a>` element's text and drops its `href`, so no
source link survives. Its 136 links are the cross-file indexes it generates itself.

Prose recall = share of 322 sampled ground-truth sentences (80–220 chars) found
verbatim after normalising away link syntax, emphasis, and whitespace.

**Conclusion: C.** It is the only pipeline that reproduces the source exactly, and
it is both faster and lighter because it stops reconstructing what it can fetch.

### Diagram conversion

Over all 92 real Graphviz graphs in the corpus (`opencode`, `godot`, `playwright`):

| Converter | Nodes | Edges | Labelled edges | `mermaid.parse()` |
|---|---|---|---|---|
| From DOT source (new) | 524/524 | **567/567** | 476/476 | 92/92 |
| From rendered SVG (current) | 524/524 | 522/567 | 446/476 | 92/92 |

Both produce valid Mermaid; only the DOT path produces *complete* Mermaid. The DOT
path also renders multi-line labels as `<br/>` rather than the SVG path's `|`
separator, and preserves Graphviz clusters as Mermaid subgraphs.

### Library evaluation

| Library | Verdict |
|---|---|
| `github-slugger` | **Adopt** as the sole runtime dependency. Exact GitHub slug semantics including `-1` duplicate suffixes, unicode, and emoji. Zero transitive deps. |
| `mermaid` + `jsdom` | **Adopt as devDependencies.** Lets the test suite assert every generated diagram parses. Caught 3 escaper bugs already. |
| `dotparser` | Reject. 22/25 on the adversarial suite vs 25/25 hand-rolled; rejects spec-legal `"a" + "b"` concatenation and cannot degrade on truncated input. |
| `@ts-graphviz/ast` | Reject. Fails 2/92 on real Google output. |
| `remark` + `remark-gfm` round-trip | Reject. Re-serialising inflated godot's document by 32 KB and altered 2,213 of 2,881 lines (list markers, wrapping, escaping). The corpus contains **zero** encoded links and **zero** `{#anchor}` occurrences inside code fences, so fence-guarded string edits carry no measurable risk and preserve every unmodified byte. |
| `svgo` | Reject. Google's SVGs are already compact; optimisation risks altering them. |

## Decisions and alternatives weighed

Each of these was an open choice; the rejected options are recorded so they are not
silently relitigated during implementation.

**Extraction approach.** Considered: (a) keep DOM scraping and patch the table and
splitting bugs; (b) RPC primary with a Playwright fallback; (c) RPC only.
**Chose (c).** The measurements above show the DOM path is not merely
buggy but structurally lossy — it cannot recover `href`s or table structure that
`innerText` discards. A fallback to a pipeline that scores 71.7% prose recall and
0/948 links would mean silently substituting a known-broken document for a clear
error. Dropping Playwright also removes a 111 MB Chromium download.

**Diagram default.** Considered: Mermaid, Google's rendered SVG files, or
untouched ` ```dot ` fences. **Chose Mermaid**, because it is the only option that
renders inline on GitHub and in most Markdown viewers while remaining
self-contained, and because converting from DOT source is lossless where converting
from SVG is not. SVG is pixel-perfect but external; DOT is lossless but renders as
a plain code block. Both remain available as flags rather than being discarded.

**Heading anchors.** Considered: (a) keep `{#id}` verbatim; (b) strip and rewrite
in-document links to GitHub slugs; (c) strip and emit `<a id="…"></a>` before each
heading. **Chose (b).** `{#id}` is Pandoc/Obsidian/MkDocs syntax that GitHub does
not support — GitHub renders it as literal `{#some-id}` text in the heading. Option
(c) preserves CodeWiki's exact anchor names but injects HTML into otherwise clean
Markdown. Option (b) yields output that renders correctly everywhere, at the cost
of anchor names differing from CodeWiki's; since every in-document link is rewritten
through the same map, no link breaks. CodeWiki's own anchors are already
GitHub-compatible for top-level sections (`godotenginegodot-overview` is exactly
what `github-slugger` produces) but prefix the parent path for nested ones, which is
why a remap rather than a passthrough is required.

**Output shape.** Considered: single file, split directory, or both always.
**Chose single file by default with `--split` opt-in.** The single file with correct
hierarchy plus a generated TOC is what issue #2 actually asks for, and it preserves
the existing output contract. Splitting is genuinely useful for large wikis, so it
stays as a flag rather than becoming the default.

**Markdown editing strategy.** Considered an AST round-trip via `remark`. Rejected
on measurement (see the library table): parsing is accurate but re-serialising
rewrites the document. Surgical fence-guarded edits keep every byte we do not
intend to change.

**Directory links.** Verified by HTTP `HEAD` against GitHub that `/tree/<sha>/<file>`
301-redirects to `/blob/…` and `/blob/<sha>/<dir>` 301-redirects to `/tree/…`, so
either form resolves for either target. The design emits `/blob/` for both, matching
what CodeWiki's own UI emits, so output links are byte-identical to the source.

## Design

### Module structure

ESM, Node 20+ — the floor is set by stable global `fetch` and a stable `node:test`
runner, both of which this design relies on. `package.json` is renamed from its
current `learn-playwright` to `download-codewiki`, gains `"type": "module"` and a
`bin` entry, drops `playwright`, and gains a `test` script. One runtime dependency.

```
bin/download-codewiki.js     CLI entry point
src/cli.js                   argument parsing, help, exit codes
src/codewiki-client.js       URL parsing, RPC call, envelope decode, retry
src/markdown.js              fence-aware transforms: links, anchors, TOC
src/dot-to-mermaid.js        DOT tokenizer, parser, Mermaid emitter
src/diagrams.js              diagram mode dispatch, SVG file writing
src/split.js                 per-section file splitting and index generation
test/                        node --test suites, offline fixtures
scrape-codewiki.js           compatibility shim -> bin/
```

Each module is independently testable and has one responsibility. The
DOT converter takes a string and returns a string, with no knowledge of CodeWiki.

### Stage 1 — Fetch (`codewiki-client.js`)

`parseRepoUrl(input)` accepts, case-insensitively and tolerant of trailing
slashes, `.git` suffixes, query strings, and fragments:

- `https://codewiki.google/github.com/<owner>/<repo>[/anything]`
- `https://github.com/<owner>/<repo>`
- `<owner>/<repo>`

`parseBatchExecute(text, rpcId)` strips the `)]}'` prologue, scans every line that
parses as a JSON array, and collects `wrb.fr` frames matching the rpc id. It does
not assume frame ordering, a single frame, or the presence of length lines.

`fetchWiki(owner, repo)` performs the POST and returns
`{ repo, sha, markdown, sections }`. Failure modes, each with a distinct message
and exit code:

| Exit | Condition |
|---|---|
| 0 | Success |
| 1 | Unexpected internal error |
| 2 | Bad usage — unparseable URL or unknown flag |
| 3 | Network error or non-2xx after retries |
| 4 | No wiki for this repository. Reports the status code when present, and names the unsupported-host case explicitly when the input was a non-GitHub host |
| 5 | No `wrb.fr` frame for `VSX6ub`, or a payload whose shape fails validation — the RPC contract changed. Fails loudly rather than emitting a degraded document |

Retries use exponential backoff on 429 and 5xx only, with a request timeout.

`--save-raw <file>` and `--from-raw <file>` persist and replay the raw response,
so failures are reproducible offline and tests need no network.

### Stage 2 — Transform (`markdown.js`)

All transforms are surgical string edits guarded by a fence scanner. Nothing is
re-serialised; bytes outside an intended edit are preserved exactly.

`splitFences(md)` splits the document into alternating fenced and unfenced regions,
tracking the opening fence character and length so that a ` ``` ` inside a `~~~`
block, or a longer fence inside a shorter one, does not desynchronise the scan.
`outsideFences(md, fn)` applies a transform only to unfenced regions.

**Links.** Rewrite `](%2F<owner>%2F<repo>%2F<path>[#Lnn])` to absolute GitHub URLs,
matching what the CodeWiki UI itself emits:

| Input | Output |
|---|---|
| repo root | `https://github.com/<o>/<r>/tree/<sha>` |
| `.md`/`.markdown` with `#Lnn` | `…/blob/<sha>/<path>?plain=1#Lnn` |
| anything else | `…/blob/<sha>/<path>[#Lnn]` |

Directories deliberately use `/blob/`, as CodeWiki does; GitHub 301-redirects to
`/tree/`. Links whose owner/repo do not match the target are left untouched.

*Validation oracle:* applying this rule to `payload[2]` for `anomalyco/opencode`
yields 587 URLs, of which **587 match the `href`s in the rendered page exactly**,
with zero false positives. This equivalence is a test.

**References lines.** Each section's `References:` line carries bare repo-relative
paths. They go through the same URL rule, wrapped in code spans, taking
`opencode` from 587 to 617 distinct links. A line whose entries are not all paths,
or whose paths belong to another repository, is left alone.

**Anchors.** Strip `{#id}` from ATX headings, recording `id -> githubSlug(title)`
using one `GithubSlugger` instance across the document so duplicate headings get
GitHub's `-1`, `-2` suffixes. Then rewrite `](#id)` link targets through that map,
leaving unknown ids untouched.

**Table of contents.** Build a nested list from the heading levels, mirroring
CodeWiki's sidebar tree, each entry linking to its slug. Inserted after the
document title. This is the direct fix for the structural complaint in issue #2.
`--no-toc` suppresses it.

### Stage 3 — Diagrams (`dot-to-mermaid.js`, `diagrams.js`)

A DOT tokenizer and recursive-descent parser over the
[DOT grammar](https://graphviz.org/doc/info/lang.html), then a Mermaid emitter.

The tokenizer handles quoted strings with `\"` escapes, backslash-newline line
continuations and `"a" + "b"` concatenation; HTML-like `<...>` strings with
balanced-angle-bracket scanning; `//`, `/* */`, and `#` comments; numerals; and
unicode bare identifiers. Unrecognised characters are skipped rather than thrown,
so malformed input degrades instead of failing.

The parser resolves node and edge attribute defaults, expands edge chains
(`a->b->c`) and group endpoints (`{a b} -> {c d}`), tracks `cluster*` subgraph
membership, and handles ports and nested subgraphs.

The emitter maps `rankdir` to flowchart direction, Graphviz shapes to Mermaid node
shapes, clusters to `subgraph` blocks, and `style=dashed`/`dir=both`/`--` to the
corresponding Mermaid connectors. Node ids are generated through a collision-safe
factory: two distinct DOT names can never collapse onto one Mermaid id, and ids
colliding with Mermaid reserved words (`end`, `graph`, `class`, …) are suffixed.

Label escaping is the sharp edge, and the three bugs found during evaluation are
requirements, not discoveries to re-make:

1. Backticks break Mermaid's lexer and must be escaped as `#96;`
2. `\l`, `\n`, `\r` must all become `<br/>`; the current handling mangles `\l`
3. Names that sanitise to nothing (CJK-only ids) must fall back to stable
   sequential ids, not collapse toward a shared prefix

Also escaped: `#` as `#35;` and `"` as `#quot;`. Graphviz record labels
(`{<port> A|B}`) become `<br/>`-joined lines with ports stripped; HTML-like labels
are reduced to text preserving `<br/>`.

Modes, selected by `--diagrams`:

| Mode | Behaviour |
|---|---|
| `mermaid` *(default)* | Replace each ` ```dot ` block with ` ```mermaid `; on conversion failure, leave the DOT block untouched rather than emit nothing |
| `svg` | Write Google's rendered SVG to `diagrams/diagram-NNN.svg` and reference it, applying the existing dark-mode colour correction |
| `dot` | Leave source untouched |
| `both` | Mermaid block plus the DOT source in a collapsed `<details>` |

`svg` mode matches SVGs to their ` ```dot ` blocks by exact DOT-source equality
against the section records, falling back to document order.

### Stage 4 — Output (`split.js`)

Default: one `<owner>-<repo>.md`, opening with a provenance comment naming the
source URL and commit SHA.

`--split`: a `<owner>-<repo>/` directory with `0-Index.md` and per-section files
named `<n>-<slug>.md` / `<n>.<m>-<slug>.md`, cross-linked with English navigation.
Slugs keep unicode letters and digits. When splitting, in-document anchor links
are rewritten to `<file>.md#<slug>` so cross-section links keep working. Filename
collisions after slugification are disambiguated by numeric suffix.

Other flags: `--out <dir>`, `--no-toc`, `--save-raw`, `--from-raw`.

### Stage 5 — Testing

`node --test`, no framework dependency. Network is never required: fixtures are
saved raw RPC responses for `opencode`, `godot`, and `playwright`, plus the
un-indexed and unsupported-host responses.

| Suite | Asserts |
|---|---|
| `codewiki-client` | URL parsing across all accepted forms; envelope decoding including multi-frame, reordered, and absent-length-line inputs; each availability failure mode |
| `dot-to-mermaid` | The 25-case adversarial suite; all 92 corpus graphs parse; node/edge/label counts equal DOT ground truth; the three escaper bugs; id collision safety |
| `mermaid-validity` | Every diagram generated from the corpus passes `mermaid.parse()` under jsdom |
| `markdown` | Link rewriting equals the 587-URL page oracle; fence guarding (links and `{#…}` inside fences are untouched); slug duplicates; TOC nesting |
| `split` | File naming, collision handling, cross-file anchor rewriting |

Duplicate heading text occurs in real wikis — `anomalyco/opencode` has
"Canonicalization of node_modules" twice — so the duplicate-slug case is a fixture,
not a hypothetical.

Standing up `mermaid` under Node for validation needs a documented workaround, to
save the implementer rediscovering it: `mermaid.parse()` requires a DOM, and
importing it bare fails with `DOMPurify.sanitize is not a function`. The harness
must create a `jsdom` window, assign `window`/`document`/`Element`/`SVGElement`/
`HTMLElement`/`Node` globals, install `DOMPurify` as a global bound to that window,
and set `navigator` via `Object.defineProperty` — on Node 22 plain assignment throws
`Cannot set property navigator of #<Object> which has only a getter`.

### Compatibility

`scrape-codewiki.js` remains as a shim delegating to the new CLI, so
`node scrape-codewiki.js <url>` keeps working. `svg-to-mermaid.js` is retained and
wired as a genuine fallback: if a diagram record ever arrives with an SVG but no
DOT source, the SVG converter handles it. It is no longer on the primary path.

README is rewritten to describe the RPC approach, the flags, and the removal of the
Playwright dependency.

The repository has no `.gitignore`, so `node_modules/` and generated output are
currently untracked-but-offerable. One is added covering `node_modules/`, generated
`*-*.md` output directories, `diagrams/`, and raw-response dumps.

## Risks

**The RPC is a private endpoint.** Google may change the rpc id, payload shape, or
require a session token. Mitigation: parse defensively and fail loudly with a
message identifying the changed contract — never silently emit a partial document.
The evaluation shows the DOM fallback is not worth retaining: it is slower, heavier,
and materially less accurate, so a "fallback" would mean silently degrading to a
known-broken output.

**Payload shape assumptions.** Field indices are positional. Every access is
guarded, and a shape change surfaces as an explicit error.

**Mermaid rendering differences.** Mermaid lays out differently from Graphviz. The
content is complete, but complex graphs may read differently. `--diagrams svg` and
`--diagrams both` exist for users who need Google's exact rendering.

## Out of scope

Non-GitHub hosts (CodeWiki does not support them — GitLab URLs return status 4),
triggering wiki generation for un-indexed repositories, incremental or cached
re-fetching beyond `--save-raw`, and rendering Mermaid to images.

Two things were investigated and deliberately excluded:

**The "Updated on" date.** The UI shows one (`Aug 7, 2026` for `opencode`), but it
is not in the RPC payload — only in the server-rendered HTML. Fetching and
regex-scraping that page would reintroduce HTML fragility for a cosmetic field. The
commit SHA, which *is* in the payload, already identifies the snapshot precisely and
is recorded in the output header.

**Section summaries and diagram captions** (record field 2, and the meta slot of
field 7). These are generation-time prompts rather than content — the diagram
captions read "A diagram illustrating the overall project structure…". Neither is
rendered in the CodeWiki UI nor present in `payload[2]`. Emitting them would add
text the source document does not contain.

(Field 3, the source-file references, was initially assumed to be in the same
category. It is not: it appears in `payload[2]` as `References:` lines, and is
kept and linkified.)

The `hl` query parameter was verified to be *optional* — requests succeed without
it and return an identical payload. Whether CodeWiki can serve translated content
for other `hl` values was not investigated, and localisation is not a goal here.
