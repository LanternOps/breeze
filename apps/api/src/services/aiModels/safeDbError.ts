/**
 * The ONE scrubber for database errors on the AI model registry paths (#7600
 * W02): the /ai/provider facade (partnerLlmConfig.ts), the reconcile boot
 * sweep (legacyReconcile.ts) and the other registry writers that log a
 * database failure.
 *
 * A Drizzle query error's message and `params` (and a postgres.js error's
 * `query` / `parameters`) carry the statement's values — key ciphertext,
 * fingerprints, ids, model names — so they must never reach a log line, a
 * report or Sentry. What survives: the class, the SQLSTATE, the constraint and
 * the Postgres primary message — except for SQLSTATE class 22 (data
 * exception), whose primary message can quote the offending input value.
 *
 * Errors that carry no SQL keep their own message (and the caller keeps the
 * error itself), so a projection invariant or a TypeError stays diagnosable.
 */

/** The error and its cause chain, outermost first (bounded; cycle-safe). */
export function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current && typeof current === 'object' && chain.length < 8 && !chain.includes(current)) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

const QUERY_BEARING_KEYS = ['params', 'query', 'parameters'] as const;
/** DrizzleQueryError's message format: `Failed query: <sql>\nparams: <values>`. */
const DRIZZLE_QUERY_MESSAGE = /^Failed query:/;

/** True when the error (or anything it wraps) carries a statement's SQL or bound values. */
export function carriesQueryValues(error: unknown): boolean {
  return causeChain(error).some((e) => {
    const name = (e as { constructor?: { name?: unknown } }).constructor?.name;
    const message = (e as { message?: unknown }).message;
    return name === 'DrizzleQueryError' || name === 'PostgresError'
      || QUERY_BEARING_KEYS.some((k) => k in (e as object))
      || (typeof message === 'string' && DRIZZLE_QUERY_MESSAGE.test(message));
  });
}

export interface SafeDbErrorDetail {
  /** The outermost error's class name (or typeof for a non-Error). */
  kind: string;
  code: string | undefined;
  constraint: string | undefined;
  /** The Postgres primary message; undefined for SQLSTATE class 22. */
  primary: string | undefined;
}

/** The innermost error carrying a string `code` (the Postgres error), reduced to its safe fields. */
export function safeDbErrorDetail(error: unknown): SafeDbErrorDetail {
  const pg = [...causeChain(error)].reverse().find((e) => typeof (e as { code?: unknown }).code === 'string') as
    | { code: string; message?: unknown; constraint_name?: unknown }
    | undefined;
  const code = pg?.code;
  return {
    kind: error instanceof Error ? error.constructor.name : typeof error,
    code,
    constraint: typeof pg?.constraint_name === 'string' ? pg.constraint_name : undefined,
    primary: pg && typeof pg.message === 'string' && !code?.startsWith('22') ? pg.message : undefined,
  };
}

/** `SQLSTATE x, constraint, primary` (empty when nothing safe survives). */
export function formatSafeDbErrorDetail(detail: SafeDbErrorDetail): string {
  return [detail.code && `SQLSTATE ${detail.code}`, detail.constraint, detail.primary].filter(Boolean).join(', ');
}

/** The SQLSTATE anywhere in the chain (innermost wins), if any. */
export function errorSqlstate(error: unknown): string | undefined {
  return safeDbErrorDetail(error).code;
}

/**
 * A message safe to log or store: a query-bearing error becomes
 * `<Class> (SQLSTATE x, constraint, primary)`; anything else keeps its own
 * message (never its cause's).
 */
export function safeErrorMessage(error: unknown): string {
  if (carriesQueryValues(error)) {
    const detail = safeDbErrorDetail(error);
    const text = formatSafeDbErrorDetail(detail);
    return `${detail.kind}${text ? ` (${text})` : ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}
