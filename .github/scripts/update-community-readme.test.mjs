import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildReadme,
  escapeHtml,
  fetchContributors,
  fetchSponsors,
  isBot,
  renderGallery,
  replaceMarkedBlock,
  updateReadme,
} from './update-community-readme.mjs';

const readmeSource = `before
<!-- sponsors:start -->
old sponsors
<!-- sponsors:end -->
middle
<!-- contributors:start -->
old contributors
<!-- contributors:end -->
after
`;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emptySponsorResponse() {
  return jsonResponse({
    data: {
      organization: {
        sponsorshipsAsMaintainer: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      },
    },
  });
}

function successfulFetch(url) {
  if (url === 'https://api.github.com/graphql') {
    return emptySponsorResponse();
  }
  return jsonResponse([]);
}

test('escapes HTML-sensitive characters', () => {
  assert.equal(
    escapeHtml(`Breeze & <fast> \"remote\" 'management'`),
    'Breeze &amp; &lt;fast&gt; &quot;remote&quot; &#39;management&#39;',
  );
});

test('identifies GitHub bot account types and login suffixes', () => {
  assert.equal(isBot({ login: 'release-service', type: 'Bot' }), true);
  assert.equal(isBot({ login: 'dependabot[bot]', type: 'User' }), true);
  assert.equal(isBot({ login: 'octocat', type: 'User' }), false);
});

test('renders linked, escaped, fixed-size accessible avatars', () => {
  assert.equal(
    renderGallery([
      {
        login: 'ada',
        name: `Ada <Lovelace> & \"Friends\"`,
        avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
        url: 'https://github.com/ada?tab=overview&from=gallery',
      },
      {
        login: `grace'o`,
        avatarUrl: 'https://avatars.githubusercontent.com/u/2',
        url: 'https://github.com/grace-o',
      },
    ], 'No community members yet.'),
    '<a href="https://github.com/ada?tab=overview&amp;from=gallery"><img src="https://avatars.githubusercontent.com/u/1?v=4&amp;s=128" width="64" height="64" alt="Ada &lt;Lovelace&gt; &amp; &quot;Friends&quot;" title="Ada &lt;Lovelace&gt; &amp; &quot;Friends&quot; (@ada)" /></a>\n'
      + '<a href="https://github.com/grace-o"><img src="https://avatars.githubusercontent.com/u/2?s=128" width="64" height="64" alt="grace&#39;o" title="grace&#39;o (@grace&#39;o)" /></a>',
  );
});

test('renders the supplied empty state when the account list is empty', () => {
  assert.equal(renderGallery([], '_Be the first sponsor._'), '_Be the first sponsor._');
});

test('replaces exactly one marker pair', () => {
  const source = 'before\n<!-- sponsors:start -->\nold\n<!-- sponsors:end -->\nafter\n';
  assert.equal(
    replaceMarkedBlock(source, 'sponsors', 'new'),
    'before\n<!-- sponsors:start -->\nnew\n<!-- sponsors:end -->\nafter\n',
  );
  assert.throws(() => replaceMarkedBlock('missing', 'sponsors', 'new'), /exactly one/);
});

test('rejects duplicated or reversed marker pairs', () => {
  assert.throws(
    () => replaceMarkedBlock(
      '<!-- sponsors:start -->\nfirst\n<!-- sponsors:start -->\nsecond\n<!-- sponsors:end -->',
      'sponsors',
      'new',
    ),
    /exactly one/,
  );
  assert.throws(
    () => replaceMarkedBlock(
      '<!-- sponsors:start -->\nfirst\n<!-- sponsors:end -->\nsecond\n<!-- sponsors:end -->',
      'sponsors',
      'new',
    ),
    /exactly one/,
  );
  assert.throws(
    () => replaceMarkedBlock(
      '<!-- sponsors:end -->\nold\n<!-- sponsors:start -->',
      'sponsors',
      'new',
    ),
    /exactly one/,
  );
});

