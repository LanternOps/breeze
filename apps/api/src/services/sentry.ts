import * as Sentry from '@sentry/node';
import type { Context } from 'hono';
import { API_VERSION } from '../version';
import { pgErrorCode } from '../utils/pgErrors';
// TYPE-ONLY on purpose — erased at build time, so this adds no runtime import
// edge. See setConnectTimeoutClassifier below for why that matters.
import type { ConnectTimeoutDiagnosis } from './postgresConnectTimeout';
import {
  UNMATCHED_ROUTE_LABEL,
  safeMatchedRouteLabel,
} from './safeRequestLabel';
import {
  isRegisteredSentryEventCode,
  type SentryEventCode,
} from './sentryEventCodes';

// SQLSTATE 42501 (insufficient_privilege) is what forced row-level security
// raises when `breeze_app` writes a row that fails a policy's WITH CHECK clause
// (INSERT, or an UPDATE whose post-image violates the policy). Tagging it
// (rather than leaving it buried in the message) makes a spike of cross-tenant
// write denials filterable in Sentry — a breach attempt or an RLS regression.
//
// Scope note: this only catches WITH-CHECK *write* denials. RLS USING-clause
// denials on reads/updates/deletes silently *filter* rows (0 rows, no SQLSTATE)
// — that was the actual #1375 class (`users.last_login_at` froze) and it does
// NOT surface here. Those need their own guards (withSystemDbAccessContext +
// the contextless-write proxy guard from #1380); this tag is complementary.
const RLS_DENY_SQLSTATE = '42501';

let initialized = false;

/**
 * #3022 CONNECT_TIMEOUT classifier, injected at boot rather than imported.
 *
 * This module is imported by ~120 others, `db/index.ts` among them. A static
 * import back to the classifier therefore pulls it — and the event-loop monitor
 * behind it — into the module graph of everything that merely reports an error,
 * including the DB module itself. That measurably slowed module evaluation and
 * pushed `db/requestDatabasePool.test.ts` (a hard 15s budget on a dynamic
 * `import('./index')`) over its timeout. Inverting the dependency keeps
 * `services/sentry` a leaf, matching how the metrics recorders are wired
 * (`setBackupMetricsRecorder`, `setS1MetricsRecorder`, …).
 *
 * Unset means "not wired yet" — the tags are simply omitted, never guessed.
 */
type ConnectTimeoutClassifier = (err: unknown) => ConnectTimeoutDiagnosis | null;
let connectTimeoutClassifier: ConnectTimeoutClassifier | null = null;

export function setConnectTimeoutClassifier(classifier: ConnectTimeoutClassifier | null): void {
  connectTimeoutClassifier = classifier;
}

