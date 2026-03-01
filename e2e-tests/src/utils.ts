const ENV_EXPR = /\$\{([A-Z0-9_]+)(:-([^}]*))?\}/g;
const TEMPLATE_EXPR = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveEnvString(input: string): string {
  return input.replace(ENV_EXPR, (_m, varName: string, _fallbackExpr: string, fallbackValue: string) => {
    const envValue = process.env[varName];
    if (envValue !== undefined && envValue !== '') {
      return envValue;
    }
    return fallbackValue ?? '';
  });
}

export function lookupVar(vars: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.');
  let current: unknown = vars;
  for (const part of parts) {
    if (!isRecord(current) || !(part in current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

export function interpolateTemplate(input: string, vars: Record<string, unknown>): string {
  const envResolved = resolveEnvString(input);
  return envResolved.replace(TEMPLATE_EXPR, (_m, key: string) => {
    const value = lookupVar(vars, key);
    if (value === undefined || value === null || value === '') {
      console.warn(`     [WARN] Template variable {{${key}}} is empty — check your .env or config.yaml`);
      return `__MISSING_${key}__`;
    }
    return String(value);
  });
}

export function resolveTemplates<T>(value: T, vars: Record<string, unknown>): T {
  if (typeof value === 'string') {
    return interpolateTemplate(value, vars) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveTemplates(entry, vars)) as T;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveTemplates(v, vars);
    }
    return out as T;
  }
  return value;
}

export function parseJsonFromText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // continue
    }
  }

  const objectLike = trimmed.match(/\{[\s\S]*\}/);
  if (objectLike?.[0]) {
    try {
      return JSON.parse(objectLike[0]);
    } catch {
      // continue
    }
  }

  return undefined;
}

export function extractStructuredResult(result: unknown): unknown {
  if (!isRecord(result)) {
    return result;
  }

  if (isRecord(result.structuredContent)) {
    return result.structuredContent;
  }

  if (Array.isArray(result.content)) {
    for (const chunk of result.content) {
      if (!isRecord(chunk)) continue;
      if (typeof chunk.text === 'string') {
        const parsed = parseJsonFromText(chunk.text);
        if (parsed !== undefined) return parsed;
      }
    }
  }

  if (typeof result.text === 'string') {
    const parsed = parseJsonFromText(result.text);
    if (parsed !== undefined) return parsed;
  }

  return result;
}

export function assertExpectations(expected: unknown, actual: unknown, pathLabel = 'result'): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      throw new Error(`${pathLabel}: expected array, got ${typeof actual}`);
    }
    if (expected.length !== actual.length) {
      throw new Error(`${pathLabel}: expected array length ${expected.length}, got ${actual.length}`);
    }
    for (let i = 0; i < expected.length; i++) {
      assertExpectations(expected[i], actual[i], `${pathLabel}[${i}]`);
    }
    return;
  }

  if (isRecord(expected)) {
    if (!isRecord(actual)) {
      throw new Error(`${pathLabel}: expected object, got ${typeof actual}`);
    }
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (!(key in actual)) {
        throw new Error(`${pathLabel}.${key}: missing key in actual result`);
      }
      assertExpectations(expectedValue, actual[key], `${pathLabel}.${key}`);
    }
    return;
  }

  if (typeof expected === 'string' && typeof actual === 'number') {
    const cmpMatch = expected.match(/^(>=?|<=?|!=)\s*(-?\d+(?:\.\d+)?)$/);
    if (cmpMatch) {
      const [, op, numStr] = cmpMatch;
      const threshold = parseFloat(numStr);
      const pass =
        op === '>' ? actual > threshold :
        op === '>=' ? actual >= threshold :
        op === '<' ? actual < threshold :
        op === '<=' ? actual <= threshold :
        op === '!=' ? actual !== threshold :
        false;
      if (!pass) {
        throw new Error(`${pathLabel}: expected ${expected}, got ${actual}`);
      }
      return;
    }
  }

  if (actual !== expected) {
    throw new Error(`${pathLabel}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return undefined;
}

export function normalizeUrl(target: string, baseUrl: string): string {
  if (target.startsWith('http://') || target.startsWith('https://')) {
    return target;
  }
  return new URL(target, baseUrl).toString();
}
