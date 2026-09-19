// Phase 2 wave P2-5 (#4192) — the graduation panel.
//
// Reads `GET /ai/agents/graduation` and renders two tables:
//
//   1. GRADUATION — one row per `(op_key)` the graduation state machine is
//      tracking for this org's effective agent, with the evidence counters the
//      eligibility decision is actually made from and, for a row that is not
//      eligible, the localized reason it is not.
//   2. ACT-OP RELIABILITY — the same counters for act-mode manifest operations
//      (dot keys, e.g. `devices.restart`). These are read-only FOREVER: a dot
//      key is not a `tool:action` policy key, so it can never be promoted into
//      `supervisedActionKeys`. The caption says so rather than leaving an
//      operator to wonder why no row here ever grows a Promote button.
//
// The panel is deliberately USEFUL WITH THE FLAG OFF. When
// `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` is dark the API still serves every
// figure (a read is an observation, never a write — see the route's docstring),
// so the whole panel renders read-only with an explanatory note instead of
// disappearing. Promotion is the only thing the flag gates, and the promote
// route answers 409 `policy_decide_disabled` even if a stale render offered the
// button — that 409 is mapped to a sentence, never toasted as a raw token.
//
// Promotion NEVER retro-authorizes anything. The button raises a Tier-3
// four-eyes action intent that a SECOND human must approve, and the grant it
// eventually writes applies to FUTURE runs only. Both the confirm dialog and
// the success toast say that in words — an operator who reads "approved" as
// "the thing I am looking at is now allowed" is the misunderstanding this copy
// exists to prevent.
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import {
  AI_AGENT_GRADUATION_BY_ORG_LIMIT,
  type AiAgentActOpReliabilityDto,
  type AiAgentGraduationByOrgDto,
  type AiAgentGraduationDto,
  type AiAgentGraduationRowDto,
  type AiAgentKind,
} from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { EmptyState } from '../shared/EmptyState';
import { badgeClass, graduationTone } from '../aiAgents/statusBadge';
import { handleActionError, runAction } from '@/lib/runAction';
import { loginPathWithNext } from '@/lib/authScope';
import { navigateTo } from '@/lib/navigation';
import { formatDateTime } from '@/lib/dateTimeFormat';

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

/** `reason` is free text an operator types and the route stores on its audit
 *  row; the schema caps it at 500 (`revokeSupervisedKeyRequestSchema`). */
const REVOKE_REASON_MAX = 500;

/**
 * `POST /ai/agents/graduation/revoke`'s refusal tokens → operator-facing
 * sentences. The route answers `{ error: <token> }` with no `code` field, so
 * runAction's `friendly` hook is called with the token in `error` — the same
 * shape AiAgentSchedulesSection's SCHEDULE_ERROR_COPY handles. Every one of
 * them means "nothing was revoked", so the copy has to distinguish "it was
 * already off" from "we could not tell which grant you meant".
 */
const REVOKE_ERROR_COPY: Record<string, ((t: (key: string) => string) => string) | undefined> = {
  no_promoted_grant: (t) => t('aiAgentsPage.graduation.errors.noPromotedGrant'),
  already_demoted: (t) => t('aiAgentsPage.graduation.errors.alreadyDemoted'),
  already_revoked: (t) => t('aiAgentsPage.graduation.errors.alreadyRevoked'),
  ambiguous_op_key: (t) => t('aiAgentsPage.graduation.errors.ambiguousOpKey'),
};

interface Props {
  /** The org whose evidence to read; null asks for the partner-wide grouping. */
  orgId: string | null;
  kind: AiAgentKind;
  /** Whether this session may read the partner axis at all (an org token
   *  carries a partnerId but never passes `breeze_has_partner_access`, so the
   *  no-`orgId` form 400s for it — ask for an org instead of firing it). */
  isPartnerScope: boolean;
}

/** One org's worth of the response, whichever form the route answered in. */
interface GraduationGroup {
  /** null for the single-org read — see `scopedTestId` for why that matters. */
  orgId: string | null;
  orgName: string | null;
  rows: AiAgentGraduationRowDto[];
  actOpReliability: AiAgentActOpReliabilityDto[];
}

