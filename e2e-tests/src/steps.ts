import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import type { Config, TestStep, RunnerContext, UiSession, CLIOptions, JsonRpcResponse } from './types.js';
import { isRecord, resolveEnvString, resolveTemplates, interpolateTemplate, extractStructuredResult, assertExpectations, lookupVar, asNumber, normalizeUrl } from './utils.js';
import { ensureUiSession, runUiPlaywrightAction, isLoginStep, captureSimulatedExtracts, cachedStorageState, cachedApiToken, setCachedApiToken } from './browser.js';

const __filename = fileURLToPath(import.meta.url);
const E2E_DIR = path.resolve(path.dirname(__filename), '..');

function buildNodeBaseUrl(host: string, port: number): string {
  const normalizedHost = host.startsWith('http://') || host.startsWith('https://') ? host : `http://${host}`;
  const url = new URL(normalizedHost);
  if (!url.port) {
    url.port = String(port);
  }
  return `${url.protocol}//${url.host}`;
}

function resolveNode(nodeId: string, config: Config): { baseUrl: string; token: string; platform?: string } {
  const rawNode = config.nodes[nodeId];
  if (!rawNode) {
    throw new Error(`Unknown node "${nodeId}" in config.yaml`);
  }

  const host = rawNode.host ? resolveEnvString(rawNode.host) : '';
  if (!host) {
    throw new Error(`Node "${nodeId}" is missing host configuration`);
  }

  const token = rawNode.auth?.token ? resolveEnvString(String(rawNode.auth.token)) : '';
  const port = Number(rawNode.port ?? 3100);

  return {
    baseUrl: buildNodeBaseUrl(host, port),
    token,
    platform: rawNode.platform,
  };
}