const ALLOWED_TAG_NAMES = new Set([
  'method',
  'route_template',
  'pg_code',
  'rls_deny',
  'user_id',
  'scope',
  'org_id',
  'partner_id',
  // BREEZE-X: a `dbWriteExpectingRows` 0-row warning is only triageable if the
  // call site (`cas_label`) and the state the row was already in
  // (`prior_status`) survive the scrubber. Both are enum-ish and bounded by
  // construction — `cas_label` is a hardcoded string literal at each call
  // site, `prior_status` comes from a closed status set folded with the
  // stale-command reaper's `timedOutBy` marker (services/commandCasDiagnostics.ts)
  // and falls back to a sentinel for anything unrecognised. Neither carries a
  // tenant, device, or command identifier.
  'prior_status',
  'cas_label',
  // #3022: a Postgres CONNECT_TIMEOUT is already tagged `pg_code:CONNECT_TIMEOUT`,
  // but that alone says nothing about WHY — the driver reports the identical
  // error whether the handshake failed or this process was simply never
  // scheduled to run the socket callbacks. These two split that bucket in
  // Sentry. Both are closed sets by construction (see ConnectTimeoutCause and
  // bucketEventLoopLag); neither carries a tenant, device, or host identifier.
  'connect_timeout_cause',
  'event_loop_lag_bucket',
  // #3759: the device cascade warns in two situations an operator must be able
  // to tell apart — it could not read the caller's prior `lock_timeout` back
  // (so the bound stays in force instead of being restored), or the parent row
  // lock matched no row (so the cascade ran under the old child-first ordering,
  // the exact race the lock exists to close). `scrubEvent` deletes `message`,
  // `logentry` and `extra` from every event, so without this the warning
  // arrives as a contentless, ungroupable blank. Closed two-value set, written
  // as string literals at both call sites; carries no tenant or device id.
  'device_deletion_warning',
  // #3214: the pool-health watchdog's verdict is the ONLY part of its report
  // that can survive to Sentry — `scrubEvent` deletes `message`, `logentry` and
  // `extra` from every event, so an unallowlisted verdict would arrive as a
  // contentless, ungroupable blank. It is also the field that decides the
  // operator's action: `pool-degraded` means restart the API, and
  // `database-unreachable` means explicitly do not. Closed 5-value set
  // (DB_POOL_HEALTH_VERDICTS plus the `check-failed` self-report); carries no
  // tenant, device, or host identifier.
  'db_pool_health_verdict',
  // #3517: the global body-limit gate's 413s carry the carve-out RULE that
  // matched and its configured byte ceiling. `body_limit_rule` is the closed
  // `BodyLimitRule` union (middleware/bodyLimit.ts) and `body_limit_max_size` is
  // a hardcoded constant from that same table — neither is caller-controlled,
  // and neither contains a raw request path, tenant, device or host identifier.
  // Without them the event arrives contentless: `scrubEvent` deletes `message`,
  // `logentry` and `extra`, so the rule label is the only thing that makes the
  // cluster groupable and actionable.
  'body_limit_rule',
  'body_limit_max_size',
  // BREEZE-18: the required `captureMessage` discriminator. `scrubEvent`
  // deletes `message`, `logentry` and `extra` from every event, so before this
  // existed any captureMessage that happened not to carry one of the tags above
  // shipped a completely EMPTY event — Sentry grouped 11,466 of them into one
  // untriageable issue, 95% of its recent events carrying zero tags at all.
  // Every entry above it is the same lesson relearned per incident; this one
  // closes the class. Bounded by construction: the value is a string literal
  // from the closed SENTRY_EVENT_CODES registry (services/sentryEventCodes.ts),
  // type-enforced by `tsc` and re-checked at runtime, so it can never carry a
  // tenant, device, host or path.
  'event_code',
  // #3836/D4: a refused official-manifest asset (binarySync) is reported as an
  // exception whose descriptive message the scrubber deletes, so the production
  // issue could not say WHICH asset was refused — and the INTENDED case
  // (unsigned darwin artifacts, pending signed macOS releases) was therefore
  // indistinguishable from a real trust regression. `binary_component` is the
  // hardcoded component name from the sync call sites ('agent', 'viewer', …);
  // `release_asset_name` is a RELEASE ARTIFACT filename — a build output name
  // like `breeze-agent-windows-amd64.exe`, bounded by the release matrix and
  // carrying no tenant, device, org or host identifier; `manifest_refusal_reason`
  // is a closed set derived from the thrown error's CLASS (never its message
  // text, which is unbounded and interpolates the offending values).
  'binary_component',
  'release_asset_name',
  'manifest_refusal_reason',
]);
const UNSAFE_TAG_CHARACTERS = /[/?#\r\n]/;
const SAFE_STRUCTURAL_NAME = /^[A-Za-z_$<][A-Za-z0-9_.$<>:[\] ]{0,127}$/;

function isBoundedTagValue(value: unknown): value is string | number | boolean {
  if (!['string', 'number', 'boolean'].includes(typeof value)) return false;
  const serialized = String(value);
  return serialized.length <= 128 && !UNSAFE_TAG_CHARACTERS.test(serialized);
}

function isSafeRouteTemplateTag(value: unknown): value is string {
  if (value === UNMATCHED_ROUTE_LABEL) return true;
  if (typeof value !== 'string') return false;
  const c = { req: { routePath: value } } as unknown as Context;
  return safeMatchedRouteLabel(c) === value;
}

function pickAllowedTags(
  tags: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> {
  const picked: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (!ALLOWED_TAG_NAMES.has(key)) continue;
    if (key === 'route_template') {
      if (isSafeRouteTemplateTag(value)) picked[key] = value;
      continue;
    }
    if (isBoundedTagValue(value)) picked[key] = value;
  }
  return picked;
}

function rebuildSafeFrame(frame: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  if (
    typeof frame.function === 'string' &&
    SAFE_STRUCTURAL_NAME.test(frame.function)
  ) {
    safe.function = frame.function;
  }
  if (
    typeof frame.module === 'string' &&
    SAFE_STRUCTURAL_NAME.test(frame.module)
  ) {
    safe.module = frame.module;
  }
  for (const numericKey of ['lineno', 'colno'] as const) {
    const value = frame[numericKey];
    if (Number.isSafeInteger(value) && Number(value) >= 0) {
      safe[numericKey] = value;
    }
  }
  if (typeof frame.in_app === 'boolean') safe.in_app = frame.in_app;
  return safe;
}

function rebuildSafeException(
  exception: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!Array.isArray(exception?.values)) return undefined;

  const values = exception.values.map((rawValue) => {
    const value =
      rawValue && typeof rawValue === 'object'
        ? rawValue as Record<string, unknown>
        : {};
    const type =
      typeof value.type === 'string' && SAFE_STRUCTURAL_NAME.test(value.type)
        ? value.type
        : 'Error';
    const rebuilt: Record<string, unknown> = { type, value: '[redacted]' };
    const stacktrace =
      value.stacktrace && typeof value.stacktrace === 'object'
        ? value.stacktrace as Record<string, unknown>
        : undefined;
    if (Array.isArray(stacktrace?.frames)) {
      rebuilt.stacktrace = {
        frames: stacktrace.frames.map((frame) =>
          rebuildSafeFrame(
            frame && typeof frame === 'object'
              ? frame as Record<string, unknown>
              : {},
          ),
        ),
      };
    }
    return rebuilt;
  });

  return { values };
}