type Loaded = {
  groups: GraduationGroup[];
  /**
   * A valid denominator ONLY in the single-org read, where the route resolved
   * exactly one org's merged policy. In the byOrg read the route documents it
   * as informational — "the first resolved org's merged value, or the shared
   * default" (`routes/aiAgents.ts`) — while every row's `state` and
   * `blockedReason` already applied that row's OWN org's merged threshold. So
   * rendering it as each row's denominator prints "22 of 20" beside a
   * `tracking` / `below_threshold` row for any org whose threshold is higher,
   * contradicting the one thing this panel exists to explain. `byOrg` gates it.
   */
  promoteThreshold: number;
  /** True for the partner fan-out read (`byOrg`), false for a single org. */
  byOrg: boolean;
  policyDecideEnabled: boolean;
  byOrgTruncated: boolean;
};

function isByOrg(payload: unknown): payload is AiAgentGraduationByOrgDto {
  return typeof payload === 'object' && payload !== null && Array.isArray((payload as { byOrg?: unknown }).byOrg);
}

function isSingleOrg(payload: unknown): payload is AiAgentGraduationDto {
  if (typeof payload !== 'object' || payload === null) return false;
  const dto = payload as { rows?: unknown; actOpReliability?: unknown };
  return Array.isArray(dto.rows) && Array.isArray(dto.actOpReliability);
}

/** Never rendered — a body reaching this is a wire-contract break, and the
 *  panel's own error state is what an operator should see. */
class UnrecognizedGraduationBody extends Error {}

/**
 * A `data-testid` must be unique in the document, and the byOrg grouping
 * renders the SAME `op_key` once per organization — so the byOrg rows carry
 * their org id and the single-org rows keep the bare key the plan specifies
 * (`ai-agent-graduation-row-<opKey>`), which is also what the E2E/live smoke
 * looks for.
 */
function scopedTestId(group: GraduationGroup, opKey: string): string {
  return group.orgId === null ? opKey : `${group.orgId}-${opKey}`;
}

/**
 * The two response shapes share no discriminator field, so they are told apart
 * by the arrays each one carries — and a body that is NEITHER is rejected here
 * rather than destructured on faith. This panel is embedded in the agent
 * policy form, so an unexpected body must degrade to this panel's own error
 * state, never take the surrounding form down with it.
 */
function normalize(payload: unknown): Loaded {
  if (isByOrg(payload)) {
    return {
      groups: payload.byOrg.map((entry) => ({
        orgId: entry.orgId,
        orgName: entry.orgName,
        rows: Array.isArray(entry.rows) ? entry.rows : [],
        actOpReliability: Array.isArray(entry.actOpReliability) ? entry.actOpReliability : [],
      })),
      promoteThreshold: payload.promoteThreshold,
      byOrg: true,
      policyDecideEnabled: payload.policyDecideEnabled,
      byOrgTruncated: payload.byOrgTruncated === true,
    };
  }
  if (isSingleOrg(payload)) {
    return {
      groups: [{ orgId: null, orgName: null, rows: payload.rows, actOpReliability: payload.actOpReliability }],
      promoteThreshold: payload.promoteThreshold,
      byOrg: false,
      policyDecideEnabled: payload.policyDecideEnabled,
      byOrgTruncated: false,
    };
  }
  throw new UnrecognizedGraduationBody('GET /ai/agents/graduation returned an unrecognized body');
}