test('fetches all active public sponsors, removes nulls and duplicates, and sorts by login', async () => {
  const requests = [];
  const pages = [
    {
      data: {
        organization: {
          sponsorshipsAsMaintainer: {
            pageInfo: { hasNextPage: true, endCursor: 'page-2' },
            nodes: [
              {
                sponsorEntity: {
                  login: 'Zed',
                  name: 'Zed Industries',
                  avatarUrl: 'https://avatars.githubusercontent.com/u/3',
                  url: 'https://github.com/Zed',
                },
              },
              null,
              { sponsorEntity: null },
              {
                sponsorEntity: {
                  login: 'ada',
                  name: 'Ada',
                  avatarUrl: 'https://avatars.githubusercontent.com/u/1',
                  url: 'https://github.com/ada',
                },
              },
            ],
          },
        },
      },
    },
    {
      data: {
        organization: {
          sponsorshipsAsMaintainer: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                sponsorEntity: {
                  login: 'ADA',
                  name: 'Duplicate Ada',
                  avatarUrl: 'https://avatars.githubusercontent.com/u/11',
                  url: 'https://github.com/ADA',
                },
              },
              {
                sponsorEntity: {
                  login: 'bob',
                  name: null,
                  avatarUrl: 'https://avatars.githubusercontent.com/u/2',
                  url: 'https://github.com/bob',
                },
              },
            ],
          },
        },
      },
    },
  ];

  const sponsors = await fetchSponsors(async (url, init) => {
    requests.push({ url, init });
    return jsonResponse(pages[requests.length - 1]);
  }, 'secret-token');

  assert.deepEqual(sponsors, [
    {
      login: 'ada',
      name: 'Ada',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1',
      url: 'https://github.com/ada',
    },
    {
      login: 'bob',
      name: null,
      avatarUrl: 'https://avatars.githubusercontent.com/u/2',
      url: 'https://github.com/bob',
    },
    {
      login: 'Zed',
      name: 'Zed Industries',
      avatarUrl: 'https://avatars.githubusercontent.com/u/3',
      url: 'https://github.com/Zed',
    },
  ]);
  assert.equal(requests.length, 2);

  for (const [index, request] of requests.entries()) {
    assert.equal(request.url, 'https://api.github.com/graphql');
    assert.equal(request.init.method, 'POST');
    const headers = new Headers(request.init.headers);
    assert.equal(headers.get('Authorization'), 'Bearer secret-token');
    assert.equal(headers.get('Accept'), 'application/vnd.github+json');
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert.equal(headers.get('X-GitHub-Api-Version'), '2022-11-28');

    const body = JSON.parse(request.init.body);
    assert.equal(body.variables.login, 'LanternOps');
    assert.equal(body.variables.cursor, index === 0 ? null : 'page-2');
    assert.match(body.query, /activeOnly:\s*true/);
    assert.match(body.query, /includePrivate:\s*false/);
    assert.doesNotMatch(body.query, /privacyLevel|amount|tier/i);
  }
});

test('rejects failed and malformed sponsor API responses', async (t) => {
  const cases = [
    {
      name: 'non-2xx response',
      response: new Response('server error', { status: 500 }),
      error: /GraphQL request failed.*500/,
    },
    {
      name: 'GraphQL errors',
      response: jsonResponse({ errors: [{ message: 'forbidden' }] }),
      error: /GraphQL.*forbidden/,
    },
    {
      name: 'missing organization',
      response: jsonResponse({ data: { organization: null } }),
      error: /organization/,
    },
    {
      name: 'malformed connection',
      response: jsonResponse({
        data: {
          organization: {
            sponsorshipsAsMaintainer: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: null,
            },
          },
        },
      }),
      error: /connection/,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      await assert.rejects(
        fetchSponsors(async () => fixture.response, 'secret-token'),
        fixture.error,
      );
    });
  }
});

