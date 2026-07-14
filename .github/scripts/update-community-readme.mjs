import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const githubHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
});

const sponsorsQuery = `
  query PublicSponsors($login: String!, $cursor: String) {
    organization(login: $login) {
      sponsorshipsAsMaintainer(
        first: 100
        after: $cursor
        activeOnly: true
        includePrivate: false
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          sponsorEntity {
            ... on User { login name avatarUrl url }
            ... on Organization { login name avatarUrl url }
          }
        }
      }
    }
  }
`;

const defaultReadmePath = fileURLToPath(new URL('../../README.md', import.meta.url));
const githubRequestTimeoutMs = 30_000;

function parseHttpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  return url;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

export function isBot(account) {
  return account.type === 'Bot' || account.login.endsWith('[bot]');
}

export function renderGallery(accounts, emptyMarkdown) {
  if (accounts.length === 0) {
    return emptyMarkdown;
  }

  return accounts.map((account) => {
    const displayName = account.name || account.login;
    parseHttpsUrl(account.url, 'Profile URL');
    const avatarUrl = parseHttpsUrl(account.avatarUrl, 'Avatar URL');
    avatarUrl.searchParams.set('s', '128');

    return '<a href="' + escapeHtml(account.url) + '">'
      + '<img src="' + escapeHtml(avatarUrl.toString()) + '"'
      + ' width="64" height="64"'
      + ' alt="' + escapeHtml(displayName) + '"'
      + ' title="' + escapeHtml(displayName + ' (@' + account.login + ')') + '" />'
      + '</a>';
  }).join('\n');
}

export function replaceMarkedBlock(markdown, name, content) {
  const start = '<!-- ' + name + ':start -->';
  const end = '<!-- ' + name + ':end -->';
  if (markdown.split(start).length !== 2
      || markdown.split(end).length !== 2
      || markdown.indexOf(start) > markdown.indexOf(end)) {
    throw new Error('README must contain exactly one ordered ' + name + ' marker pair');
  }
  return markdown.slice(0, markdown.indexOf(start))
    + start + '\n' + content + '\n' + end
    + markdown.slice(markdown.indexOf(end) + end.length);
}

export async function fetchSponsors(fetchImpl, token) {
  const sponsorsByLogin = new Map();
  const seenCursors = new Set();
  let cursor = null;

  do {
    const response = await fetchImpl('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        ...githubHeaders(token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: sponsorsQuery,
        variables: { login: 'LanternOps', cursor },
      }),
      signal: AbortSignal.timeout(githubRequestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`GitHub GraphQL request failed (${response.status})`);
    }

    const payload = await response.json();
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new Error(`GitHub GraphQL errors: ${payload.errors
        .map((error) => error.message || String(error))
        .join('; ')}`);
    }

    const organization = payload?.data?.organization;
    if (!organization) {
      throw new Error('GitHub GraphQL response is missing the LanternOps organization');
    }
    const connection = organization.sponsorshipsAsMaintainer;
    if (!connection
        || !Array.isArray(connection.nodes)
        || typeof connection.pageInfo?.hasNextPage !== 'boolean'
        || (connection.pageInfo.endCursor !== null
          && typeof connection.pageInfo.endCursor !== 'string')) {
      throw new Error('GitHub GraphQL response contains a malformed sponsorship connection');
    }
    if (connection.pageInfo.hasNextPage && !connection.pageInfo.endCursor) {
      throw new Error('GitHub GraphQL response contains a malformed sponsorship connection');
    }
    if (connection.pageInfo.hasNextPage
        && seenCursors.has(connection.pageInfo.endCursor)) {
      throw new Error('GitHub GraphQL response contains a repeated pagination cursor');
    }

    for (const node of connection.nodes) {
      const sponsor = node?.sponsorEntity;
      if (sponsor == null) {
        continue;
      }
      if (typeof sponsor.login !== 'string'
          || (sponsor.name !== null && sponsor.name !== undefined
            && typeof sponsor.name !== 'string')
          || typeof sponsor.avatarUrl !== 'string'
          || typeof sponsor.url !== 'string') {
        throw new Error('GitHub GraphQL response contains a malformed sponsor');
      }
      const key = sponsor.login.toLowerCase();
      if (!sponsorsByLogin.has(key)) {
        sponsorsByLogin.set(key, sponsor);
      }
    }

    if (connection.pageInfo.hasNextPage) {
      seenCursors.add(connection.pageInfo.endCursor);
      cursor = connection.pageInfo.endCursor;
    } else {
      cursor = null;
    }
  } while (cursor !== null);

  return [...sponsorsByLogin.values()].sort((left, right) => (
    left.login.localeCompare(right.login, 'en', { sensitivity: 'base' })
  ));
}

export async function fetchContributors(fetchImpl, token) {
  const contributors = [];
  let page = 1;
  let entries;

  do {
    const url = 'https://api.github.com/repos/LanternOps/breeze/contributors'
      + `?anon=0&per_page=100&page=${page}`;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(githubRequestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`GitHub contributors request failed (${response.status})`);
    }

    entries = await response.json();
    if (!Array.isArray(entries)) {
      throw new Error('GitHub contributors response must be an array');
    }

    for (const entry of entries) {
      if (typeof entry?.login !== 'string'
          || typeof entry.avatar_url !== 'string'
          || typeof entry.html_url !== 'string'
          || typeof entry.type !== 'string') {
        throw new Error('GitHub contributors response contains a malformed account');
      }
      const contributor = {
        login: entry.login,
        avatarUrl: entry.avatar_url,
        url: entry.html_url,
        type: entry.type,
      };
      if (!isBot(contributor)) {
        contributors.push(contributor);
      }
    }
    page += 1;
  } while (entries.length === 100);

  return contributors;
}

export function buildReadme(source, sponsors, contributors) {
  const withSponsors = replaceMarkedBlock(
    source,
    'sponsors',
    renderGallery(
      sponsors,
      '_No public sponsors yet. [Become the first sponsor →](https://github.com/sponsors/LanternOps)_',
    ),
  );
  return replaceMarkedBlock(
    withSponsors,
    'contributors',
    renderGallery(contributors, '_No contributors are available yet._'),
  );
}

export async function updateReadme({
  fetchImpl = globalThis.fetch,
  token,
  readmePath = defaultReadmePath,
  fsImpl = { readFile, writeFile, rename, rm },
} = {}) {
  if (!token) {
    throw new Error('GITHUB_TOKEN is required');
  }

  const [source, sponsors, contributors] = await Promise.all([
    fsImpl.readFile(readmePath, 'utf8'),
    fetchSponsors(fetchImpl, token),
    fetchContributors(fetchImpl, token),
  ]);
  const updated = buildReadme(source, sponsors, contributors);
  if (updated === source) {
    return { changed: false };
  }

  const temporaryPath = `${readmePath}.${process.pid}.tmp`;
  try {
    await fsImpl.writeFile(temporaryPath, updated, 'utf8');
    await fsImpl.rename(temporaryPath, readmePath);
  } catch (error) {
    try {
      await fsImpl.rm(temporaryPath, { force: true });
    } catch {
      // Preserve the original update error.
    }
    throw error;
  }

  return { changed: true };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await updateReadme({ token: process.env.GITHUB_TOKEN });
    console.log(result.changed ? 'README.md changed' : 'README.md unchanged');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