function setCallerTags(
  scope: { setTag: (key: string, value: string | number | boolean) => unknown },
  tags: Record<string, string> | undefined,
): void {
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (
      ALLOWED_TAG_NAMES.has(key) &&
      key !== 'route_template' &&
      isBoundedTagValue(value)
    ) {
      scope.setTag(key, value);
    }
  }
}

/** Rebuild safe event surfaces before an event leaves the process. Exported for test. */
export function scrubEvent<T extends Record<string, any>>(event: T): T {
  const mutableEvent = event as Record<string, any>;
  mutableEvent.request =
    typeof mutableEvent.request?.method === 'string'
      ? { method: mutableEvent.request.method }
      : undefined;
  delete mutableEvent.transaction;
  delete mutableEvent.breadcrumbs;
  delete mutableEvent.contexts;
  mutableEvent.tags = pickAllowedTags(mutableEvent.tags);
  delete mutableEvent.message;
  delete mutableEvent.logentry;
  delete mutableEvent.extra;
  mutableEvent.exception = rebuildSafeException(mutableEvent.exception);
  mutableEvent.user =
    typeof mutableEvent.user?.id === 'string' &&
    isBoundedTagValue(mutableEvent.user.id)
      ? { id: mutableEvent.user.id }
      : undefined;
  return event;
}

/**
 * #3077: the same rebuild for TRANSACTION events, which `beforeSend` never sees.
 *
 * `@sentry/core` dispatches the two hooks by event type — `beforeSend` for error
 * events, `beforeSendTransaction` for transactions — so `scrubEvent` above ran on
 * exactly half the outbound traffic. Meanwhile `requestDataIntegration()` is a
 * default node integration whose `processEvent` fires on EVERY event type and
 * copies the request header bag verbatim into `event.request.headers`; the SDK's
 * own `SENSITIVE_KEY_SNIPPETS` deny list (which would have caught `x-api-key`)
 * is only applied on the span-attribute path, not to the event body. So a
 * sampled transaction on an api-key route shipped a live `brz_` credential with
 * no error involved at all — and `.env.example` ships
 * `SENTRY_TRACES_SAMPLE_RATE=0.1`, so sampling is on for anyone who copies it.
 *
 * This deliberately does NOT reuse `scrubEvent`: that one deletes `contexts`,
 * and a transaction event without `contexts.trace` is invalid — reusing it would
 * silently disable tracing rather than secure it. Instead `contexts` is narrowed
 * to `trace` alone, which is the field the event format requires and the only one
 * carrying no host or tenant detail (`nodeContextIntegration` fills the rest with
 * server metadata).
 *
 * `event.spans[].data` is left alone: those attributes already pass through the
 * SDK's `filterKeyValueData` + `SENSITIVE_KEY_SNIPPETS` in
 * `httpHeadersToSpanAttributes`, so header values arrive pre-redacted there.
 */
