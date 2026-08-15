import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CodeWikiError, RPC_ID, fetchRaw, normalizePayload, parseBatchExecute, parseRepoUrl,
} from '../src/codewiki-client.js';
import { fixture, opencodeWiki } from './helpers.js';

test('parseRepoUrl accepts every documented input form', () => {
  const expected = { owner: 'anomalyco', repo: 'opencode' };
  const inputs = [
    'https://codewiki.google/github.com/anomalyco/opencode',
    'http://codewiki.google/github.com/anomalyco/opencode',
    'codewiki.google/github.com/anomalyco/opencode',
    'https://codewiki.google/github.com/anomalyco/opencode/',
    'https://codewiki.google/github.com/anomalyco/opencode#some-section',
    'https://codewiki.google/github.com/anomalyco/opencode?ref=x',
    'https://github.com/anomalyco/opencode',
    'https://www.github.com/anomalyco/opencode',
    'https://github.com/anomalyco/opencode.git',
    'github.com/anomalyco/opencode',
    'anomalyco/opencode',
  ];
  for (const input of inputs) {
    assert.deepEqual(parseRepoUrl(input), expected, input);
  }
});

test('parseRepoUrl rejects input it cannot resolve', () => {
  for (const bad of ['', '   ', 'opencode', 'https://github.com/anomalyco']) {
    assert.throws(() => parseRepoUrl(bad), (err) => err instanceof CodeWikiError && err.exitCode === 2);
  }
});

test('parseRepoUrl rejects hosts other than GitHub', () => {
  // Otherwise "gitlab.com/gitlab-org/gitlab" silently becomes owner
  // "gitlab.com", repo "gitlab-org".
  for (const url of [
    'https://gitlab.com/gitlab-org/gitlab',
    'https://bitbucket.org/team/repo',
    'gitlab.com/gitlab-org/gitlab',
  ]) {
    assert.throws(
      () => parseRepoUrl(url),
      (err) => err instanceof CodeWikiError && err.exitCode === 2 && /only covers GitHub/.test(err.message),
      url,
    );
  }
});

test('parseRepoUrl allows a dot in the repository name', () => {
  assert.deepEqual(parseRepoUrl('owner/repo.js'), { owner: 'owner', repo: 'repo.js' });
  assert.deepEqual(parseRepoUrl('https://github.com/owner/my.cool.repo'),
    { owner: 'owner', repo: 'my.cool.repo' });
});

test('parseBatchExecute decodes the chunked envelope', () => {
  const payload = parseBatchExecute(opencodeWiki());
  assert.ok(Array.isArray(payload));
  assert.equal(payload[0][0][0], 'anomalyco/opencode');
  assert.match(payload[0][0][1], /^[0-9a-f]{40}$/);
  assert.equal(typeof payload[2], 'string');
});

test('parseBatchExecute does not depend on framing details', async (t) => {
  const inner = JSON.stringify([[['x', 'y']], null, '# doc']);
  const frame = (id) => JSON.stringify([['wrb.fr', id, inner, null, null, null, 'generic']]);

  await t.test('length lines are optional', () => {
    assert.ok(parseBatchExecute(`)]}'\n\n${frame(RPC_ID)}\n`));
  });

  await t.test('length lines are tolerated', () => {
    assert.ok(parseBatchExecute(`)]}'\n\n123\n${frame(RPC_ID)}\n25\n[["e",4]]\n`));
  });

  await t.test('unrelated frames are ignored', () => {
    const noise = JSON.stringify([['di', 43], ['af.httprm', 42, '123', 8]]);
    assert.ok(parseBatchExecute(`)]}'\n${noise}\n${frame(RPC_ID)}\n`));
  });

  await t.test('a frame for a different rpc id does not match', () => {
    assert.throws(() => parseBatchExecute(`)]}'\n${frame('OTHER')}\n`),
      (err) => err.exitCode === 5);
  });

  await t.test('a response with no payload fails loudly', () => {
    assert.throws(() => parseBatchExecute(')]}\'\n\n'), (err) => err.exitCode === 5);
    assert.throws(() => parseBatchExecute('total garbage'), (err) => err.exitCode === 5);
  });
});

