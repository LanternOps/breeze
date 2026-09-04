import '@/lib/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bot, Check, CheckCheck, Layers, Loader2, Search, ShieldCheck, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  AI_AGENT_KINDS,
  APPROVAL_BATCH_MAX,
  type AiAgentGraduationDto,
  type AiAgentGraduationRowDto,
  type AiAgentKind,
} from '@breeze/shared';
import { useEventStream } from '@/hooks/useEventStream';
import {
  CeremonyError,
  decideIntentApproval,
  decideIntentApprovalBatch,
  isNoApproverDeviceError,
  isNotSoleApprover,
  isStepUpRequired,
  type BatchRowResult,
} from '@/lib/intentApprovals';
import { loginPathWithNext } from '@/lib/authScope';
import { navigateTo } from '@/lib/navigation';
import { ActionError, runAction } from '@/lib/runAction';
import { formatRelativeTime } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { badgeClass } from '../aiAgents/statusBadge';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { EmptyState } from '../shared/EmptyState';
import { PageHeader } from '../shared/PageHeader';
import { showToast } from '../shared/Toast';
import {
  buildOrgOptions,
  buildSections,
  clusterByOrg,
  groupHostnameSummary,
  isExpired,
  isGroupable,
  matchesSearch,
  sortRows,
  type ApprovalGroup,
  type PendingApproval,
  type RiskTier,
  type SortOrder,
} from './approvalGrouping';

const LIVE_REFETCH_DEBOUNCE_MS = 750;
/** WS is only a nudge; polling is the guarantee. useEventStream gives up
 *  permanently after repeated ticket failures, and these approvals are
 *  time-boxed — with no fallback they would arrive AND expire unseen. Same
 *  cadence as NotificationCenter's POLL_INTERVAL_MS. */
const POLL_INTERVAL_MS = 30_000;
/** First-page size for `GET /approvals/pending`. Matches the server's own
 *  default page granularity — see `pagination.loadMore` below. */
const PAGE_SIZE = 25;
/** Mirrors `PENDING_PAGE_MAX` in `routes/approvals.ts` — the largest `limit`
 *  the server will ever honour for `GET /approvals/pending`, regardless of
 *  what is requested. A full reload's own `limit` is capped here too (see
 *  `loadApprovals` below) so it never asks for more than the server would
 *  clamp it to anyway. */
const SERVER_PAGE_LIMIT_MAX = 50;
/** Countdown refresh cadence. Cards are minutes-long, so a 10s tick keeps
 *  "Expires in N min" (and the expired/disabled state) honest between the
 *  30s poll without re-rendering the whole list every second. */
const EXPIRY_TICK_MS = 10_000;
/** Caps concurrent `GET /ai/agents/graduation` fan-out: each org issues up to
 *  AI_AGENT_KINDS.length (3) requests, so a batch of 5 orgs tops out at 15
 *  concurrent requests regardless of how many distinct supervised orgs are on
 *  screen at once — see the graduation-queue comment near its refs. */
const ALWAYS_ALLOW_ORG_BATCH_SIZE = 5;
const APPROVAL_EVENTS = ['notification.created'];
const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

type DecisionErrorKind =
  | 'noApproverDevice'
  | 'notSoleApprover'
  | 'verificationFailed'
  | 'alreadyDecided'
  | 'expired'
  | 'decisionFailed'
  /** Issue #4459 — this row was one of the server's `offending` ids on a
   *  `batch_not_homogeneous` 422: it drifted out of the batchable set (someone
   *  else decided it, its intent settled, …). Per-row, not a group banner, so
   *  the rest of the group stays batchable — see `decideGroup`. */
  | 'driftedFromBatch';
/** Group headers add the two WHOLE-batch refusals, which are never per-row:
 *  nothing was decided, so they belong above the cards, not on one of them. */
type GroupErrorKind = DecisionErrorKind | 'batchStepUp' | 'batchNotHomogeneous' | 'batchTooLarge';

const riskClass: Record<RiskTier, string> = {
  low: 'bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-200',
  medium: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200',
  high: 'bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-200',
  critical: 'bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-200',
};

/**
 * P2-5 (#4192, Task 21) — "Approve and always allow". Eligibility for a
 * card's `${actionToolName}:${action}` comes from `GET
 * /ai/agents/graduation`, which is scoped to ONE `(orgId, kind)` pair. The
 * card carries neither field: `approvalScope`/`riskTier` are the intent's
 * OWN Tier-3 classification (`checkGuardrails` at create time), not the
 * originating agent's `kind` — an org can run up to three active agents at
 * once (`ai_agents_org_kind_uq`), one per `AiAgentKind`. So this reads all
 * three kinds per distinct org and merges the `eligible` rows into one Set,
 * remembering which kind produced each — the promote POST needs that kind
 * back. A kind with no active agent for the org 404s and is skipped; worst
 * case on a rare opKey collision across two kinds is a promotion raised
 * against the wrong kind, which `attemptPolicyDecision` re-validates at
 * RELEASE time and fails closed on — never a silent over-grant.
 */
interface OrgGraduationInfo {
  eligible: Map<string, AiAgentKind>;
  policyDecideEnabled: boolean;
}

/** The exact template the card's key is checked against — literal, not a
 *  re-derivation of the server's `canonicalPolicyKey`. `action` is null for a
 *  non-multiplexed tool, and such a card is never offered the affordance:
 *  every `POLICY_DECIDABLE_TIER3` entry is a `(tool, action)` pair. */
function alwaysAllowOpKey(approval: PendingApproval): string | null {
  return approval.action !== null ? `${approval.actionToolName}:${approval.action}` : null;
}

/** One org's worth of graduation state, across every `AiAgentKind` that has
 *  an active agent. Never throws — a failed or malformed response for one
 *  kind is skipped, because this affordance is additive and must never take
 *  the inbox (or even just Approve) down with it. */
async function fetchOrgGraduation(orgId: string): Promise<OrgGraduationInfo> {
  const eligible = new Map<string, AiAgentKind>();
  let policyDecideEnabled = false;
  await Promise.all(
    AI_AGENT_KINDS.map(async (kind) => {
      try {
        const res = await fetchWithAuth(
          `/ai/agents/graduation?orgId=${encodeURIComponent(orgId)}&kind=${encodeURIComponent(kind)}`,
        );
        // Most orgs run fewer than three kinds — a 404 here just means this
        // kind has no active agent, not a failure.
        if (!res.ok) return;
        const body = (await res.json()) as Partial<AiAgentGraduationDto> | null;
        if (!body || !Array.isArray(body.rows)) return;
        if (body.policyDecideEnabled === true) policyDecideEnabled = true;
        for (const row of body.rows as AiAgentGraduationRowDto[]) {
          if (row.state === 'eligible' && !eligible.has(row.opKey)) eligible.set(row.opKey, kind);
        }
      } catch {
        // Network failure for this one kind — additive feature, never surfaced.
      }
    }),
  );
  return { eligible, policyDecideEnabled };
}