test('fetches contributor pages through the final short page and filters bots', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    login: `person-${index}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${index}`,
    html_url: `https://github.com/person-${index}`,
    type: 'User',
  }));
  firstPage[1] = {
    login: 'release-service',
    avatar_url: 'https://avatars.githubusercontent.com/u/1001',
    html_url: 'https://github.com/apps/release-service',
    type: 'Bot',
  };
  firstPage[2] = {
    login: 'dependabot[bot]',
    avatar_url: 'https://avatars.githubusercontent.com/u/1002',
    html_url: 'https://github.com/dependabot',
    type: 'User',
  };
  const secondPage = [
    {
      login: 'final-person',
      avatar_url: 'https://avatars.githubusercontent.com/u/2000',
      html_url: 'https://github.com/final-person',
      type: 'User',
    },
    {
      login: 'final-bot[bot]',
      avatar_url: 'https://avatars.githubusercontent.com/u/2001',
      html_url: 'https://github.com/final-bot',
      type: 'User',
    },
  ];
  const requests = [];

  const contributors = await fetchContributors(async (url, init) => {
    requests.push({ url, init });
    return jsonResponse(requests.length === 1 ? firstPage : secondPage);
  }, 'secret-token');

  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      'https://api.github.com/repos/LanternOps/breeze/contributors?anon=0&per_page=100&page=1',
      'https://api.github.com/repos/LanternOps/breeze/contributors?anon=0&per_page=100&page=2',
    ],
  );
  for (const { init } of requests) {
    const headers = new Headers(init.headers);
    assert.equal(init.method, 'GET');
    assert.equal(headers.get('Authorization'), 'Bearer secret-token');
    assert.equal(headers.get('Accept'), 'application/vnd.github+json');
    assert.equal(headers.get('X-GitHub-Api-Version'), '2022-11-28');
  }
  assert.equal(contributors.length, 99);
  assert.deepEqual(contributors.slice(0, 2), [
    {
      login: 'person-0',
      avatarUrl: 'https://avatars.githubusercontent.com/u/0',
      url: 'https://github.com/person-0',
      type: 'User',
    },
    {
      login: 'person-3',
      avatarUrl: 'https://avatars.githubusercontent.com/u/3',
      url: 'https://github.com/person-3',
      type: 'User',
    },
  ]);
  assert.equal(contributors.at(-1).login, 'final-person');
});

test('builds both README galleries in memory with stable empty states', () => {
  const result = buildReadme(readmeSource, [], []);
  assert.equal(
    result,
    `before
<!-- sponsors:start -->
_No public sponsors yet. [Become the first sponsor →](https://github.com/sponsors/LanternOps)_
<!-- sponsors:end -->
middle
<!-- contributors:start -->
_No contributors are available yet._
<!-- contributors:end -->
after
`,
  );
});

test('does not write when an API request fails', async () => {
  let writeCalls = 0;
  const fsImpl = {
    readFile: async () => readmeSource,
    writeFile: async () => { writeCalls += 1; },
    rename: async () => { writeCalls += 1; },
    rm: async () => { writeCalls += 1; },
  };

  await assert.rejects(
    updateReadme({
      fetchImpl: async (url) => (url === 'https://api.github.com/graphql'
        ? new Response('failed', { status: 503 })
        : jsonResponse([])),
      token: 'secret-token',
      readmePath: '/repo/README.md',
      fsImpl,
    }),
    /503/,
  );
  assert.equal(writeCalls, 0);
});

test('does not write when README markers are malformed', async () => {
  let writeCalls = 0;
  const fsImpl = {
    readFile: async () => '<!-- sponsors:start -->\nold\n<!-- sponsors:end -->\n',
    writeFile: async () => { writeCalls += 1; },
    rename: async () => { writeCalls += 1; },
    rm: async () => { writeCalls += 1; },
  };

  await assert.rejects(
    updateReadme({
      fetchImpl: successfulFetch,
      token: 'secret-token',
      readmePath: '/repo/README.md',
      fsImpl,
    }),
    /contributors marker pair/,
  );
  assert.equal(writeCalls, 0);
});

