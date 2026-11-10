// GitHub REST + GraphQL adapter for the CI shepherd (W06, #10744 / #10750).
//
// Dependency-free. Every request to api.github.com counts against `budget`
// (the operator token's 5,000/h is shared with other sessions); past it, the
// next call throws BudgetExceeded before touching the network. A read (GET, or
// a GraphQL query) is retried once after a 5xx. A mutation never is: a 5xx can
// arrive after GitHub applied it, and a blind retry would apply it twice.

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export class BudgetExceeded extends Error {
  constructor(budget) {
    super(`GitHub API budget of ${budget} calls exhausted`);
    this.name = 'BudgetExceeded';
    this.budget = budget;
  }
}

const API = 'https://api.github.com';
const MUTATION = /^(?:\s|#[^\n]*\n)*mutation\b/;

export const isMutationQuery = (query) => MUTATION.test(query);

export function createGitHub({ token, fetchImpl = fetch, budget = 600, userAgent = 'breeze-ci-shepherd' }) {
  if (!token) throw new Error('createGitHub: a token is required');
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': userAgent,
  };
  const gh = { calls: 0, budget };
  const url = (path) => (/^https?:\/\//.test(path) ? path : `${API}/${path.replace(/^\/+/, '')}`);

  // One counted request. Network failures surface as GitHubError(0).
  async function send(method, path, { body, redirect = 'follow' } = {}) {
    if (gh.calls >= gh.budget) throw new BudgetExceeded(gh.budget);
    gh.calls++;
    const init = { method, headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' }, redirect };
    if (body !== undefined) init.body = JSON.stringify(body);
    try {
      return await fetchImpl(url(path), init);
    } catch (e) {
      throw new GitHubError(0, `${method} ${path}: ${e.message}`);
    }
  }

  async function readJson(res) {
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { message: text.slice(0, 200) };
    }
  }

  gh.rest = async (method, path, body) => {
    const m = method.toUpperCase();
    let res = await send(m, path, { body });
    if (m === 'GET' && res.status >= 500) res = await send(m, path, { body });
    return { status: res.status, body: await readJson(res), headers: Object.fromEntries(res.headers) };
  };

  gh.graphql = async (query, variables = {}) => {
    const mutation = isMutationQuery(query);
    let res = await send('POST', 'graphql', { body: { query, variables } });
    if (!mutation && res.status >= 500) res = await send('POST', 'graphql', { body: { query, variables } });
    const json = await readJson(res);
    if (res.status !== 200) throw new GitHubError(res.status, `GraphQL ${res.status}: ${json.message ?? 'request failed'}`);
    if (Array.isArray(json.errors) && json.errors.length) {
      throw new GitHubError(200, `GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    return json.data;
  };

  // Job logs and artifact zips answer 302 to a signed blob URL. The redirect
  // is followed by hand so the token is never sent to the blob host, and that
  // second request is not an API call (it does not count against the budget).
  gh.raw = async (path, { binary = false } = {}) => {
    let res = await send('GET', path, { redirect: 'manual' });
    if (res.status >= 500) res = await send('GET', path, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      try {
        res = await fetchImpl(res.headers.get('location'), { method: 'GET', headers: { 'User-Agent': userAgent } });
      } catch (e) {
        throw new GitHubError(0, `GET ${path} (redirect): ${e.message}`);
      }
    }
    if (binary) return { status: res.status, bytes: res.ok ? Buffer.from(await res.arrayBuffer()) : null };
    return { status: res.status, text: res.ok ? await res.text() : null };
  };

  return gh;
}