export function scrubTransactionEvent<T extends Record<string, any>>(event: T): T {
  const mutableEvent = event as Record<string, any>;
  // Same allowlist rebuild as scrubEvent: drops headers, url, query_string and
  // the request body in one move rather than denying known-bad header names.
  mutableEvent.request =
    typeof mutableEvent.request?.method === 'string'
      ? { method: mutableEvent.request.method }
      : undefined;
  delete mutableEvent.extra;
  delete mutableEvent.breadcrumbs;
  const trace = mutableEvent.contexts?.trace;
  mutableEvent.contexts = trace ? { trace } : undefined;
  mutableEvent.tags = pickAllowedTags(mutableEvent.tags);
  mutableEvent.user =
    typeof mutableEvent.user?.id === 'string' &&
    isBoundedTagValue(mutableEvent.user.id)
      ? { id: mutableEvent.user.id }
      : undefined;
  return event;
}

function parseSampleRate(raw: string | undefined): number {
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(parsed, 1));
}

export function initSentry(): void {
  if (initialized) {
    return;
  }

  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) {
    return;
  }

  const tracesSampleRate = parseSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE);

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    // Track the deployed version (API_VERSION <- APP_VERSION <- BREEZE_VERSION),
    // which is already correct on every deploy. The old SENTRY_RELEASE env was
    // hand-maintained and went stale on the droplets (pinned at 0.64.1 while the
    // fleet ran 0.69.0), mistagging every event — so we no longer read it.
    release: API_VERSION,
    tracesSampleRate,
    profilesSampleRate: parseSampleRate(process.env.SENTRY_PROFILES_SAMPLE_RATE),
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubTransactionEvent(event)
  });

  initialized = true;
}

export function isSentryEnabled(): boolean {
  return initialized;
}

export function captureException(
  err: unknown,
  c?: Context,
  tags?: Record<string, string>,
): void {
  // Classify BEFORE the init guard. The classifier is no longer only a tag
  // source: it also feeds the rolling CONNECT_TIMEOUT rate that the #3214
  // pool-health watchdog alerts on. Left below the guard, that counter was blind
  // on every instance without a DSN — the self-hosted default — because
  // `app.onError` was then its only feed, and every worker, scheduler,
  // unhandledRejection and agent-WS path contributed nothing. That is precisely
  // the profile of the original incident (see the note below: the loudest
  // signature was the patch scheduler, not any route), so a watchdog fed only by
  // the request path would have reported the pool healthy right through it.
  //
  // Guarded, because this now runs on instances where nothing else in this
  // function does: a classifier fault must cost two tags, never the report.
  let diagnosis: ConnectTimeoutDiagnosis | null = null;
  try {
    diagnosis = connectTimeoutClassifier?.(err) ?? null;
  } catch {
    // Classification is diagnostic only — never let it displace the report.
  }

  if (!initialized) {
    return;
  }

  Sentry.withScope((scope) => {
    setCallerTags(scope, tags);
    if (c) {
      scope.setTag('method', c.req.method);
      scope.setTag('route_template', safeMatchedRouteLabel(c));
    }

    // Surface the Postgres SQLSTATE (unwrapping Drizzle's `.cause` chain) as a
    // tag so DB errors are filterable. 42501 specifically flags an RLS WITH-CHECK
    // *write* denial (see RLS_DENY_SQLSTATE above for the scope caveat), so a
    // cross-tenant breach attempt — or a regression that strands an insert on
    // the bare `db` with no access context — shows up as a `rls_deny` spike
    // instead of an anonymous 500. Best-effort: tagging never throws
    // (pgErrorCode returns undefined rather than throwing for non-pg errors) and
    // missing/non-pg errors are simply left untagged.
    const sqlState = pgErrorCode(err);
    if (sqlState) {
      scope.setTag('pg_code', sqlState);
      if (sqlState === RLS_DENY_SQLSTATE) {
        scope.setTag('rls_deny', true);
      }
    }

    // #3022. Classified HERE rather than in the HTTP error handler because a
    // CONNECT_TIMEOUT is just as likely to surface from a BullMQ worker as from
    // a request — in the original incident the loudest signature in Sentry was
    // the patch scheduler, not any route. captureException is the one chokepoint
    // every path already goes through, so covering it here covers all of them.
    // The classification itself now happens above the `initialized` guard (see
    // there for why); this only applies its result.
    if (diagnosis) {
      scope.setTag('connect_timeout_cause', diagnosis.cause);
      scope.setTag('event_loop_lag_bucket', diagnosis.lagBucket);
    }

    Sentry.captureException(err);
  });
}