/** Resolves what the always-allow button needs for one card, or null when it
 *  must not render. `riskTier !== 'critical'` mirrors `isGroupable`'s own
 *  exclusion just above: even if a future registry change ever marked a
 *  critical-risk key `eligible`, this affordance still must not offer to
 *  pre-authorize the highest-risk tier unattended. */
function alwaysAllowTargetFor(
  approval: PendingApproval,
  info: OrgGraduationInfo | undefined,
): { opKey: string; kind: AiAgentKind } | null {
  if (!info || !info.policyDecideEnabled) return null;
  if (approval.approvalScope !== 'supervised') return null;
  if (approval.riskTier === 'critical') return null;
  const opKey = alwaysAllowOpKey(approval);
  if (opKey === null) return null;
  const kind = info.eligible.get(opKey);
  return kind ? { opKey, kind } : null;
}

/**
 * Maps a decide failure to the inline error kind, or null when the caller must
 * redirect to login instead.
 *
 * 401 is NOT handled by the auth layer here: the decide helpers opt out of the
 * refresh-and-redirect (skipUnauthorizedRetry + treatUnauthorizedAsError), so
 * nobody else is redirecting. The decide route answers 401 for two very
 * different things (routes/approvals.ts): `assertion_failed` / `reauth_required`
 * are server-side WebAuthn PROOF rejections — surfaced inline exactly like a
 * client-side CeremonyError. Any other 401 is genuine session expiry.
 */
function classifyDecideError(err: unknown): DecisionErrorKind | null {
  if (isNoApproverDeviceError(err) || isStepUpRequired(err)) return 'noApproverDevice';
  if (isNotSoleApprover(err)) return 'notSoleApprover';
  if (err instanceof CeremonyError) return 'verificationFailed';
  if (err instanceof ActionError && err.status === 401) {
    const token = (err.body as { error?: unknown } | null | undefined)?.error;
    if (token === 'assertion_failed' || token === 'reauth_required') {
      return 'verificationFailed';
    }
    return null;
  }
  // An ActionError was already toasted by runAction, but the toast is transient
  // and the row is where the retry lives — so both kinds of failure also get an
  // inline message.
  return 'decisionFailed';
}

/** Per-row copy for one row of a partial batch result. The server reports these
 *  as bare machine tokens; without the mapping the approver sees the token. */
function rowErrorKind(result: BatchRowResult): DecisionErrorKind {
  const token = result.body?.error;
  if (token === 'step_up_required') return 'noApproverDevice';
  if (token === 'not_sole_approver') return 'notSoleApprover';
  if (token === 'assertion_failed' || token === 'reauth_required') {
    return 'verificationFailed';
  }
  // The two per-row races the batch core reports by STATUS rather than token:
  // somebody (or some other session) decided the card first, or it expired
  // while the set was being decided. Neither is retryable, so the generic
  // "The decision could not be submitted. Try again." is actively wrong — it
  // invites a retry that cannot succeed.
  if (result.httpStatus === 409) return 'alreadyDecided';
  if (result.httpStatus === 410) return 'expired';
  return 'decisionFailed';
}

