/**
 * Client for CodeWiki's batchexecute RPC.
 *
 * The CodeWiki web app fetches an entire wiki in one unauthenticated POST and
 * renders it client-side. Reading that response directly gives the wiki's
 * original Markdown — tables, links, headings and Graphviz diagram source —
 * instead of trying to invert the rendered DOM.
 */

export const RPC_ID = 'VSX6ub';
export const RPC_URL =
  `https://codewiki.google/_/BoqAngularSdlcAgentsUi/data/batchexecute?rpcids=${RPC_ID}&rt=c`;

/** Errors carrying a CLI exit code. */
export class CodeWikiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CodeWikiError';
    this.exitCode = code;
  }
}

/**
 * Accepts a CodeWiki URL, a GitHub URL, or a bare `owner/repo`.
 * Tolerates scheme, trailing slash, `.git`, query string and fragment.
 */
export function parseRepoUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new CodeWikiError('No repository specified', 2);
  }
  let s = input.trim();
  s = s.split('#')[0].split('?')[0];
  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  s = s.replace(/^www\./i, '');
  s = s.replace(/^codewiki\.google\//i, '');
  s = s.replace(/^github\.com\//i, '');
  s = s.replace(/\.git$/i, '');

  // GitHub logins never contain a dot, so a dotted first segment is a
  // hostname. Catch it here rather than silently treating "gitlab.com" as an
  // owner and "gitlab-org" as a repository.
  const host = s.split('/')[0];
  if (host.includes('.')) {
    throw new CodeWikiError(
      `CodeWiki only covers GitHub repositories, and "${host}" is not github.com.`,
      2,
    );
  }

  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new CodeWikiError(
      `Cannot read owner/repo from "${input}".\n` +
      'Expected one of:\n' +
      '  https://codewiki.google/github.com/<owner>/<repo>\n' +
      '  https://github.com/<owner>/<repo>\n' +
      '  <owner>/<repo>',
      2,
    );
  }
  const [owner, repo] = parts;
  if (/[^\w.-]/.test(owner) || /[^\w.-]/.test(repo)) {
    throw new CodeWikiError(`Invalid owner/repo in "${input}"`, 2);
  }
  return { owner, repo };
}

/**
 * Decode Google's chunked batchexecute envelope.
 *
 * Format is a `)]}'` prologue followed by alternating length lines and JSON
 * frame arrays. Rather than depend on that interleaving, scan every line that
 * parses as a JSON array and collect matching `wrb.fr` frames — the framing has
 * varied between requests (`rt=c` adds length lines, omitting it does not).
 */
export function parseBatchExecute(text, rpcId = RPC_ID) {
  if (typeof text !== 'string') throw new CodeWikiError('Empty RPC response', 5);
  const body = text.replace(/^\)\]\}'\s*/, '');
  const payloads = [];

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[')) continue;
    let frames;
    try { frames = JSON.parse(trimmed); } catch { continue; }
    if (!Array.isArray(frames)) continue;
    for (const frame of frames) {
      if (!Array.isArray(frame)) continue;
      if (frame[0] !== 'wrb.fr' || frame[1] !== rpcId) continue;
      if (typeof frame[2] !== 'string') continue;
      try { payloads.push(JSON.parse(frame[2])); } catch { /* skip unparseable frame */ }
    }
  }

  if (!payloads.length) {
    throw new CodeWikiError(
      `No "${rpcId}" payload in the CodeWiki response.\n` +
      'The RPC contract has probably changed; this tool needs updating.',
      5,
    );
  }
  return payloads[0];
}

/**
 * Turn a decoded payload into { repo, sha, markdown, sections }.
 * Every field access is positional, so each one is guarded: a shape change
 * must surface as a clear error, never as a silently truncated document.
 */
export function normalizePayload(payload, { owner, repo } = {}) {
  if (!Array.isArray(payload)) throw new CodeWikiError('Unrecognised RPC payload', 5);

  if (!payload[0]) {
    const status = payload[1]?.[2];
    const name = owner && repo ? `${owner}/${repo}` : 'that repository';
    let detail;
    if (status === 4) {
      detail = 'CodeWiki only covers GitHub repositories, and not every one of them.';
    } else if (status === undefined) {
      detail = 'It has no CodeWiki yet. Only repositories Google has indexed are available.';
    } else {
      detail = `CodeWiki reported status ${status}.`;
    }
    throw new CodeWikiError(
      `No CodeWiki available for ${name}.\n${detail}\n` +
      'Check the repository at https://codewiki.google/ first.',
      4,
    );
  }

  const meta = payload[0][0];
  const records = payload[0][1];
  const markdown = payload[2];

  if (typeof markdown !== 'string' || !markdown.trim()) {
    throw new CodeWikiError('RPC payload contained no wiki Markdown', 5);
  }
  if (!Array.isArray(meta) || typeof meta[0] !== 'string') {
    throw new CodeWikiError('RPC payload contained no repository metadata', 5);
  }

  const sections = Array.isArray(records)
    ? records.filter(Array.isArray).map((r) => ({
      title: typeof r[0] === 'string' ? r[0] : '',
      level: Number.isInteger(r[1]) ? r[1] : 1,
      anchor: typeof r[9] === 'string' ? r[9].replace(/^#/, '') : '',
      svg: extractSvg(r[7]),
      dot: extractDot(r[7]),
    }))
    : [];

  return { repo: meta[0], sha: typeof meta[1] === 'string' ? meta[1] : '', markdown, sections };
}

/**
 * Field 7 is an illustration oneof: a Markdown table, a [dot, svg] pair, or a
 * fenced code block. Only the middle variant carries a diagram.
 */
function graphvizSlot(field) {
  if (!Array.isArray(field)) return null;
  for (const record of field) {
    if (!Array.isArray(record)) continue;
    const slot = record[2];
    if (Array.isArray(slot) && typeof slot[0] === 'string' && typeof slot[1] === 'string') return slot;
  }
  return null;
}

function extractDot(field) {
  return graphvizSlot(field)?.[0] ?? null;
}

function extractSvg(field) {
  return graphvizSlot(field)?.[1] ?? null;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST the RPC and return the raw response body, retrying transient failures. */
export async function fetchRaw(owner, repo, { retries = 3, timeoutMs = 60_000, fetchImpl = fetch } = {}) {
  const target = `https://github.com/${owner}/${repo}`;
  const freq = JSON.stringify([[[RPC_ID, JSON.stringify([target]), null, 'generic']]]);
  const body = `f.req=${encodeURIComponent(freq)}&`;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(500 * 2 ** (attempt - 1), 4000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(RPC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'x-same-domain': '1',
        },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = new CodeWikiError(`CodeWiki returned HTTP ${res.status}`, 3);
        // Only transient statuses are worth another attempt; a 404 will
        // always be a 404.
        err.retryable = RETRYABLE.has(res.status);
        throw err;
      }
      return await res.text();
    } catch (err) {
      if (err instanceof CodeWikiError && err.retryable === false) throw err;
      lastError = err;
      if (attempt >= retries) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new CodeWikiError(
    `Could not reach CodeWiki after ${retries + 1} attempts: ${lastError?.message ?? 'unknown error'}`,
    3,
  );
}

/** Fetch and decode a wiki. */
export async function fetchWiki(owner, repo, options = {}) {
  const raw = await fetchRaw(owner, repo, options);
  options.onRaw?.(raw);
  return normalizePayload(parseBatchExecute(raw), { owner, repo });
}