async function postJsonWithTimeout(url: string, payload: unknown, headers: Record<string, string>, timeoutMs: number): Promise<JsonRpcResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const bodyText = await response.text();
    const bodyJson = bodyText ? (JSON.parse(bodyText) as JsonRpcResponse) : {};

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}: ${bodyText}`);
    }

    return bodyJson;
  } finally {
    clearTimeout(timeout);
  }
}

async function authenticateApi(config: Config): Promise<string> {
  if (cachedApiToken) return cachedApiToken;

  const apiConfig = config.api;
  if (!apiConfig) {
    throw new Error('No api auth configuration in config.yaml. Add an "api" section with apiKey or email/password.');
  }

  if (apiConfig.apiKey) {
    const key = resolveEnvString(apiConfig.apiKey);
    if (key) {
      setCachedApiToken(key);
      return key;
    }
  }

  const email = apiConfig.email ? resolveEnvString(apiConfig.email) : '';
  const password = apiConfig.password ? resolveEnvString(apiConfig.password) : '';
  if (!email || !password) {
    throw new Error('API auth requires either apiKey or email+password in config.yaml');
  }

  const apiUrl = resolveEnvString(config.environment.apiUrl);
  const response = await fetch(`${apiUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    throw new Error(`API login failed: HTTP ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  let token = '';
  if (typeof data.token === 'string') {
    token = data.token;
  } else if (isRecord(data.tokens) && typeof (data.tokens as Record<string, unknown>).accessToken === 'string') {
    token = (data.tokens as Record<string, unknown>).accessToken as string;
  }
  if (!token) {
    throw new Error(`API login response missing token field. Keys: ${Object.keys(data).join(', ')}`);
  }

  setCachedApiToken(token);
  return token;
}

function evaluatePollCondition(condition: string, result: unknown): boolean {
  if (!isRecord(result)) return false;

  const match = condition.match(/^([\w.]+)\s*(===?|!==?|>=?|<=?)\s*(.+)$/);
  if (!match) return false;

  const [, propPath, operator, rawValue] = match;
  const actual = lookupVar(result, propPath);

  let expected: unknown;
  const trimmedValue = rawValue.trim();
  if (trimmedValue === 'true') expected = true;
  else if (trimmedValue === 'false') expected = false;
  else if (trimmedValue === 'null') expected = null;
  else if (/^['"](.*)['"]$/.test(trimmedValue)) expected = trimmedValue.slice(1, -1);
  else if (!Number.isNaN(Number(trimmedValue))) expected = Number(trimmedValue);
  else expected = trimmedValue;

  switch (operator) {
    case '==':
    case '===':
      return actual === expected;
    case '!=':
    case '!==':
      return actual !== expected;
    case '>':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case '>=':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case '<':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case '<=':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    default:
      return false;
  }
}

// --- Step runners ---

export async function runUiStepLive(
  step: TestStep,
  context: RunnerContext,
  currentSession: UiSession | null,
  config: Config,
  options: CLIOptions,
  testId?: string
): Promise<{ output: Record<string, unknown>; session: UiSession }> {
  const session = await ensureUiSession(currentSession, context, config);
  const output: Record<string, unknown> = {};
  const actionTimeout = step.timeout ?? config.environment.defaultTimeout ?? 30000;
  const actions = Array.isArray(step.playwright) ? step.playwright : [];

  const authTestIds = ['auth_login_logout', 'auth_invalid_login'];
  const isAuthTest = testId ? authTestIds.some(id => testId.startsWith(id)) : false;
  // Trust the cached cookie. The previous version of this block navigated
  // to `/` and inspected the URL to verify the session, but that probe
  // races against the React auth-store rehydration (initial render briefly
  // sees `isAuthenticated=false` and the route guard redirects to /login),
  // so the runner would wipe a perfectly good cookie ~80% of the time and
  // force every test to re-log in. Skipping the probe means each downstream
  // test simply uses the cached state; if the cookie really is dead, the
  // first navigation in the test will fail and only that test takes the
  // hit, instead of cascading the wipe to every subsequent test.
  if (cachedStorageState && isLoginStep(step) && !isAuthTest) {
    console.log('     [UI] Cached session present — skipping login step');
    output.live = true;
    output.loginSkipped = true;
    return { output, session };
  }

  for (const action of actions) {
    await runUiPlaywrightAction(session.page, action, context, output, actionTimeout, config);
  }

  if (!('live' in output)) {
    output.live = true;
  }

  return { output, session };
}

export async function runRemoteStepLive(step: TestStep, context: RunnerContext, config: Config): Promise<unknown> {
  if (!step.node) {
    throw new Error('Remote step is missing node');
  }

  const node = resolveNode(step.node, config);
  const requestId = `${step.id}-${Date.now()}`;
  const timeoutMs = step.timeout ?? config.environment.defaultTimeout ?? 30000;

  const renderedArgs = resolveTemplates(step.args ?? {}, context.vars) as Record<string, unknown>;

  const rpcRequest = {
    jsonrpc: '2.0',
    id: requestId,
    method: 'tools/call',
    params: {
      name: step.tool ?? 'claude_code',
      arguments: renderedArgs,
    },
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (node.token) {
    headers.Authorization = `Bearer ${node.token}`;
  }

  const response = await postJsonWithTimeout(`${node.baseUrl}/mcp`, rpcRequest, headers, timeoutMs);

  if (response.error) {
    throw new Error(`Remote MCP error ${response.error.code}: ${response.error.message}`);
  }

  const structured = extractStructuredResult(response.result);

  if (step.expect !== undefined) {
    const expected = resolveTemplates(step.expect, context.vars);
    assertExpectations(expected, structured);
  }

  return structured;
}

export async function runApiStepLive(step: TestStep, context: RunnerContext, config: Config, options: CLIOptions): Promise<unknown> {
  const request = step.request;
  if (!request) {
    throw new Error('API step is missing request configuration');
  }

  const skipAuth = step.auth === 'none';
  const token = skipAuth ? '' : await authenticateApi(config);
  const apiUrl = resolveEnvString(config.environment.apiUrl);
  const method = (request.method ?? 'GET').toUpperCase();

  const poll = step.poll;
  const maxAttempts = poll ? Math.max(1, poll.maxAttempts ?? 1) : 1;
  const intervalMs = poll?.intervalMs ?? 3000;
  const until = poll?.until;

  let lastResult: unknown = undefined;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resolvedPath = interpolateTemplate(request.path, context.vars);
      const url = new URL(resolvedPath, apiUrl);

      if (request.query) {
        const resolvedQuery = resolveTemplates(request.query, context.vars);
        if (isRecord(resolvedQuery)) {
          for (const [key, value] of Object.entries(resolvedQuery)) {
            if (value !== undefined && value !== null && String(value) !== '') {
              url.searchParams.set(key, String(value));
            }
          }
        }
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (!skipAuth && token) {
        headers.Authorization = `Bearer ${token}`;
      }
      if (step.headers) {
        const resolvedHeaders = resolveTemplates(step.headers, context.vars);
        if (isRecord(resolvedHeaders)) {
          for (const [k, v] of Object.entries(resolvedHeaders)) {
            if (v !== undefined && v !== null) {
              headers[k] = String(v);
            }
          }
        }
      }

      const fetchOptions: RequestInit = { method, headers };

      if (request.body && method !== 'GET') {
        const resolvedBody = resolveTemplates(request.body, context.vars);
        fetchOptions.body = JSON.stringify(resolvedBody);
      }

      const timeoutMs = step.timeout ?? config.environment.defaultTimeout ?? 30000;
      const controller = new AbortController();
      const abortTimeout = setTimeout(() => controller.abort(), timeoutMs);
      fetchOptions.signal = controller.signal;

      let resp = await fetch(url.toString(), fetchOptions);
      clearTimeout(abortTimeout);

      if (!skipAuth && resp.status === 401 && cachedApiToken) {
        setCachedApiToken(null);
        const freshToken = await authenticateApi(config);
        fetchOptions.headers = { ...fetchOptions.headers as Record<string, string>, Authorization: `Bearer ${freshToken}` };
        resp = await fetch(url.toString(), fetchOptions);
      }

      if (!resp.ok) {
        throw new Error(`API ${method} ${resolvedPath} returned ${resp.status}: ${await resp.text()}`);
      }

      const contentType = resp.headers.get('content-type') ?? '';
      lastResult = contentType.includes('json') ? await resp.json() : await resp.text();
      lastError = null;

      // If this step is flagged as an MCP tools/call response, unwrap
      // result.content[0].text JSON and use that as the assert/return target.
      let unwrapped: unknown = lastResult;
      if (step.mcp_result && isRecord(lastResult)) {
        if (isRecord(lastResult.error)) {
          const err = lastResult.error;
          throw new Error(`MCP error ${String(err.code ?? '?')}: ${String(err.message ?? JSON.stringify(err))}`);
        }
        const structured = extractStructuredResult(lastResult.result);
        if (structured !== undefined) {
          unwrapped = structured;
        }
      }

      if (!until || evaluatePollCondition(until, unwrapped)) {
        if (step.expect !== undefined) {
          const expected = resolveTemplates(step.expect, context.vars);
          assertExpectations(expected, unwrapped);
        }
        return unwrapped;
      }

      if (attempt < maxAttempts) {
        if (options.verbose) {
          console.log(`     [API] Poll ${attempt}/${maxAttempts} — condition not met, waiting ${intervalMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!poll || attempt >= maxAttempts) throw lastError;
      if (options.verbose) {
        console.log(`     [API] Poll ${attempt}/${maxAttempts} — error: ${lastError.message}, retrying in ${intervalMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  if (until) {
    throw new Error(`Poll condition "${until}" not met after ${maxAttempts} attempts`);
  }

  if (lastError) throw lastError;
  return lastResult;
}

export function runUiStepSimulated(step: TestStep, context: RunnerContext, options: CLIOptions): Record<string, unknown> {
  console.log('     [UI] Simulated Playwright actions');
  if (options.verbose && step.playwright) {
    console.log(`     Actions: ${JSON.stringify(step.playwright, null, 2)}`);
  }
  captureSimulatedExtracts(step, context.vars);
  return { simulated: true };
}

export function runRemoteStepSimulated(step: TestStep, context: RunnerContext, options: CLIOptions): Record<string, unknown> {
  console.log(`     [REMOTE:${step.node}] (deprecated) Simulated call to ${step.tool ?? 'claude_code'}`);
  if (options.verbose && step.args) {
    console.log(`     Args: ${JSON.stringify(resolveTemplates(step.args, context.vars), null, 2)}`);
  }
  return { simulated: true };
}

export function runApiStepSimulated(step: TestStep, context: RunnerContext, options: CLIOptions): Record<string, unknown> {
  console.log(`     [API] Simulated ${step.request?.method ?? 'GET'} ${step.request?.path ?? ''}`);
  if (options.verbose && step.request) {
    console.log(`     Request: ${JSON.stringify(resolveTemplates(step.request, context.vars), null, 2)}`);
  }
  return { simulated: true };
}

// --- Seed step (idempotent SQL fixtures via docker exec psql) ---

export async function runSeedStepLive(step: TestStep, _context: RunnerContext, _config: Config): Promise<Record<string, unknown>> {
  const sqlFileRel = step.seed?.sqlFile ?? 'seed-fixtures.sql';
  const container = step.seed?.container ?? 'breeze-postgres';
  const database = step.seed?.database ?? process.env.POSTGRES_DB ?? 'breeze';
  const dbUser = step.seed?.user ?? process.env.POSTGRES_USER ?? 'breeze';

  const sqlPath = path.isAbsolute(sqlFileRel) ? sqlFileRel : path.join(E2E_DIR, sqlFileRel);
  if (!fs.existsSync(sqlPath)) {
    throw new Error(`Seed file not found: ${sqlPath}`);
  }

  const sql = fs.readFileSync(sqlPath, 'utf-8');

  // docker exec -i <container> psql -U <user> -d <database> -v ON_ERROR_STOP=1 -f -
  const args = [
    'exec', '-i', container,
    'psql', '-U', dbUser, '-d', database,
    '-v', 'ON_ERROR_STOP=1',
    '-q',
    '-f', '-',
  ];

  try {
    const stdout = execFileSync('docker', args, {
      input: sql,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: step.timeout ?? 60000,
    });
    const output = stdout.toString().trim();
    if (output) {
      for (const line of output.split('\n')) {
        console.log(`     [SEED] ${line}`);
      }
    }
    return { seeded: true, file: sqlFileRel };
  } catch (error: any) {
    const stderr = error?.stderr?.toString?.() ?? '';
    const stdout = error?.stdout?.toString?.() ?? '';
    const detail = [stdout, stderr].filter(Boolean).join('\n').trim();

    // Container missing or docker not running → treat as non-fatal so the
    // bootstrap step doesn't block runs against remote/non-docker deployments.
    // The downstream tests will fail naturally if the data really isn't there.
    const benign = /No such container|Cannot connect to the Docker daemon|Is the docker daemon running/i.test(detail);
    if (benign) {
      console.log(`     [SEED] Skipping — local docker postgres not available (${detail.split('\n')[0] || 'no detail'})`);
      return { seeded: false, skipped: true, reason: 'docker-unavailable' };
    }

    throw new Error(`Seed failed running ${sqlFileRel}: ${detail || error.message}`);
  }
}

export function runSeedStepSimulated(step: TestStep, _context: RunnerContext, _options: CLIOptions): Record<string, unknown> {
  const sqlFile = step.seed?.sqlFile ?? 'seed-fixtures.sql';
  console.log(`     [SEED] Simulated psql -f ${sqlFile}`);
  return { simulated: true, seeded: false };
}
