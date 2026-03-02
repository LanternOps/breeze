import type { Config, TestStep, RunnerContext, UiSession, CLIOptions, JsonRpcResponse } from './types.js';
import { isRecord, resolveEnvString, resolveTemplates, interpolateTemplate, extractStructuredResult, assertExpectations, lookupVar, asNumber, normalizeUrl } from './utils.js';
import { ensureUiSession, runUiPlaywrightAction, isLoginStep, captureSimulatedExtracts, cachedStorageState, cachedApiToken, setCachedApiToken, setCachedStorageState } from './browser.js';

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
  if (cachedStorageState && isLoginStep(step) && !isAuthTest) {
    try {
      const baseUrl = String(context.vars.baseUrl ?? resolveEnvString(config.environment.baseUrl));
      await session.page.goto(normalizeUrl('/', baseUrl), { waitUntil: 'domcontentloaded', timeout: 10000 });
      try { await session.page.waitForLoadState('networkidle', { timeout: 3000 }); } catch {}
      const currentUrl = session.page.url();
      if (!currentUrl.includes('/login')) {
        console.log('     [UI] Session still valid — skipping login step');
        output.live = true;
        output.loginSkipped = true;
        return { output, session };
      }
      console.log('     [UI] Session expired — clearing cookies and re-logging in');
      setCachedStorageState(null);
      try { await session.context.clearCookies(); } catch {}
    } catch {
      // Navigation failed — proceed with normal login
    }
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

  const token = await authenticateApi(config);
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
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      };

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

      if (resp.status === 401 && cachedApiToken) {
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

      if (!until || evaluatePollCondition(until, lastResult)) {
        if (step.expect !== undefined) {
          const expected = resolveTemplates(step.expect, context.vars);
          assertExpectations(expected, lastResult);
        }
        return lastResult;
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
