// e2e-tests/doc-verify/executors/api.ts
import type { ApiAssertion, AssertionResult } from '../types';

export function resolveVariables(
  template: string,
  env: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return env[key] ?? match;
  });
}

function resolveObject(
  obj: Record<string, unknown>,
  env: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = resolveVariables(value, env);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = resolveObject(value as Record<string, unknown>, env);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export async function executeApiAssertion(
  assertion: ApiAssertion,
  apiUrl: string,
  env: Record<string, string>,
): Promise<AssertionResult> {
  const start = Date.now();
  const { method, path, body, headers: rawHeaders, expect: expected } = assertion.test;

  const url = `${apiUrl}${resolveVariables(path, env)}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(rawHeaders
      ? Object.fromEntries(
          Object.entries(rawHeaders).map(([k, v]) => [k, resolveVariables(v, env)]),
        )
      : {}),
  };

  // Add auth token if available in env
  if (env.AUTH_TOKEN && !headers.Authorization) {
    headers.Authorization = `Bearer ${env.AUTH_TOKEN}`;
  }

  const resolvedBody = body ? resolveObject(body, env) : undefined;

  try {
    const isBodyAllowed = method !== 'GET' && method !== 'HEAD';
    const response = await fetch(url, {
      method,
      headers,
      body: isBodyAllowed && resolvedBody ? JSON.stringify(resolvedBody) : undefined,
    });

    const responseBody = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(responseBody);
    } catch {
      json = null;
    }

    const failures: string[] = [];

    if (expected.status && response.status !== expected.status) {
      failures.push(`Expected status ${expected.status}, got ${response.status}`);
    }

    if (expected.contentType) {
      const ct = response.headers.get('content-type') || '';
      if (!ct.includes(expected.contentType)) {
        failures.push(`Expected content-type "${expected.contentType}", got "${ct}"`);
      }
    }

    if (expected.bodyContains && json && typeof json === 'object') {
      for (const field of expected.bodyContains) {
        if (!(field in (json as Record<string, unknown>))) {
          failures.push(`Response body missing field "${field}"`);
        }
      }
    }

    if (expected.bodyNotContains && json && typeof json === 'object') {
      for (const field of expected.bodyNotContains) {
        if (field in (json as Record<string, unknown>)) {
          failures.push(`Response body should not contain field "${field}"`);
        }
      }
    }

    return {
      id: assertion.id,
      type: 'api',
      claim: assertion.claim,
      status: failures.length === 0 ? 'pass' : 'fail',
      reason: failures.length === 0 ? 'All checks passed' : failures.join('; '),
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      id: assertion.id,
      type: 'api',
      claim: assertion.claim,
      status: 'error',
      reason: `Request failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}