export default function ApprovalsInbox() {
  const { t } = useTranslation('approvals');
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // A SET, not a scalar: one batch decision holds every card in the group, and
  // each of those rows must render (and disable) as busy.
  const [decidingIds, setDecidingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, DecisionErrorKind>>({});
  // Issue #4459 — mirrors `decidingIds`'s own "a set of row ids that's
  // currently true" idiom rather than deriving it from `rowErrors` inline on
  // every render (review finding: three independent passes flagged the
  // inline `Object.entries(rowErrors).filter(...)` derivation). Kept in sync
  // with `rowErrors`'s `driftedFromBatch` entries by every writer below —
  // `clearRowErrors` drops both together, and the `batch_not_homogeneous`
  // branch in `decideGroup` adds to both together.
  const [driftedIds, setDriftedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [groupErrors, setGroupErrors] = useState<Record<string, GroupErrorKind>>({});
  const [denyingId, setDenyingId] = useState<string | null>(null);
  const [denyReason, setDenyReason] = useState('');
  const [denyingGroupIdentity, setDenyingGroupIdentity] = useState<string | null>(null);
  const [groupDenyReason, setGroupDenyReason] = useState('');
  const liveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrors `approvals` so the silent-failure branch of loadApprovals (empty
  // deps) can see whether anything is currently on screen.
  const approvalsRef = useRef<PendingApproval[]>([]);
  // Always-allow: per-org graduation state, keyed by orgId. `requestedGraduationOrgsRef`
  // is the cache-for-the-component's-lifetime gate — an org is fetched at most
  // once, even across every silent poll refresh that follows.
  const [orgGraduation, setOrgGraduation] = useState<Map<string, OrgGraduationInfo>>(
    () => new Map(),
  );
  const requestedGraduationOrgsRef = useRef<Set<string>>(new Set());
  // Newly-discovered orgIds queue here and a single persistent worker drains
  // them ALWAYS_ALLOW_ORG_BATCH_SIZE at a time — this is what caps client fan-out
  // (a page with many distinct supervised orgs would otherwise fire
  // AI_AGENT_KINDS.length requests per org all at once) and, because the worker
  // is not tied to any one effect run's cleanup, a poll/WS-nudge re-render that
  // lands mid-fetch can never discard an in-flight org's result — the queue and
  // the "already requested" ref only ever grow.
  const graduationQueueRef = useRef<string[]>([]);
  const graduationWorkerActiveRef = useRef(false);
  const [alwaysAllowTarget, setAlwaysAllowTarget] = useState<{
    approval: PendingApproval;
    opKey: string;
    kind: AiAgentKind;
  } | null>(null);
  const [alwaysAllowBusy, setAlwaysAllowBusy] = useState(false);
  // Ticking clock for live expiry countdowns (critique #3): `expiryLabel`
  // reads THIS instead of a fresh `Date.now()` so a card's remaining time —
  // and whether it has flipped to expired — updates every EXPIRY_TICK_MS
  // regardless of when the 30s poll last landed.
  const [now, setNow] = useState(() => Date.now());
  // Paging (critique #2): the server supports a `cursor`-based next page and
  // an authoritative unpaginated count. `nextCursor` is only ever consumed by
  // `loadMore` below (never sent back to the server after a full reload).
  // A full reload (mount, poll, WS nudge, reconnect, post-decision) now
  // requests enough rows to cover whatever is already loaded (see
  // `loadApprovals`'s `refreshLimit`), so it no longer discards "Load more"
  // pages the way a flat PAGE_SIZE fetch used to.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  // Org filter, text search, and sort are ALL client-side over whatever
  // pages are currently loaded (`approvals`) — the server has no query
  // params for any of the three today, and adding a per-keystroke round
  // trip for a filter this cheap would be worse than the honesty cost of
  // "of N loaded" below. `orgFilter` stores `orgId ?? ''` (see
  // `buildOrgOptions`); '' means "All organizations".
  const [orgFilter, setOrgFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('expiringSoonest');

  const loadApprovals = useCallback(async (options?: { silent?: boolean; withCount?: boolean }) => {
    // Silent reloads (WS nudge, poll, reconnect, post-decision refresh) must
    // not flash the already-rendered list back to a spinner.
    const silent = options?.silent === true;
    // The count refresh is a SEPARATE request from the list fetch. Doubling
    // it onto every 30s poll tick would double the inbox's steady-state
    // request rate for no real gain (the "of M" total does not need to be
    // to-the-second fresh), so it defaults to firing only on a non-silent
    // load (mount, Retry) — callers that DO want it alongside a silent
    // reload (a decision was just made; the total just changed) pass
    // `withCount: true` explicitly. The poll/WS-nudge/reconnect paths do not.
    const withCount = options?.withCount ?? !silent;
    if (!silent) {
      setLoading(true);
      setLoadError(false);
    }
    try {
      // Every full reload (mount, poll, WS nudge, reconnect, post-decision)
      // used to hard-replace the list with a flat PAGE_SIZE fetch, silently
      // discarding every "Load more" page the user had already pulled in.
      // Request enough rows to cover what is currently on screen instead —
      // capped at the server's own page max, since asking for more just gets
      // clamped there too.
      const refreshLimit = Math.min(
        Math.max(PAGE_SIZE, approvalsRef.current.length),
        SERVER_PAGE_LIMIT_MAX,
      );
      const response = await fetchWithAuth(`/approvals/pending?limit=${refreshLimit}`);
      if (response.status === 401) {
        UNAUTHORIZED();
        return;
      }
      if (!response.ok) throw new Error('Unable to load approvals');
      const body = (await response.json()) as {
        approvals?: PendingApproval[];
        nextCursor?: string | null;
      };
      const rows = Array.isArray(body.approvals) ? body.approvals : [];
      if (approvalsRef.current.length > SERVER_PAGE_LIMIT_MAX) {
        // Rare case: more was already loaded (several "Load more" clicks)
        // than the server will ever return in one page, so `refreshLimit`
        // above was itself clamped and this fetch cannot possibly cover
        // everything on screen. A flat replace would still silently drop the
        // excess — merge by id instead, keeping whatever was already loaded
        // beyond this fresh page. `nextCursor` is deliberately left as-is:
        // this fetch's cursor only describes what comes after `rows`, and
        // the preserved tail already covers that range.
        const merged = [...rows, ...approvalsRef.current.filter((a) => !rows.some((r) => r.id === a.id))];
        approvalsRef.current = merged;
        setApprovals(merged);
      } else {
        approvalsRef.current = rows;
        setApprovals(rows);
        setNextCursor(typeof body.nextCursor === 'string' ? body.nextCursor : null);
      }
      setLoadMoreError(false);
      setLoadError(false);
    } catch {
      // A failed silent refresh keeps the list the user already has instead of
      // blanking it to the error card — unless there is nothing on screen, in
      // which case repeated failure must still surface.
      if (!silent || approvalsRef.current.length === 0) setLoadError(true);
    } finally {
      if (!silent) setLoading(false);
    }

    if (!withCount) return;
    // The total pending count is a light, best-effort companion read (same
    // live-authorized set `/pending` itself computes, unpaginated) — it must
    // never fail or delay the list load above; a failed/unexpected response
    // just leaves the "of M" total off the paging line.
    try {
      const countRes = await fetchWithAuth('/approvals/pending/count');
      if (countRes.ok) {
        const countBody = (await countRes.json()) as { count?: unknown };
        if (typeof countBody.count === 'number') setTotalCount(countBody.count);
      }
    } catch {
      // Additive.
    }
  }, []);

  /** Fetches the next PAGE_SIZE rows after the last-loaded row and appends
   *  them. A manual, per-view convenience: the next full reload (poll, WS
   *  nudge, a decision anywhere in the list) resets back to the first page,
   *  same as it always has — see the `nextCursor` state comment above. */
  const loadMore = useCallback(async () => {
    if (loadingMore || nextCursor === null) return;
    setLoadingMore(true);
    setLoadMoreError(false);
    try {
      const response = await fetchWithAuth(
        `/approvals/pending?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(nextCursor)}`,
      );
      if (response.status === 401) {
        UNAUTHORIZED();
        return;
      }
      if (!response.ok) throw new Error('Unable to load more approvals');
      const body = (await response.json()) as {
        approvals?: PendingApproval[];
        nextCursor?: string | null;
      };
      const newRows = Array.isArray(body.approvals) ? body.approvals : [];
      const existingIds = new Set(approvalsRef.current.map((a) => a.id));
      const merged = [...approvalsRef.current, ...newRows.filter((row) => !existingIds.has(row.id))];
      approvalsRef.current = merged;
      setApprovals(merged);
      setNextCursor(typeof body.nextCursor === 'string' ? body.nextCursor : null);
    } catch {
      setLoadMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, nextCursor]);

  const { connected, subscribe, unsubscribe } = useEventStream({
    onEvent: (event) => {
      if (event.type !== 'notification.created') return;
      // notification.created is content-free by contract. Debounce the nudge
      // and reload the authoritative approval rows from the API.
      if (liveDebounceRef.current) clearTimeout(liveDebounceRef.current);
      liveDebounceRef.current = setTimeout(() => {
        void loadApprovals({ silent: true });
      }, LIVE_REFETCH_DEBOUNCE_MS);
    },
  });

  useEffect(() => {
    void loadApprovals();
  }, [loadApprovals]);

  // Live expiry countdown (critique #3): ticks `now` so "Expires in N min"
  // and the expired/disabled card state stay honest between polls, instead
  // of only refreshing every POLL_INTERVAL_MS.
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), EXPIRY_TICK_MS);
    return () => window.clearInterval(interval);
  }, []);

  // Drains `graduationQueueRef` ALWAYS_ALLOW_ORG_BATCH_SIZE orgs at a time.
  // Deliberately NOT scoped to any one effect's cleanup: a poll refresh, a WS
  // nudge, or a post-decide silent reload each hand the eligibility effect
  // below a brand-new `approvals` array, and an effect-cleanup `cancelled`
  // flag tied to that array would discard any batch still in flight when the
  // next one lands — the org stays marked "requested" in
  // `requestedGraduationOrgsRef` forever with no entry ever written to
  // `orgGraduation`, silently killing the affordance for that org for the
  // component's lifetime. A persistent worker has no such cancellation point:
  // every batch it starts runs to completion and writes its result. A
  // setState after unmount is a no-op in React 18, so no unmount guard is
  // needed either.
  const drainGraduationQueue = useCallback(() => {
    if (graduationWorkerActiveRef.current) return;
    graduationWorkerActiveRef.current = true;
    void (async () => {
      while (graduationQueueRef.current.length > 0) {
        const batch = graduationQueueRef.current.splice(0, ALWAYS_ALLOW_ORG_BATCH_SIZE);
        const entries = await Promise.all(
          batch.map(async (orgId) => [orgId, await fetchOrgGraduation(orgId)] as const),
        );
        setOrgGraduation((current) => {
          const next = new Map(current);
          for (const [orgId, info] of entries) next.set(orgId, info);
          return next;
        });
      }
      graduationWorkerActiveRef.current = false;
    })();
  }, []);

  // Always-allow eligibility: one fetch per distinct org among supervised
  // cards, gated by `requestedGraduationOrgsRef` so a poll refresh (which
  // hands this effect a brand-new `approvals` array every 30s) never
  // re-requests an org already resolved this session. Newly-discovered orgIds
  // are enqueued (not fetched inline) so the concurrent fan-out stays capped
  // regardless of how many distinct orgs appear in one render.
  useEffect(() => {
    const newOrgIds: string[] = [];
    for (const approval of approvals) {
      if (
        approval.approvalScope === 'supervised' &&
        approval.orgId !== null &&
        !requestedGraduationOrgsRef.current.has(approval.orgId)
      ) {
        requestedGraduationOrgsRef.current.add(approval.orgId);
        newOrgIds.push(approval.orgId);
      }
    }
    if (newOrgIds.length === 0) return;
    graduationQueueRef.current.push(...newOrgIds);
    drainGraduationQueue();
  }, [approvals, drainGraduationQueue]);

  // Polling fallback: the WS layer can die permanently and silently
  // (useEventStream stops retrying after 5 ticket failures), and approvals
  // expire in minutes. The nudge makes the inbox fast; this makes it correct.
  useEffect(() => {
    const interval = window.setInterval(() => {
      void loadApprovals({ silent: true });
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [loadApprovals]);

  // Refetch on WS reconnect: anything that arrived during the outage produced
  // no nudge, so a fresh connection means our snapshot may be stale.
  const wasConnectedRef = useRef(connected);
  useEffect(() => {
    if (connected && !wasConnectedRef.current) {
      void loadApprovals({ silent: true });
    }
    wasConnectedRef.current = connected;
  }, [connected, loadApprovals]);

  useEffect(() => {
    subscribe(APPROVAL_EVENTS);
    return () => {
      unsubscribe(APPROVAL_EVENTS);
      if (liveDebounceRef.current) clearTimeout(liveDebounceRef.current);
    };
  }, [subscribe, unsubscribe]);

  const busy = decidingIds.size > 0;

  /** True only while THIS group's own batch is in flight — a single-card decide
   *  elsewhere still disables the buttons (via `busy`) without claiming the
   *  group is the thing being submitted. */
  const groupIsDeciding = (group: ApprovalGroup): boolean =>
    busy && group.members.every((member) => decidingIds.has(member.id));

  const setDecisionError = (id: string, kind: DecisionErrorKind) => {
    setRowErrors((current) => ({ ...current, [id]: kind }));
  };

  const setGroupError = (identity: string, kind: GroupErrorKind) => {
    setGroupErrors((current) => ({ ...current, [identity]: kind }));
  };

  const clearRowErrors = (ids: string[]) => {
    setRowErrors((current) => {
      const next = { ...current };
      for (const id of ids) delete next[id];
      return next;
    });
    // Issue #4459 — keeps `driftedIds` in sync with `rowErrors`: a drifted
    // card the approver decides individually (or that's swept into a fresh
    // `decideGroup` call) must rejoin ordinary grouping, same as before.
    setDriftedIds((current) => {
      if (ids.every((id) => !current.has(id))) return current;
      const next = new Set(current);
      for (const id of ids) next.delete(id);
      return next;
    });
  };

  /** Drops the rows the server actually decided. The per-row results ARE the
   *  authority here, so a refetch (what the single-card path does) would be
   *  both slower and less precise; the 30s poll reconciles anything else. */
  const removeApprovals = (ids: ReadonlySet<string>) => {
    const next = approvalsRef.current.filter((approval) => !ids.has(approval.id));
    approvalsRef.current = next;
    setApprovals(next);
  };

  /** Relative expiry for a row, evaluated against the ticking `now` state
   *  (critique #3) rather than a fresh `Date.now()` read — a card whose
   *  window closed since the last 30s poll shows as expired the moment the
   *  next EXPIRY_TICK_MS tick lands, not only once the poll catches up. */
  const expiryLabel = (expiresAt: string): string => {
    const remainingMs = new Date(expiresAt).getTime() - now;
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return t('expired');
    if (remainingMs < 60_000) return t('expiresSoon');
    return t('expiresIn', { minutes: Math.floor(remainingMs / 60_000) });
  };

  const openDenyForm = (id: string) => {
    if (busy) return;
    setDenyReason('');
    setDenyingGroupIdentity(null);
    setDenyingId((current) => (current === id ? null : id));
  };

  const openGroupDenyForm = (identity: string) => {
    if (busy) return;
    setGroupDenyReason('');
    setDenyingId(null);
    setDenyingGroupIdentity((current) => (current === identity ? null : identity));
  };

  const openAlwaysAllow = (approval: PendingApproval, opKey: string, kind: AiAgentKind) => {
    if (busy) return;
    setAlwaysAllowTarget({ approval, opKey, kind });
  };

  const decide = async (
    approval: PendingApproval,
    decision: 'approve' | 'deny',
    reason?: string,
  ) => {
    if (busy) return;
    // The button's own `disabled` attribute is driven by the ticking `now`
    // state, which can lag reality by up to EXPIRY_TICK_MS (10s) — a card
    // can still read enabled, or even "Expires in 1 min", for a few seconds
    // after it has actually expired. Re-checking against a FRESH
    // `Date.now()` here (not the stale `now` state) closes that click-time
    // race instead of letting it round-trip to the server only to 410.
    if (isExpired(approval.expiresAt, Date.now())) {
      setDecisionError(approval.id, 'expired');
      return;
    }

    setDecidingIds(new Set([approval.id]));
    clearRowErrors([approval.id]);

    try {
      const outcome =
        decision === 'approve'
          ? await decideIntentApproval(approval.id, 'approve')
          : await decideIntentApproval(approval.id, 'deny', reason?.trim() || undefined);
      if (outcome === 'needs_device') {
        setDecisionError(approval.id, 'noApproverDevice');
        return;
      }
      if (outcome === 'not_sole_approver') {
        setDecisionError(approval.id, 'notSoleApprover');
        return;
      }
      setDenyingId(null);
      // Critique #7: the row otherwise just vanishes with no confirmation
      // that anything happened. Approve only — a denial's own form already
      // stays open through the click, and the row disappearing IS the
      // confirmation there.
      if (decision === 'approve') {
        showToast({
          type: 'success',
          message: t('approveToast', {
            action: approval.actionLabel,
            org: approval.orgName ?? t('unknownOrganization'),
          }),
        });
      }
      await loadApprovals({ silent: true, withCount: true });
    } catch (err) {
      const kind = classifyDecideError(err);
      // Genuine session expiry — send the user to login the same way
      // loadApprovals does.
      if (kind === null) UNAUTHORIZED();
      else setDecisionError(approval.id, kind);
    } finally {
      setDecidingIds(new Set());
    }
  };

  /**
   * "Approve and always allow": approve the card the normal way FIRST, then
   * ask a second approver to pre-authorize the op key for future runs.
   * Graduation never retro-authorizes the card being decided right now — the
   * promote POST only raises a request; nothing is granted here.
   *
   * The approve and the promote are reported separately on failure: a failed
   * promote after a successful approve must say so explicitly (the card is
   * already decided) rather than read as "the whole action failed".
   */
  const confirmAlwaysAllow = async () => {
    const target = alwaysAllowTarget;
    if (!target || alwaysAllowBusy) return;

    setAlwaysAllowBusy(true);
    setDecidingIds(new Set([target.approval.id]));
    clearRowErrors([target.approval.id]);

    try {
      const outcome = await decideIntentApproval(target.approval.id, 'approve');
      if (outcome === 'needs_device') {
        setDecisionError(target.approval.id, 'noApproverDevice');
        return;
      }
      if (outcome === 'not_sole_approver') {
        setDecisionError(target.approval.id, 'notSoleApprover');
        return;
      }

      await loadApprovals({ silent: true, withCount: true });

      try {
        await runAction({
          // Inline thunk: the no-silent-mutations guard walks parents for an
          // enclosing runAction call, so a hoisted thunk reads as an
          // unwrapped mutation even when passed straight in.
          request: () =>
            fetchWithAuth('/ai/agents/graduation/promote', {
              method: 'POST',
              body: JSON.stringify({
                orgId: target.approval.orgId,
                kind: target.kind,
                opKey: target.opKey,
              }),
            }),
          successMessage: t('alwaysAllow.toasts.requested'),
          // The approve above already succeeded — this copy must say so,
          // not imply the whole action failed.
          errorFallback: t('alwaysAllow.errors.approvedPromoteFailed'),
          // A CATCH-ALL, not a lookup for one known token: `extractApiError`
          // prefers a server-supplied `error`/`message` string verbatim over
          // `errorFallback`, so without this every non-`policy_decide_disabled`
          // failure (a generic 500, a validation 400) would show the raw
          // server text instead of the "approved, but…" copy this affordance
          // exists to guarantee.
          friendly: (code) =>
            code === 'policy_decide_disabled'
              ? t('alwaysAllow.errors.policyDecideDisabled')
              : t('alwaysAllow.errors.approvedPromoteFailed'),
        });
      } catch {
        // Already toasted by runAction above with copy naming the approve as
        // having succeeded — nothing further to surface here.
      }
    } catch (err) {
      const kind = classifyDecideError(err);
      if (kind === null) UNAUTHORIZED();
      else setDecisionError(target.approval.id, kind);
    } finally {
      setAlwaysAllowBusy(false);
      setAlwaysAllowTarget(null);
      setDecidingIds(new Set());
    }
  };

  /**
   * Decide a whole group with ONE ceremony. The three whole-batch refusals
   * decide NOTHING, so every card stays on screen and the reason goes on the
   * header; a 200 can still carry per-row failures, and only the rows the
   * server actually decided are removed.
   */
  const decideGroup = async (
    group: ApprovalGroup,
    decision: 'approve' | 'deny',
    reason?: string,
  ) => {
    if (busy) return;
    const ids = group.members.map((member) => member.id);

    // Same click-time race as the single-card `decide` above, checked
    // against a fresh `Date.now()` rather than the ticking `now` state: any
    // member having expired since the last EXPIRY_TICK_MS tick refuses the
    // WHOLE batch client-side rather than letting the server 410 mid-batch.
    if (group.members.some((member) => isExpired(member.expiresAt, Date.now()))) {
      setGroupError(group.identity, 'expired');
      return;
    }

    // #4460: mirror the server's hard cap (`BATCH_MAX` in
    // services/approvals/batchDecide.ts, sourced from the same
    // `APPROVAL_BATCH_MAX` constant) client-side. Unreachable today at the
    // 25-row inbox page size, but the two limits are independent numbers —
    // this is what keeps a future page-size bump from silently outrunning
    // the batch cap and turning "Approve all" into a guaranteed 422 with no
    // WebAuthn ceremony even attempted.
    if (ids.length > APPROVAL_BATCH_MAX) {
      setGroupError(group.identity, 'batchTooLarge');
      return;
    }

    setDecidingIds(new Set(ids));
    clearRowErrors(ids);
    setGroupErrors((current) => {
      const next = { ...current };
      delete next[group.identity];
      return next;
    });

    try {
      const outcome = await decideIntentApprovalBatch(
        ids,
        decision,
        reason?.trim() || undefined,
      );
      if (outcome.outcome === 'needs_device') {
        setGroupError(group.identity, 'noApproverDevice');
        return;
      }
      if (outcome.outcome === 'batch_step_up') {
        setGroupError(group.identity, 'batchStepUp');
        return;
      }
      if (outcome.outcome === 'batch_not_homogeneous') {
        // Issue #4459: use the server's `offending` ids to deselect just
        // those cards — mark each with a per-row error (excludes it from
        // grouping on the next render, via `buildSections`'s `driftedIds`)
        // instead of banner-ing and freezing the WHOLE group, including the
        // members that are still perfectly batchable. Only fall back to the
        // old whole-group banner when the server didn't name any offending
        // ids (defensive — should not happen after the `offending` plumbing
        // fix in `authenticator.ts`/`intentApprovals.ts`).
        if (outcome.offending.length > 0) {
          setRowErrors((current) => {
            const next = { ...current };
            for (const id of outcome.offending) next[id] = 'driftedFromBatch';
            return next;
          });
          setDriftedIds((current) => {
            const next = new Set(current);
            for (const id of outcome.offending) next.add(id);
            return next;
          });
        } else {
          setGroupError(group.identity, 'batchNotHomogeneous');
        }
        return;
      }
      // Defense-in-depth only: the client-side APPROVAL_BATCH_MAX check above
      // refuses an oversized group before this call is ever made, so the
      // server only answers `batch_too_large` on a stale bundle or a group
      // that grew between render and submit.
      if (outcome.outcome === 'batch_too_large') {
        setGroupError(group.identity, 'batchTooLarge');
        return;
      }

      const decided = new Set<string>();
      const failures: Record<string, DecisionErrorKind> = {};
      const reported = new Set<string>();
      for (const result of outcome.results) {
        reported.add(result.id);
        if (result.httpStatus < 300) decided.add(result.id);
        else failures[result.id] = rowErrorKind(result);
      }
      // An id the server never reported on is NOT quietly assumed decided —
      // that would drop a still-pending card off the approver's inbox.
      for (const id of ids) {
        if (!reported.has(id)) failures[id] = 'decisionFailed';
      }

      setDenyingGroupIdentity(null);
      if (Object.keys(failures).length > 0) {
        setRowErrors((current) => ({ ...current, ...failures }));
      }
      if (decided.size > 0) removeApprovals(decided);
    } catch (err) {
      const kind = classifyDecideError(err);
      if (kind === null) UNAUTHORIZED();
      else setGroupError(group.identity, kind);
    } finally {
      setDecidingIds(new Set());
    }
  };

  /** One approval card. Extracted so a grouped section and a standalone row
   *  render the exact same card — a group must never quietly get a different
   *  affordance from the card it collects. */
  const renderRow = (approval: PendingApproval) => {
    const isDeciding = decidingIds.has(approval.id);
    const rowError = rowErrors[approval.id];
    const alwaysAllow = alwaysAllowTargetFor(
      approval,
      approval.orgId !== null ? orgGraduation.get(approval.orgId) : undefined,
    );
    // Critique #3: a card whose window closed since the last poll must read
    // (and act) as expired the moment the ticking clock notices, not only
    // once the next poll removes it.
    const expired = isExpired(approval.expiresAt, now);
    const actionsDisabled = busy || expired;
    return (
      <article
        key={approval.id}
        className={`border-b px-5 py-5 last:border-b-0 ${expired ? 'opacity-60' : ''}`}
        data-testid={`approval-row-${approval.id}`}
      >
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0 flex-1">
            {/* Critique #1: the org name is the first line of every card —
                two orgs' identically-named actions must never look alike. */}
            <p
              className="text-xs font-medium text-muted-foreground"
              data-testid={`approval-org-${approval.id}`}
            >
              {approval.orgName ?? t('unknownOrganization')}
            </p>
            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-foreground">
                {approval.actionLabel}
              </h2>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-semibold ${riskClass[approval.riskTier]}`}
              >
                {t(/* i18n-dynamic */ `risk.${approval.riskTier}`)}
              </span>
              {expired && (
                <span className={badgeClass('muted')} data-testid={`approval-expired-badge-${approval.id}`}>
                  {t('expired')}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {approval.origin === 'ai_agent' ? (
                <>
                  {/* Purple Bot badge matches NotificationCenter's `ai` typeConfig. */}
                  <span
                    className="mr-1.5 inline-flex items-center rounded-full bg-purple-100 px-1.5 py-0.5 align-middle text-purple-700 dark:bg-purple-900/40 dark:text-purple-200"
                    data-testid={`approval-agent-badge-${approval.id}`}
                  >
                    <Bot className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                  {t('proposedByAgent', {
                    agent: approval.agentName ?? approval.requestingClientLabel,
                  })}
                </>
              ) : (
                t('requestedBy', { client: approval.requestingClientLabel })
              )}
              <span aria-hidden="true"> &middot; </span>
              {formatRelativeTime(new Date(approval.createdAt))}
              <span aria-hidden="true"> &middot; </span>
              <span data-testid={`approval-expiry-${approval.id}`}>
                {expiryLabel(approval.expiresAt)}
              </span>
            </p>
            {approval.targetDevice && (
              // Under a group header every card names the same tool and
              // action, so the hostname is the ONLY thing that tells the
              // approver which machine each row is about.
              <p
                className="mt-1 text-sm text-muted-foreground"
                data-testid={`approval-target-device-${approval.id}`}
              >
                {t('targetDevice', { hostname: approval.targetDevice.hostname })}
              </p>
            )}
            {approval.riskSummary && (
              <p className="mt-3 max-w-3xl text-sm text-foreground/80">
                {approval.riskSummary}
              </p>
            )}
            {denyingId === approval.id && (
              <div
                className="mt-4 rounded-lg border bg-muted/40 p-3"
                data-testid={`approval-deny-form-${approval.id}`}
              >
                <label
                  className="text-sm font-medium"
                  htmlFor={`approval-deny-reason-${approval.id}`}
                >
                  {t('denyPrompt')}
                </label>
                <textarea
                  id={`approval-deny-reason-${approval.id}`}
                  className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
                  rows={2}
                  // Mirrors the server's z.string().max(500): without a
                  // client cap the 400 surfaces as generic copy and the
                  // typed reason's rejection is opaque.
                  maxLength={500}
                  value={denyReason}
                  placeholder={t('denyReasonPlaceholder')}
                  onChange={(event) => setDenyReason(event.target.value)}
                  data-testid={`approval-deny-reason-${approval.id}`}
                />
                <p
                  className="mt-1 text-right text-xs text-muted-foreground"
                  data-testid={`approval-deny-reason-count-${approval.id}`}
                >
                  {t('charCount', { count: denyReason.length, max: 500 })}
                </p>
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setDenyingId(null)}
                    disabled={isDeciding}
                    className="inline-flex h-9 items-center rounded-lg border px-3 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    data-testid={`approval-deny-cancel-${approval.id}`}
                  >
                    {t('cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void decide(approval, 'deny', denyReason)}
                    disabled={isDeciding}
                    className="inline-flex h-9 items-center gap-2 rounded-lg bg-destructive px-3 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
                    data-testid={`approval-deny-confirm-${approval.id}`}
                  >
                    {isDeciding && (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    )}
                    {isDeciding ? t('deciding') : t('confirmDeny')}
                  </button>
                </div>
              </div>
            )}
            {rowError && (
              <div
                className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
                data-testid={`approval-error-${approval.id}`}
                role="alert"
              >
                {t(/* i18n-dynamic */ `errors.${rowError}`)}
                {rowError === 'noApproverDevice' && (
                  <>
                    {' '}
                    <a className="font-medium underline underline-offset-4" href="/settings/profile">
                      {t('registerDevice')}
                    </a>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2 md:pt-0.5">
            <button
              type="button"
              onClick={() => openDenyForm(approval.id)}
              disabled={actionsDisabled}
              aria-expanded={denyingId === approval.id}
              className="inline-flex h-10 items-center gap-2 rounded-lg border px-4 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              data-testid={`approval-deny-${approval.id}`}
            >
              <X className="h-4 w-4" aria-hidden="true" />
              {t('deny')}
            </button>
            <button
              type="button"
              onClick={() => void decide(approval, 'approve')}
              disabled={actionsDisabled}
              // emerald-600 + white text is only ~3.8:1 (fails AA); emerald-700
              // clears 4.5:1 in both themes (this button carries no dark:
              // override — it is a solid fill, unaffected by page theme).
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-emerald-700 px-4 text-sm font-medium text-white transition-colors hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid={`approval-approve-${approval.id}`}
            >
              {isDeciding ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Check className="h-4 w-4" aria-hidden="true" />
              )}
              {isDeciding ? t('deciding') : t('approve')}
            </button>
            {alwaysAllow && (
              <button
                type="button"
                onClick={() => openAlwaysAllow(approval, alwaysAllow.opKey, alwaysAllow.kind)}
                disabled={actionsDisabled}
                className="inline-flex h-10 items-center gap-2 rounded-lg border border-emerald-600 px-3 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
                data-testid={`approval-always-allow-${approval.id}`}
              >
                <CheckCheck className="h-4 w-4" aria-hidden="true" />
                {t('alwaysAllow.button')}
              </button>
            )}
          </div>
        </div>
      </article>
    );
  };

  // Filter → sort → cluster, in that order (see `sortRows`'s own comment for
  // why sort must run before `clusterByOrg`, not after). All three stages
  // are client-side over `approvals` alone — whatever pages happen to be
  // loaded right now — never a fresh fetch, hence the honest "of N loaded"
  // copy on `filterSummary` below rather than reusing the server-authoritative
  // `pagination.showing` copy.
  const orgOptions = buildOrgOptions(approvals, t('unknownOrganization'));
  const hasActiveFilters = orgFilter !== '' || searchQuery.trim() !== '';
  const filteredApprovals = approvals
    .filter((approval) => orgFilter === '' || (approval.orgId ?? '') === orgFilter)
    .filter((approval) => matchesSearch(approval, searchQuery.trim()));
  const visibleSections = buildSections(
    clusterByOrg(sortRows(filteredApprovals, sortOrder)),
    driftedIds,
  );
  const clearFilters = () => {
    setOrgFilter('');
    setSearchQuery('');
  };

  return (
    <div className="space-y-6" data-testid="approvals-inbox">
      <PageHeader
        testId="approvals-page-header"
        icon={<ShieldCheck className="h-5 w-5" aria-hidden="true" />}
        title={t('title')}
        description={t('description')}
      />

      {!loading && !loadError && approvals.length > 0 && (
        <div
          className="flex flex-col gap-3 rounded-xl border bg-card px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"
          data-testid="approvals-filters"
        >
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="approvals-filter-org">
              {t('filters.orgLabel')}
            </label>
            <select
              id="approvals-filter-org"
              value={orgFilter}
              onChange={(event) => setOrgFilter(event.target.value)}
              className="h-9 rounded-lg border bg-background px-2 text-sm"
              data-testid="approvals-filter-org"
            >
              <option value="">{t('filters.allOrganizations', { count: approvals.length })}</option>
              {orgOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {t('filters.orgOption', { name: option.name, count: option.count })}
                </option>
              ))}
            </select>

            <label className="sr-only" htmlFor="approvals-filter-search">
              {t('filters.searchLabel')}
            </label>
            <div className="relative flex-1 sm:max-w-xs">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <input
                id="approvals-filter-search"
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t('filters.searchPlaceholder')}
                className="h-9 w-full rounded-lg border bg-background pl-8 pr-3 text-sm"
                data-testid="approvals-filter-search"
              />
            </div>

            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="text-sm font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
                data-testid="approvals-clear-filters"
              >
                {t('filters.clearFilters')}
              </button>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <div
              className="flex items-center gap-1 rounded-md border p-1"
              role="group"
              aria-label={t('filters.sortLabel')}
            >
              {(['expiringSoonest', 'newest'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setSortOrder(value)}
                  aria-pressed={sortOrder === value}
                  className={`rounded px-2.5 py-1 text-sm ${
                    sortOrder === value
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                  data-testid={`approvals-sort-${value === 'expiringSoonest' ? 'expiring' : 'newest'}`}
                >
                  {value === 'expiringSoonest' ? t('filters.sortExpiringSoonest') : t('filters.sortNewest')}
                </button>
              ))}
            </div>
          </div>

          {hasActiveFilters && (
            <p
              className="w-full text-xs text-muted-foreground sm:w-auto"
              data-testid="approvals-filter-summary"
            >
              {t('filters.showingLoaded', {
                shown: filteredApprovals.length,
                loaded: approvals.length,
              })}
            </p>
          )}
        </div>
      )}

      {loading ? (
        <div
          className="rounded-xl border bg-card px-5 py-10 text-center"
          data-testid="approvals-loading"
        >
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">{t('loading')}</p>
        </div>
      ) : loadError ? (
        <div
          className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-5 py-4 text-destructive"
          data-testid="approvals-error"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('loadError')}</p>
            <button
              type="button"
              className="text-sm font-medium underline underline-offset-4"
              onClick={() => void loadApprovals()}
            >
              {t('retry')}
            </button>
          </div>
        </div>
      ) : approvals.length === 0 ? (
        <EmptyState
          testId="approvals-empty"
          icon={<ShieldCheck className="h-7 w-7" />}
          title={t('empty.title')}
          description={t('empty.description')}
          headingLevel={2}
        />
      ) : filteredApprovals.length === 0 ? (
        // Every currently-loaded row was filtered out — distinct from the
        // true empty inbox above, and it must not read as one: nothing
        // vanished, the filters are just narrower than what's on screen.
        <EmptyState
          testId="approvals-filtered-empty"
          icon={<Search className="h-7 w-7" />}
          title={t('filters.noMatches.title')}
          description={t('filters.noMatches.description')}
          action={
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex h-10 items-center rounded-lg border px-4 text-sm font-medium transition-colors hover:bg-muted"
              data-testid="approvals-filtered-empty-clear"
            >
              {t('filters.clearFilters')}
            </button>
          }
          headingLevel={2}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          {visibleSections.map((section) =>
            section.kind === 'row' ? (
              renderRow(section.approval)
            ) : (
              <section
                key={`group-${section.group.identity}`}
                className="border-b last:border-b-0"
                data-testid={`approval-group-${section.group.testKey}`}
              >
                <div className="flex flex-col gap-3 border-b bg-muted/40 px-5 py-3 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0">
                    {/* Critique #1: same disambiguation as the card — a group
                        header is the ONE place two different orgs' identical
                        (tool, action) pairs could otherwise look alike. */}
                    <p
                      className="text-xs font-medium text-muted-foreground"
                      data-testid={`approval-group-org-${section.group.testKey}`}
                    >
                      {section.group.members[0]?.orgName ?? t('unknownOrganization')}
                    </p>
                    <p className="mt-0.5 flex min-w-0 items-center gap-2 text-sm font-semibold">
                      <Layers className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="truncate">
                        {t('batch.groupTitle', {
                          count: section.group.members.length,
                          tool: section.group.tool,
                        })}
                      </span>
                    </p>
                    {(() => {
                      // Finding #2: "Approve all (N)" never named the
                      // machines it covers — the approver had to open every
                      // card to find out. This lists them right on the
                      // header instead.
                      const hostnameSummary = groupHostnameSummary(section.group.members);
                      if (!hostnameSummary) return null;
                      return (
                        <p
                          className="mt-1 line-clamp-2 text-xs text-muted-foreground"
                          data-testid={`approval-group-hostnames-${section.group.testKey}`}
                        >
                          {hostnameSummary.shown.join(', ')}
                          {hostnameSummary.more > 0 &&
                            ` ${t('batch.moreHostnames', { count: hostnameSummary.more })}`}
                        </p>
                      );
                    })()}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openGroupDenyForm(section.group.identity)}
                      disabled={busy}
                      aria-expanded={denyingGroupIdentity === section.group.identity}
                      className="inline-flex h-9 items-center gap-2 rounded-lg border bg-background px-3 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                      data-testid={`approval-group-decline-${section.group.testKey}`}
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                      {t('batch.declineAll', { count: section.group.members.length })}
                    </button>
                    <button
                      type="button"
                      onClick={() => void decideGroup(section.group, 'approve')}
                      disabled={busy}
                      // See the single-card Approve button above: emerald-600 +
                      // white fails AA (~3.8:1); emerald-700 clears 4.5:1.
                      className="inline-flex h-9 items-center gap-2 rounded-lg bg-emerald-700 px-3 text-sm font-medium text-white transition-colors hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
                      data-testid={`approval-group-approve-${section.group.testKey}`}
                    >
                      {groupIsDeciding(section.group) ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <Check className="h-4 w-4" aria-hidden="true" />
                      )}
                      {t('batch.approveAll', { count: section.group.members.length })}
                    </button>
                  </div>
                </div>

                {denyingGroupIdentity === section.group.identity && (
                  <div
                    className="border-b bg-muted/20 px-5 py-3"
                    data-testid={`approval-group-deny-form-${section.group.testKey}`}
                  >
                    {/* The batch's own confirm step: restates the count and
                        the org involved (a group is always one org — that's
                        part of its own batchability key) so the confirm
                        button isn't the first place scope is named. */}
                    <p
                      className="text-sm text-muted-foreground"
                      data-testid={`approval-group-deny-summary-${section.group.testKey}`}
                    >
                      {t('batch.denyConfirmSummary', {
                        count: section.group.members.length,
                        org: section.group.members[0]?.orgName ?? t('unknownOrganization'),
                      })}
                    </p>
                    <label
                      className="mt-2 block text-sm font-medium"
                      htmlFor={`approval-group-deny-reason-${section.group.testKey}`}
                    >
                      {t('denyPrompt')}
                    </label>
                    <textarea
                      id={`approval-group-deny-reason-${section.group.testKey}`}
                      className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
                      rows={2}
                      maxLength={500}
                      value={groupDenyReason}
                      placeholder={t('denyReasonPlaceholder')}
                      onChange={(event) => setGroupDenyReason(event.target.value)}
                      data-testid={`approval-group-deny-reason-${section.group.testKey}`}
                    />
                    <p
                      className="mt-1 text-right text-xs text-muted-foreground"
                      data-testid={`approval-group-deny-reason-count-${section.group.testKey}`}
                    >
                      {t('charCount', { count: groupDenyReason.length, max: 500 })}
                    </p>
                    <div className="mt-2 flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setDenyingGroupIdentity(null)}
                        disabled={busy}
                        className="inline-flex h-9 items-center rounded-lg border px-3 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                        data-testid={`approval-group-deny-cancel-${section.group.testKey}`}
                      >
                        {t('cancel')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void decideGroup(section.group, 'deny', groupDenyReason)}
                        disabled={busy}
                        className="inline-flex h-9 items-center gap-2 rounded-lg bg-destructive px-3 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
                        data-testid={`approval-group-deny-confirm-${section.group.testKey}`}
                      >
                        {groupIsDeciding(section.group) && (
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        )}
                        {groupIsDeciding(section.group) ? t('deciding') : t('confirmDeny')}
                      </button>
                    </div>
                  </div>
                )}

                {groupErrors[section.group.identity] && (
                  <div
                    className="border-b bg-destructive/10 px-5 py-2 text-sm text-destructive"
                    data-testid={`approval-group-error-${section.group.testKey}`}
                    role="alert"
                  >
                    {t(/* i18n-dynamic */ `errors.${groupErrors[section.group.identity]}`)}
                    {groupErrors[section.group.identity] === 'noApproverDevice' && (
                      <>
                        {' '}
                        <a className="font-medium underline underline-offset-4" href="/settings/profile">
                          {t('registerDevice')}
                        </a>
                      </>
                    )}
                  </div>
                )}

                {section.group.members.map(renderRow)}
              </section>
            ),
          )}
        </div>
      )}

      {/* Critique #2: the server caps a single page at 50 and offers no total
          on its own — without this line an approver has no way to tell "that's
          everything" from "there's more you can't see". */}
      {!loading && !loadError && approvals.length > 0 && (
        <div
          className="flex flex-col items-center gap-2 text-sm text-muted-foreground sm:flex-row sm:justify-between"
          data-testid="approvals-pagination"
        >
          <span>
            {totalCount !== null
              ? t('pagination.showing', { shown: approvals.length, total: totalCount })
              : t('pagination.showingCount', { shown: approvals.length })}
          </span>
          {nextCursor !== null && (
            <div className="flex items-center gap-2">
              {loadMoreError && (
                <span className="text-destructive" role="alert">
                  {t('pagination.loadMoreError')}
                </span>
              )}
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="approvals-load-more"
              >
                {loadingMore && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {t('pagination.loadMore')}
              </button>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={alwaysAllowTarget !== null}
        onClose={() => setAlwaysAllowTarget(null)}
        onConfirm={() => void confirmAlwaysAllow()}
        variant="warning"
        isLoading={alwaysAllowBusy}
        title={t('alwaysAllow.confirm.title')}
        message={t('alwaysAllow.confirm.message', { opKey: alwaysAllowTarget?.opKey ?? '' })}
        confirmLabel={t('alwaysAllow.confirm.action')}
        confirmTestId={
          alwaysAllowTarget ? `approval-always-allow-confirm-${alwaysAllowTarget.approval.id}` : undefined
        }
      />
    </div>
  );
}
