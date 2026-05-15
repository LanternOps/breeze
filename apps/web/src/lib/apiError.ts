// Parses error response bodies returned by the API. The API emits at least
// four shapes today: a plain `{error: string}`, a zod-validator
// `{error: {issues: [...]}}`, a `{error: string, details: object|array}`
// pair from route validators, and Hono's default `{message: string}`.
// Falling back to `new Error(obj)` produces `[object Object]` in the UI;
// this function picks the most readable rendering of whatever we got.

type ZodIssue = { message?: string; path?: Array<string | number> };

function joinZodIssues(issues: unknown): string | null {
  if (!Array.isArray(issues) || issues.length === 0) return null;
  const messages = issues
    .map((issue) => {
      if (!issue || typeof issue !== 'object') return null;
      const m = (issue as ZodIssue).message;
      return typeof m === 'string' && m.length > 0 ? m : null;
    })
    .filter((m): m is string => m !== null);
  return messages.length > 0 ? messages.join('; ') : null;
}

function detailsToString(details: unknown): string | null {
  if (typeof details === 'string' && details.length > 0) return details;
  const fromIssues = joinZodIssues(details);
  if (fromIssues) return fromIssues;
  return null;
}

export function extractApiError(data: unknown, fallback: string): string {
  if (!data || typeof data !== 'object') return fallback;
  const body = data as { error?: unknown; details?: unknown; message?: unknown };

  // Top-level zod issues from raw zValidator result (rare but possible).
  const topLevelIssues = joinZodIssues((data as { issues?: unknown }).issues);

  const parts: string[] = [];

  if (typeof body.error === 'string' && body.error.length > 0) {
    parts.push(body.error);
  } else if (body.error && typeof body.error === 'object') {
    const fromError = joinZodIssues((body.error as { issues?: unknown }).issues);
    if (fromError) parts.push(fromError);
  }

  const fromDetails = detailsToString(body.details);
  if (fromDetails && !parts.includes(fromDetails)) parts.push(fromDetails);

  if (parts.length === 0 && topLevelIssues) parts.push(topLevelIssues);

  if (parts.length === 0 && typeof body.message === 'string' && body.message.length > 0) {
    parts.push(body.message);
  }

  // Some legacy endpoints (remote/proxy tunnel) emit `errorMessage` instead.
  if (parts.length === 0) {
    const errorMessage = (data as { errorMessage?: unknown }).errorMessage;
    if (typeof errorMessage === 'string' && errorMessage.length > 0) {
      parts.push(errorMessage);
    }
  }

  if (parts.length === 0 && data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    const tr = d.testResult as { message?: unknown } | undefined;
    if (tr && typeof tr === 'object' && typeof tr.message === 'string' && tr.message.trim()) {
      return tr.message;
    }
    if (d.success === false && typeof d.message === 'string' && d.message.trim()) {
      return d.message;
    }
  }

  return parts.length > 0 ? parts.join(': ') : fallback;
}

export function isApiFailure(data: unknown, httpStatus: number): boolean {
  if (httpStatus >= 400) return true;
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (d.success === false) return true;
    const tr = d.testResult as { success?: unknown } | undefined;
    if (tr && typeof tr === 'object' && tr.success === false) return true;
  }
  return false;
}