test('atomically replaces a changed README and makes the second update a no-op', async () => {
  let source = readmeSource;
  let temporary;
  const operations = [];
  const readmePath = '/repo/README.md';
  const expectedTemporaryPath = `${readmePath}.${process.pid}.tmp`;
  const fsImpl = {
    readFile: async (path, encoding) => {
      assert.equal(path, readmePath);
      assert.equal(encoding, 'utf8');
      return source;
    },
    writeFile: async (path, content, encoding) => {
      assert.equal(path, expectedTemporaryPath);
      assert.equal(encoding, 'utf8');
      operations.push(['write', path]);
      temporary = content;
    },
    rename: async (from, to) => {
      assert.equal(from, expectedTemporaryPath);
      assert.equal(to, readmePath);
      operations.push(['rename', from, to]);
      source = temporary;
      temporary = undefined;
    },
    rm: async (path, options) => {
      assert.equal(path, expectedTemporaryPath);
      assert.deepEqual(options, { force: true });
      operations.push(['rm', path]);
      temporary = undefined;
    },
  };

  assert.deepEqual(
    await updateReadme({
      fetchImpl: successfulFetch,
      token: 'secret-token',
      readmePath,
      fsImpl,
    }),
    { changed: true },
  );
  assert.deepEqual(
    await updateReadme({
      fetchImpl: successfulFetch,
      token: 'secret-token',
      readmePath,
      fsImpl,
    }),
    { changed: false },
  );
  assert.deepEqual(operations, [
    ['write', expectedTemporaryPath],
    ['rename', expectedTemporaryPath, readmePath],
  ]);
});

test('removes the temporary sibling when atomic replacement fails', async () => {
  const readmePath = '/repo/README.md';
  const expectedTemporaryPath = `${readmePath}.${process.pid}.tmp`;
  let temporary;
  const operations = [];
  const fsImpl = {
    readFile: async () => readmeSource,
    writeFile: async (path, content) => {
      assert.equal(path, expectedTemporaryPath);
      operations.push('write');
      temporary = content;
    },
    rename: async () => {
      operations.push('rename');
      throw new Error('rename failed');
    },
    rm: async (path, options) => {
      assert.equal(path, expectedTemporaryPath);
      assert.deepEqual(options, { force: true });
      operations.push('rm');
      temporary = undefined;
    },
  };

  await assert.rejects(
    updateReadme({
      fetchImpl: successfulFetch,
      token: 'secret-token',
      readmePath,
      fsImpl,
    }),
    /rename failed/,
  );
  assert.deepEqual(operations, ['write', 'rename', 'rm']);
  assert.equal(temporary, undefined);
});

test('repository funding points GitHub Sponsors at LanternOps', async () => {
  const funding = await readFile(new URL('../FUNDING.yml', import.meta.url), 'utf8');
  assert.equal(funding, 'github: LanternOps\n');
});

test('repository README contains exactly one ordered community marker pair', async () => {
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');

  for (const name of ['sponsors', 'contributors']) {
    const start = `<!-- ${name}:start -->`;
    const end = `<!-- ${name}:end -->`;
    assert.equal(readme.split(start).length - 1, 1, `${name} start marker count`);
    assert.equal(readme.split(end).length - 1, 1, `${name} end marker count`);
    assert.ok(readme.indexOf(start) < readme.indexOf(end), `${name} markers are ordered`);
  }
});

test('repository workflow updates the README on schedule or by dispatch', async () => {
  const workflow = await readFile(
    new URL('../workflows/update-community-readme.yml', import.meta.url),
    'utf8',
  );

  assert.match(workflow, /^\s*schedule:\s*$/m);
  assert.match(workflow, /^\s*- cron: ['"]17 5 \* \* \*['"]\s*$/m);
  assert.match(workflow, /^\s*workflow_dispatch:\s*$/m);
  assert.match(workflow, /^permissions:\n  contents: write$/m);
  assert.match(workflow, /node \.github\/scripts\/update-community-readme\.mjs/);
  assert.doesNotMatch(workflow, /^\s*pull_request:\s*$/m);
});
