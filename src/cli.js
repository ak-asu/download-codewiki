/**
 * Command-line interface.
 */

import fs from 'node:fs';
import path from 'node:path';
import { CodeWikiError, fetchRaw, normalizePayload, parseBatchExecute, parseRepoUrl } from './codewiki-client.js';
import { DIAGRAM_MODES } from './diagrams.js';
import { buildDocument, buildSplit } from './index.js';

const HELP = `download-codewiki — save a Google CodeWiki as clean Markdown

Usage:
  download-codewiki <repo> [options]

<repo> may be any of:
  https://codewiki.google/github.com/<owner>/<repo>
  https://github.com/<owner>/<repo>
  <owner>/<repo>

Options:
  --diagrams <mode>   mermaid (default) | svg | dot | both
                        mermaid  convert Graphviz source to Mermaid blocks
                        svg      write CodeWiki's rendered SVGs and link them
                        dot      leave \`\`\`dot blocks untouched
                        both     Mermaid plus the source in a <details> block
  --split             write one file per section instead of a single document
  --out <dir>         output directory (default: current directory)
  --no-toc            omit the generated table of contents
  --save-raw <file>   save the raw RPC response for offline reuse
  --from-raw <file>   build from a saved response instead of fetching
  -h, --help          show this help
  -v, --version       show version

Examples:
  download-codewiki anomalyco/opencode
  download-codewiki https://codewiki.google/github.com/godotengine/godot --split
  download-codewiki microsoft/playwright --diagrams svg --out ./wiki
`;

export function parseArgs(argv) {
  const options = {
    repo: null, diagrams: 'mermaid', split: false, out: '.',
    toc: true, saveRaw: null, fromRaw: null, help: false, version: false,
  };

  const needsValue = (flag, value) => {
    if (value === undefined) throw new CodeWikiError(`${flag} needs a value`, 2);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h': case '--help': options.help = true; break;
      case '-v': case '--version': options.version = true; break;
      case '--split': options.split = true; break;
      case '--no-toc': options.toc = false; break;
      case '--diagrams': options.diagrams = needsValue(arg, argv[++i]); break;
      case '--out': options.out = needsValue(arg, argv[++i]); break;
      case '--save-raw': options.saveRaw = needsValue(arg, argv[++i]); break;
      case '--from-raw': options.fromRaw = needsValue(arg, argv[++i]); break;
      default:
        if (arg.startsWith('-')) throw new CodeWikiError(`Unknown option "${arg}"`, 2);
        if (options.repo) throw new CodeWikiError(`Unexpected extra argument "${arg}"`, 2);
        options.repo = arg;
    }
  }

  if (!DIAGRAM_MODES.includes(options.diagrams)) {
    throw new CodeWikiError(
      `Unknown --diagrams mode "${options.diagrams}". Expected: ${DIAGRAM_MODES.join(', ')}`, 2,
    );
  }
  return options;
}

function writeFileEnsuring(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

export async function run(argv, { log = console.log, error = console.error } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    error(err.message);
    error('\nRun with --help for usage.');
    return err.exitCode ?? 2;
  }

  if (options.help) { log(HELP); return 0; }
  if (options.version) {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    log(pkg.version);
    return 0;
  }
  if (!options.repo) { error(HELP); return 2; }

  try {
    const { owner, repo } = parseRepoUrl(options.repo);

    let raw;
    if (options.fromRaw) {
      raw = fs.readFileSync(options.fromRaw, 'utf8');
      log(`Reading ${options.fromRaw} ...`);
    } else {
      log(`Fetching CodeWiki for ${owner}/${repo} ...`);
      raw = await fetchRaw(owner, repo);
    }
    if (options.saveRaw) {
      writeFileEnsuring(options.saveRaw, raw);
      log(`Saved raw response to ${options.saveRaw}`);
    }

    const wiki = normalizePayload(parseBatchExecute(raw), { owner, repo });
    log(`Found ${wiki.sections.length} sections at commit ${wiki.sha.slice(0, 7)}`);

    const outDir = options.out;
    const document = buildDocument(wiki, {
      owner, repo,
      diagrams: options.diagrams,
      // The split index page is itself the table of contents; an inline one
      // would be split off into a section file of its own.
      toc: options.toc && !options.split,
      diagramDir: 'diagrams',
    });

    const d = document.diagrams;
    if (d.total) {
      const detail = d.failed ? `, ${d.failed} left as Graphviz source` : '';
      log(`Diagrams: ${d.converted}/${d.total} as ${options.diagrams}${detail}`);
    }

    if (options.split) {
      const target = path.join(outDir, `${owner}-${repo}`);
      const { files, index } = buildSplit(document, wiki, { owner, repo });
      for (const f of files) writeFileEnsuring(path.join(target, f.path), f.content);
      for (const f of document.files) writeFileEnsuring(path.join(target, f.path), f.content);
      log(`Done. ${files.length} Markdown files in ${target}${document.files.length ? ` (+${document.files.length} SVGs)` : ''}`);
      log(`Start at ${path.join(target, index)}`);
    } else {
      const target = path.join(outDir, `${owner}-${repo}.md`);
      writeFileEnsuring(target, document.markdown);
      for (const f of document.files) writeFileEnsuring(path.join(outDir, f.path), f.content);
      const kb = (document.markdown.length / 1024).toFixed(1);
      log(`Done. ${target} — ${kb} KB${document.files.length ? `, ${document.files.length} SVGs in ${path.join(outDir, 'diagrams')}` : ''}`);
    }
    return 0;
  } catch (err) {
    if (err instanceof CodeWikiError) { error(err.message); return err.exitCode; }
    if (err?.code === 'ENOENT') { error(`File not found: ${err.path}`); return 2; }
    error(`Unexpected error: ${err?.stack ?? err}`);
    return 1;
  }
}