export default function AiAgentGraduationPanel({ orgId, kind, isPartnerScope }: Props) {
  const { t } = useTranslation('settings');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A 404 here is not a load FAILURE — `resolveEffectiveAgentSystem` resolves
  // null by design when no partner-wide baseline agent of this kind exists
  // yet, and an org override can never self-enable one. Retrying can never
  // succeed until a baseline is created, so this gets its own explanatory
  // empty state instead of the generic error + a dead-on-arrival retry button.
  const [noBaseline, setNoBaseline] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [pending, setPending] = useState<{ orgId: string; opKey: string } | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [requested, setRequested] = useState(false);
  // Revoke is the operator-facing mirror of promote and carries the same
  // confirm ceremony — with a reason field, because unlike promote there is
  // no four-eyes approval to record WHY. The route puts it on the audit row.
  const [pendingRevoke, setPendingRevoke] = useState<{ orgId: string; opKey: string } | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [revoking, setRevoking] = useState(false);

  // An org-scoped session with no org selected has nothing to ask for: the
  // no-`orgId` form is partner-only and would 400. Say so rather than
  // rendering an error the operator cannot act on.
  const canRead = orgId !== null || isPartnerScope;

  useEffect(() => {
    if (!canRead) {
      setLoaded(null);
      setError(null);
      setNoBaseline(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNoBaseline(false);
    void (async () => {
      try {
        const query = orgId === null
          ? `?kind=${encodeURIComponent(kind)}`
          : `?orgId=${encodeURIComponent(orgId)}&kind=${encodeURIComponent(kind)}`;
        const response = await fetchWithAuth(`/ai/agents/graduation${query}`);
        if (response.status === 404) {
          if (!cancelled) {
            setLoaded(null);
            setNoBaseline(true);
          }
          return;
        }
        if (!response.ok) throw new Error(`GET /ai/agents/graduation ${response.status}`);
        const body: unknown = await response.json();
        if (!cancelled) setLoaded(normalize(body));
      } catch (err) {
        console.error('[AiAgentGraduationPanel] could not load graduation state', err);
        // An empty panel and a failed read must never look the same — the whole
        // point of this surface is that "no evidence" is a finding.
        if (!cancelled) {
          setLoaded(null);
          setError(t('aiAgentsPage.graduation.error'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canRead, kind, orgId, reloadToken, t]);

  const promote = useCallback(async () => {
    if (!pending || promoting) return;
    const target = pending;
    setPromoting(true);
    try {
      await runAction({
        // Inline thunk: the no-silent-mutations guard is a lexical AST check,
        // so a hoisted request function reads as an unwrapped mutation (#2429).
        request: () => fetchWithAuth('/ai/agents/graduation/promote', {
          method: 'POST',
          body: JSON.stringify({ orgId: target.orgId, kind, opKey: target.opKey }),
        }),
        successMessage: t('aiAgentsPage.graduation.toasts.requested'),
        errorFallback: t('aiAgentsPage.graduation.errors.promote'),
        friendly: (code) =>
          code === 'policy_decide_disabled'
            ? t('aiAgentsPage.graduation.errors.policyDecideDisabled')
            : undefined,
        onUnauthorized: UNAUTHORIZED,
      });
      setRequested(true);
    } catch (err) {
      // The row deliberately survives a failure: nothing was granted, so the
      // evidence that made it eligible is still true and still promotable.
      handleActionError(err, t('aiAgentsPage.graduation.errors.promote'));
    } finally {
      setPromoting(false);
      setPending(null);
    }
  }, [kind, pending, promoting, t]);

  /**
   * Hands a promoted key back to the approval queue. Sends `kind` even though
   * the field is optional: without it the route 409s `ambiguous_op_key` as
   * soon as two agents in the org hold the same colon key, and this panel is
   * ALWAYS rendered for one specific kind — the rows on screen belong to that
   * kind's effective agent, so guessing is never necessary.
   *
   * `reason` is omitted rather than sent empty: the route records `null` for
   * "the operator supplied none", and an empty string is not that.
   */
  const revoke = useCallback(async () => {
    if (!pendingRevoke || revoking) return;
    const target = pendingRevoke;
    const reason = revokeReason.trim();
    setRevoking(true);
    let revoked = false;
    try {
      await runAction({
        // Inline thunk: the no-silent-mutations guard is a lexical AST check,
        // so a hoisted request function reads as an unwrapped mutation (#2429).
        request: () => fetchWithAuth('/ai/agents/graduation/revoke', {
          method: 'POST',
          body: JSON.stringify({
            orgId: target.orgId,
            opKey: target.opKey,
            kind,
            ...(reason === '' ? {} : { reason }),
          }),
        }),
        successMessage: t('aiAgentsPage.graduation.toasts.revoked'),
        errorFallback: t('aiAgentsPage.graduation.errors.revoke'),
        friendly: (code) => REVOKE_ERROR_COPY[code]?.(t),
        onUnauthorized: UNAUTHORIZED,
      });
      revoked = true;
    } catch (err) {
      // The row survives a failure on purpose: every refusal means nothing
      // was revoked, so the grant is still live and still revocable.
      handleActionError(err, t('aiAgentsPage.graduation.errors.revoke'));
    } finally {
      setRevoking(false);
      setPendingRevoke(null);
      setRevokeReason('');
    }
    // Outside the try: the reload re-reads the ledger so the row's state pill
    // and its new demotion cause come from the server, never from an
    // optimistic guess about what the executor wrote.
    if (revoked) setReloadToken((token) => token + 1);
  }, [kind, pendingRevoke, revokeReason, revoking, t]);

  /** Machine token → sentence. `operator` is the one with no evidence behind
   *  it (a human used the revoke route); the rest are the automatic
   *  disqualifying signals in `supervisedKeyDemote.ts`. An unrecognized value
   *  falls through to the raw token rather than rendering a key path. */
  const demoteReasonLabel = useCallback(
    (reason: string): string => {
      switch (reason) {
        case 'attempted_failure':
          return t('aiAgentsPage.graduation.demoteReasons.attempted_failure');
        case 'recurrence':
          return t('aiAgentsPage.graduation.demoteReasons.recurrence');
        case 'operator':
          return t('aiAgentsPage.graduation.demoteReasons.operator');
        default:
          return reason;
      }
    },
    [t],
  );

  const blockedLabel = useCallback(
    (row: AiAgentGraduationRowDto) =>
      row.blockedReason === null
        ? '—'
        : t(/* i18n-dynamic */ `aiAgentsPage.graduation.blockedReasons.${row.blockedReason}`),
    [t],
  );

  const cell = 'px-3 py-2';
  const numeric = `${cell} tabular-nums`;

  return (
    <section
      className="space-y-3 rounded-md border p-3 md:col-span-2"
      data-testid="ai-agent-graduation-panel"
    >
      <div>
        {/* Same weight as the form's other real heading (Permissions), not a
            12px uppercase label — this panel is a peer section, not a caption. */}
        <h3 className="text-sm font-semibold">
          {t('aiAgentsPage.graduation.title')}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">{t('aiAgentsPage.graduation.description')}</p>
      </div>

      {!canRead && (
        <p className="text-sm text-muted-foreground" data-testid="ai-agent-graduation-org-required">
          {t('aiAgentsPage.graduation.orgRequired')}
        </p>
      )}

      {loading && (
        <p className="text-sm text-muted-foreground" data-testid="ai-agent-graduation-loading">
          {t('aiAgentsPage.graduation.loading')}
        </p>
      )}

      {!loading && noBaseline && (
        <EmptyState
          size="sm"
          headingLevel={4}
          testId="ai-agent-graduation-no-baseline"
          title={t('aiAgentsPage.graduation.noBaselineTitle')}
          description={t('aiAgentsPage.graduation.noBaseline')}
        />
      )}

      {!loading && !noBaseline && error && (
        <div data-testid="ai-agent-graduation-error" className="space-y-2">
          <p className="text-sm text-destructive">{error}</p>
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm font-medium"
            onClick={() => setReloadToken((token) => token + 1)}
            data-testid="ai-agent-graduation-retry"
          >
            {t('aiAgentsPage.graduation.retry')}
          </button>
        </div>
      )}

      {!loading && !error && loaded && (
        <>
          {!loaded.policyDecideEnabled && (
            <p
              className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
              data-testid="ai-agent-graduation-readonly-note"
            >
              {t('aiAgentsPage.graduation.readOnlyNote')}
            </p>
          )}

          {/* The byOrg view drops the denominator because each organization
              resolves its own threshold; say where the number can be seen
              rather than leaving a bare count with no target. */}
          {loaded.byOrg && loaded.groups.some((group) => group.rows.length > 0) && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="ai-agent-graduation-threshold-per-org-note"
            >
              {t('aiAgentsPage.graduation.thresholdPerOrgNote')}
            </p>
          )}

          {loaded.byOrgTruncated && (
            <p className="text-xs text-muted-foreground" data-testid="ai-agent-graduation-by-org-truncated">
              {t('aiAgentsPage.graduation.byOrgTruncated', { limit: AI_AGENT_GRADUATION_BY_ORG_LIMIT })}
            </p>
          )}

          {requested && (
            <p className="text-xs" data-testid="ai-agent-graduation-approvals-note">
              <a className="underline" href="/approvals" data-testid="ai-agent-graduation-approvals-link">
                {t('aiAgentsPage.graduation.approvalsLink')}
              </a>
            </p>
          )}

          {/* A partner whose accessible orgs all lack an active agent for this
              kind gets no groups at all — the route omits them rather than
              reporting them empty. */}
          {loaded.groups.length === 0 && (
            <EmptyState
              size="sm"
              headingLevel={4}
              testId="ai-agent-graduation-empty"
              title={t('aiAgentsPage.graduation.emptyTitle')}
              description={t('aiAgentsPage.graduation.empty')}
            />
          )}

          {loaded.groups.map((group) => (
            <div
              key={group.orgId ?? 'self'}
              className="space-y-3"
              data-testid={group.orgId === null ? 'ai-agent-graduation-group' : `ai-agent-graduation-org-${group.orgId}`}
            >
              {group.orgName !== null && (
                <p className="text-sm font-semibold">{group.orgName}</p>
              )}

              {group.rows.length === 0 && group.actOpReliability.length === 0 && (
                <EmptyState
                  size="sm"
                  headingLevel={4}
                  testId={
                    group.orgId === null
                      ? 'ai-agent-graduation-empty'
                      : `ai-agent-graduation-empty-${group.orgId}`
                  }
                  title={t('aiAgentsPage.graduation.emptyTitle')}
                  description={t('aiAgentsPage.graduation.empty')}
                />
              )}

              {group.rows.length > 0 && (
                <div className="overflow-x-auto rounded-md border">
                  <table className="min-w-full divide-y text-sm">
                    <thead className="bg-muted/20">
                      <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        <th className={cell}>{t('aiAgentsPage.graduation.columns.opKey')}</th>
                        <th className={cell}>{t('aiAgentsPage.graduation.columns.state')}</th>
                        <th className={cell}>{t('aiAgentsPage.graduation.columns.verified')}</th>
                        <th className={cell}>{t('aiAgentsPage.graduation.columns.failed')}</th>
                        <th className={cell}>{t('aiAgentsPage.graduation.columns.recurred')}</th>
                        <th className={cell}>{t('aiAgentsPage.graduation.columns.firstVerified')}</th>
                        <th className={cell}>{t('aiAgentsPage.graduation.columns.blockedReason')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {group.rows.map((row) => {
                        // Single-org read: the group carries no org id, so the
                        // promote body takes the panel's own. byOrg read: it
                        // MUST take the group's, never the (null) prop — the
                        // grant is written against the row's organization.
                        const promoteOrgId = group.orgId ?? orgId;
                        return (
                        <tr
                          key={row.opKey}
                          data-testid={`ai-agent-graduation-row-${scopedTestId(group, row.opKey)}`}
                        >
                          <td className={`${cell} font-medium`}>{row.opKey}</td>
                          <td className={cell}>
                            <span className={badgeClass(graduationTone(row.state), { size: 'sm' })}>
                              {t(/* i18n-dynamic */ `aiAgentsPage.graduation.states.${row.state}`)}
                            </span>
                          </td>
                          <td className={numeric}>
                            {/* Denominator only where it is this row's own
                                threshold — see `Loaded.promoteThreshold`. */}
                            {loaded.byOrg
                              ? row.window.verified
                              : t('aiAgentsPage.graduation.verifiedOfThreshold', {
                                  verified: row.window.verified,
                                  threshold: loaded.promoteThreshold,
                                })}
                          </td>
                          <td className={numeric}>{row.window.failed}</td>
                          <td className={numeric}>{row.window.recurred}</td>
                          <td className={cell}>
                            {row.window.firstVerifiedAt === null
                              ? '—'
                              : formatDateTime(row.window.firstVerifiedAt)}
                          </td>
                          <td className={cell}>
                            <span className="flex flex-wrap items-center gap-2">
                              <span>{blockedLabel(row)}</span>
                              {row.state === 'eligible' && loaded.policyDecideEnabled && promoteOrgId !== null && (
                                <button
                                  type="button"
                                  className="rounded-md border px-2 py-1 text-xs font-medium"
                                  onClick={() => setPending({ orgId: promoteOrgId, opKey: row.opKey })}
                                  data-testid={`ai-agent-graduation-promote-${scopedTestId(group, row.opKey)}`}
                                >
                                  {t('aiAgentsPage.graduation.promote')}
                                </button>
                              )}
                              {/* Not gated on `policyDecideEnabled`: the route
                                  deliberately is not either, because turning
                                  the flag off must stop new grants without
                                  stranding a live one an operator wants
                                  stopped. */}
                              {row.state === 'promoted' && promoteOrgId !== null && (
                                <button
                                  type="button"
                                  className="rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive"
                                  onClick={() => {
                                    setRevokeReason('');
                                    setPendingRevoke({ orgId: promoteOrgId, opKey: row.opKey });
                                  }}
                                  data-testid={`ai-agent-graduation-revoke-${scopedTestId(group, row.opKey)}`}
                                >
                                  {t('aiAgentsPage.graduation.revoke')}
                                </button>
                              )}
                            </span>
                            {/* A `demoted` pill with nothing beside it says a
                                grant was taken away and refuses to say why.
                                Both fields are optional on the DTO, so each is
                                rendered only when the ledger actually carries
                                it — there is no `demotedBy` column at all; the
                                accountable human is on the audit row. */}
                            {(row.demotedAt !== null || row.demoteReason !== null) && (
                              <span
                                className="mt-1 block text-xs text-muted-foreground"
                                data-testid={`ai-agent-graduation-demoted-${scopedTestId(group, row.opKey)}`}
                              >
                                {row.demotedAt !== null && (
                                  <span className="block">
                                    {t('aiAgentsPage.graduation.demotedAt', {
                                      at: formatDateTime(row.demotedAt),
                                    })}
                                  </span>
                                )}
                                {row.demoteReason !== null && (
                                  <span className="block">
                                    {t('aiAgentsPage.graduation.demotedReason', {
                                      reason: demoteReasonLabel(row.demoteReason),
                                    })}
                                  </span>
                                )}
                              </span>
                            )}
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {group.actOpReliability.length > 0 && (
                <div className="overflow-x-auto rounded-md border">
                  <table className="min-w-full divide-y text-sm">
                    <caption className="px-3 py-2 text-left text-xs text-muted-foreground">
                      {t('aiAgentsPage.graduation.reliability.caption')}
                    </caption>
                    <thead className="bg-muted/20">
                      <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        <th className={cell}>{t('aiAgentsPage.graduation.columns.opKey')}</th>
                        <th className={cell}>{t('aiAgentsPage.graduation.columns.executed')}</th>
                        <th className={cell}>{t('aiAgentsPage.graduation.columns.verified')}</th>
                        <th className={cell}>{t('aiAgentsPage.graduation.columns.failed')}</th>
                        <th className={cell}>{t('aiAgentsPage.graduation.columns.recurred')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {group.actOpReliability.map((entry) => (
                        <tr
                          key={entry.opKey}
                          data-testid={`ai-agent-act-reliability-row-${scopedTestId(group, entry.opKey)}`}
                        >
                          <td className={`${cell} font-medium`}>{entry.opKey}</td>
                          <td className={numeric}>{entry.executed}</td>
                          <td className={numeric}>{entry.verified}</td>
                          <td className={numeric}>{entry.failed}</td>
                          <td className={numeric}>{entry.recurred}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </>
      )}

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => void promote()}
        variant="warning"
        isLoading={promoting}
        title={t('aiAgentsPage.graduation.confirm.title')}
        message={t('aiAgentsPage.graduation.confirm.message', { opKey: pending?.opKey ?? '' })}
        confirmLabel={t('aiAgentsPage.graduation.confirm.action')}
        confirmTestId="ai-agent-graduation-promote-confirm"
      />

      <ConfirmDialog
        open={pendingRevoke !== null}
        onClose={() => {
          setPendingRevoke(null);
          setRevokeReason('');
        }}
        onConfirm={() => void revoke()}
        variant="destructive"
        isLoading={revoking}
        title={t('aiAgentsPage.graduation.revokeConfirm.title')}
        message={t('aiAgentsPage.graduation.revokeConfirm.message', { opKey: pendingRevoke?.opKey ?? '' })}
        confirmLabel={t('aiAgentsPage.graduation.revokeConfirm.action')}
        confirmTestId="ai-agent-graduation-revoke-confirm"
      >
        <label className="block space-y-1 text-left text-sm">
          <span className="font-medium">{t('aiAgentsPage.graduation.revokeConfirm.reasonLabel')}</span>
          <textarea
            className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            rows={3}
            maxLength={REVOKE_REASON_MAX}
            value={revokeReason}
            onChange={(e) => setRevokeReason(e.target.value)}
            data-testid="ai-agent-graduation-revoke-reason"
          />
          <span className="block text-xs text-muted-foreground">
            {t('aiAgentsPage.graduation.revokeConfirm.reasonHint')}
          </span>
          <span className="block text-xs text-muted-foreground" data-testid="ai-agent-graduation-revoke-reason-count">
            {t('aiAgentsPage.fields.charactersLeft', { count: REVOKE_REASON_MAX - revokeReason.length })}
          </span>
        </label>
      </ConfirmDialog>
    </section>
  );
}