test('normalizePayload extracts the wiki', () => {
  const wiki = normalizePayload(parseBatchExecute(opencodeWiki()),
    { owner: 'anomalyco', repo: 'opencode' });

  assert.equal(wiki.repo, 'anomalyco/opencode');
  assert.match(wiki.sha, /^[0-9a-f]{40}$/);
  assert.equal(wiki.sections.length, 55);
  assert.match(wiki.markdown, /^# Wiki for anomalyco\/opencode/);

  const levels = wiki.sections.reduce((acc, s) => {
    acc[s.level] = (acc[s.level] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(levels, { 1: 1, 2: 11, 3: 36, 4: 7 });

  // Only the Graphviz variant of the illustration slot yields a diagram;
  // the table and code-sample variants must not be mistaken for one.
  const withDot = wiki.sections.filter((s) => s.dot);
  assert.equal(withDot.length, 46);
  for (const s of withDot) {
    assert.match(s.dot, /^\s*(strict\s+)?digraph/);
    assert.match(s.svg, /<svg/);
  }
});

test('reports each unavailable case distinctly', async (t) => {
  const cases = {
    'unavailable-not-indexed.txt': /no CodeWiki yet/i,
    'unavailable-missing-repo.txt': /no CodeWiki yet/i,
    'unavailable-gitlab.txt': /only covers GitHub/i,
  };
  for (const [file, pattern] of Object.entries(cases)) {
    await t.test(file, () => {
      const payload = parseBatchExecute(fixture(file));
      assert.throws(
        () => normalizePayload(payload, { owner: 'o', repo: 'r' }),
        (err) => err instanceof CodeWikiError && err.exitCode === 4 && pattern.test(err.message),
      );
    });
  }
});

test('rejects a payload whose shape it does not recognise', () => {
  assert.throws(() => normalizePayload('nope'), (err) => err.exitCode === 5);
  assert.throws(() => normalizePayload([[['r', 'sha'], []], null, '']), (err) => err.exitCode === 5);
  assert.throws(() => normalizePayload([[null, []], null, '# doc']), (err) => err.exitCode === 5);
});

test('retries transient failures and gives up cleanly', async (t) => {
  await t.test('retries a 503 then succeeds', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls < 3) return { ok: false, status: 503 };
      return { ok: true, status: 200, text: async () => 'body' };
    };
    const body = await fetchRaw('o', 'r', { fetchImpl, retries: 3 });
    assert.equal(body, 'body');
    assert.equal(calls, 3);
  });

  await t.test('does not retry a 404', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return { ok: false, status: 404 }; };
    await assert.rejects(() => fetchRaw('o', 'r', { fetchImpl, retries: 3 }),
      (err) => err.exitCode === 3);
    assert.equal(calls, 1);
  });

  await t.test('surfaces a network failure after exhausting retries', async () => {
    const fetchImpl = async () => { throw new Error('ECONNRESET'); };
    await assert.rejects(() => fetchRaw('o', 'r', { fetchImpl, retries: 1 }),
      (err) => err.exitCode === 3 && /ECONNRESET/.test(err.message));
  });
});

test('sends the request shape CodeWiki expects', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, text: async () => 'x' };
  };
  await fetchRaw('anomalyco', 'opencode', { fetchImpl });

  assert.match(seen.url, /rpcids=VSX6ub/);
  assert.match(seen.url, /rt=c/);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['x-same-domain'], '1');

  const body = decodeURIComponent(seen.init.body.replace(/^f\.req=/, '').replace(/&$/, ''));
  assert.deepEqual(JSON.parse(body),
    [[['VSX6ub', '["https://github.com/anomalyco/opencode"]', null, 'generic']]]);
});