/**
 * Options bag for `captureMessage`.
 *
 * WHY AN OPTIONS OBJECT (BREEZE-18): `eventCode` had to become REQUIRED, which
 * changes the arity of every call however it is added, so there was no
 * "cheaper" positional variant to prefer. Given a free choice, the object wins
 * on the three things that outlive this change:
 *   - the required field sits adjacent to `message` and is self-labelling at
 *     the call site, instead of being an unlabelled literal in slot 2 or 5;
 *   - the four optional fields stop being order-dependent — a dozen call sites
 *     previously padded `undefined` into `extra` purely to reach `tags`;
 *   - the next optional knob (a `fingerprint`, a sampling hint) is added
 *     without touching a single existing caller.
 * `captureException` keeps its positional shape deliberately: it has no
 * required discriminator, and churning it would buy nothing.
 *
 * Prefer `tags` over `extra` for any low-cardinality discriminator you will
 * want to GROUP BY in Sentry: extras are only visible once you open an
 * individual event (and `scrubEvent` deletes them outright before send), while
 * tags are searchable and drive the "break down by" UI.
 *
 * Keep tag values low-cardinality (a handler name, not an id) — high-cardinality
 * tags inflate Sentry's index without making anything more triageable.
 */
export interface CaptureMessageOptions {
  /**
   * REQUIRED, and applied as the `event_code` tag by `captureMessage` itself
   * rather than threaded through `tags` — a caller cannot forget it, misspell
   * the tag name, or have it silently dropped by the allowlist. Must be a
   * hardcoded literal from SENTRY_EVENT_CODES; never interpolate an id.
   */
  eventCode: SentryEventCode;
  level?: 'info' | 'warning' | 'error';
  /** Deleted by `scrubEvent` before send; kept for local console parity only. */
  extra?: Record<string, unknown>;
  tags?: Record<string, string>;
}

export function captureMessage(message: string, options: CaptureMessageOptions): void {
  if (!initialized) {
    return;
  }

  const { eventCode, level = 'warning', extra, tags } = options;

  Sentry.withScope((scope) => {
    scope.setLevel(level);
    void extra;
    setCallerTags(scope, tags);
    // Set AFTER the caller's tags so a `tags: { event_code: ... }` bag can never
    // override the call site's own code, and guarded so an unregistered value
    // arriving from untyped JS degrades to a named sentinel rather than an
    // unbounded tag or (worse) the contentless event this exists to prevent.
    scope.setTag(
      'event_code',
      isRegisteredSentryEventCode(eventCode) ? eventCode : 'unregistered_event_code',
    );
    Sentry.captureMessage(message);
  });
}

/**
 * Attach the authenticated tenant/user to the active Sentry isolation scope
 * (#1379 B2). Every event captured later in the same scope — route throws,
 * contextless-write warnings, RLS-deny tags — inherits these, so triage on a
 * multi-tenant RMM stops being guesswork. Only non-secret identifiers are
 * tagged (no token, no password, no mfaSecret).
 *
 * IMPORTANT: these module-level setters write to whatever isolation scope is
 * currently active. Call this function only from INSIDE a
 * `withSentryRequestScope` callback so the writes are confined to that
 * request's scope rather than the global scope. Calling it at module level
 * or outside an isolation scope can mis-attribute tags across concurrent
 * requests.
 */
export function setSentryRequestContext(ctx: {
  userId: string;
  scope: 'system' | 'partner' | 'organization';
  orgId: string | null;
  partnerId: string | null;
}): void {
  if (!initialized) {
    return;
  }
  Sentry.setUser({ id: ctx.userId });
  Sentry.setTag('user_id', ctx.userId);
  Sentry.setTag('scope', ctx.scope);
  Sentry.setTag('org_id', ctx.orgId ?? 'none');
  Sentry.setTag('partner_id', ctx.partnerId ?? 'none');
}

/**
 * Run the rest of a request inside a dedicated Sentry isolation scope, tagged
 * with the tenant (#1379 B2). Using an EXPLICIT isolation scope (rather than
 * relying on httpIntegration to fork one per request) guarantees the tags set
 * by setSentryRequestContext stay confined to THIS request even under
 * concurrency — Sentry.init() installs the AsyncLocalStorage async-context
 * strategy that makes withIsolationScope request-local. Passthrough (no scope)
 * when Sentry is disabled.
 */
export function withSentryRequestScope<T>(
  ctx: {
    userId: string;
    scope: 'system' | 'partner' | 'organization';
    orgId: string | null;
    partnerId: string | null;
  },
  run: () => T
): T {
  if (!initialized) {
    return run();
  }
  return Sentry.withIsolationScope(() => {
    setSentryRequestContext(ctx);
    return run();
  });
}

export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) {
    return;
  }

  await Sentry.flush(timeoutMs);
}
