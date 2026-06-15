import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Flag, FlagOff, Loader2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { Dialog } from '../shared/Dialog';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { runAction, handleActionError } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';

/**
 * AI for Office — client-session audit viewer (spec §9.3). excel_client
 * sessions only (the API constrains this — Plan-4 Task 3). Transcript shows
 * redaction badges derived from redactionCounts (decision 3: counted
 * [REDACTED:type] markers, since ai_messages stores the redacted form),
 * workbook-context chips from tool inputs, and the tool approval trail from
 * ai_tool_executions. Flag/unflag mirror the technician machinery with
 * client_ai.* audit actions.
 */

const PAGE_SIZE = 50;

/** Row shape of GET /client-ai/admin/sessions (Plan-4 Task 3). */
interface SessionListRow {
  id: string;
  orgId: string;
  orgName: string | null;
  clientUserId: string | null;
  userEmail: string | null;
  title: string | null;
  startedAt: string;
  lastActivityAt: string | null;
  turnCount: number;
  totalCostCents: number;
  flaggedAt: string | null;
  flagReason: string | null;
  status: string;
}

interface TranscriptMessage {
  id: string;
  role: string;
  content: string | null;
  contentBlocks: unknown;
  toolName: string | null;
  toolInput: unknown;
  toolOutput: unknown;
  createdAt: string;
  /** Derived per message by the API: [REDACTED:type] marker counts. */
  redactionCounts: Record<string, number>;
}

interface ToolExecution {
  id: string;
  toolName: string;
  toolInput: unknown;
  status: string;
  approvedBy: string | null;
  approvedAt: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: string;
  completedAt: string | null;
}

interface SessionDetailSession {
  id: string;
  orgId: string;
  orgName: string | null;
  clientUserId: string | null;
  userEmail: string | null;
  title: string | null;
  model: string;
  status: string;
  turnCount: number;
  totalCostCents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  flaggedAt: string | null;
  flaggedBy: string | null;
  flagReason: string | null;
  createdAt: string;
  lastActivityAt: string | null;
}

interface SessionDetail {
  session: SessionDetailSession;
  messages: TranscriptMessage[];
  toolExecutions: ToolExecution[];
}

const formatCost = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const formatTime = (iso: string) => new Date(iso).toLocaleString();

/** Workbook-context chips (spec §9.3): tool name + range/sheet from toolInput. */
function workbookChips(m: TranscriptMessage): string[] {
  const chips: string[] = [];
  if (m.toolName) chips.push(m.toolName);
  const input = m.toolInput as Record<string, unknown> | null;
  if (input && typeof input.range === 'string') chips.push(input.range);
  if (input && typeof input.sheet === 'string') chips.push(`Sheet: ${input.sheet}`);
  return chips;
}

function ToolStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    completed:
      'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400',
    approved:
      'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-400',
    pending:
      'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400',
    rejected:
      'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400',
    failed:
      'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400',
  };
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-xs ${styles[status] ?? 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-500/30 dark:bg-slate-500/10 dark:text-slate-400'}`}
    >
      {status}
    </span>
  );
}

export default function SessionsTab() {
  // Filters
  const [orgs, setOrgs] = useState<{ orgId: string; orgName: string }[]>([]);
  const [orgUsers, setOrgUsers] = useState<{ id: string; email: string }[]>([]);
  const [orgFilter, setOrgFilter] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  // List
  const [rows, setRows] = useState<SessionListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // Detail drawer
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // Flag/unflag
  const [flagOpen, setFlagOpen] = useState(false);
  const [flagReason, setFlagReason] = useState('');
  const [unflagOpen, setUnflagOpen] = useState(false);
  const [mutating, setMutating] = useState(false);

  // Org names for the filter select (the Task-2 status endpoint already has them).
  useEffect(() => {
    void fetchWithAuth('/client-ai/admin/orgs')
      .then((r) => (r.ok ? (r.json() as Promise<{ data?: { orgId: string; orgName: string }[] }>) : null))
      .then((b) => {
        if (b?.data) setOrgs(b.data.map(({ orgId, orgName }) => ({ orgId, orgName })));
      })
      .catch(() => {});
  }, []);

  // User filter options once an org is chosen (GET /orgs/:orgId/users, decision 9 —
  // the API filter is clientUserId, a portal_users UUID, so free-text won't do).
  useEffect(() => {
    setOrgUsers([]);
    setUserFilter('');
    if (!orgFilter) return;
    let cancelled = false;
    void fetchWithAuth(`/client-ai/admin/orgs/${orgFilter}/users`)
      .then((r) => (r.ok ? (r.json() as Promise<{ data?: { id: string; email: string }[] }>) : null))
      .then((b) => {
        if (!cancelled && b?.data) setOrgUsers(b.data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [orgFilter]);

  const loadSessions = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(false);
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (orgFilter) qs.set('orgId', orgFilter);
      if (userFilter) qs.set('clientUserId', userFilter);
      if (fromDate) qs.set('from', fromDate);
      if (toDate) qs.set('to', `${toDate}T23:59:59.999Z`); // include the whole end day
      if (flaggedOnly) qs.set('flagged', 'true');
      const res = await fetchWithAuth(`/client-ai/admin/sessions?${qs.toString()}`);
      if (res.status === 401) {
        void navigateTo('/login', { replace: true });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        data: SessionListRow[];
        pagination: { total: number; limit: number; offset: number };
      };
      setRows(body.data ?? []);
      setTotal(body.pagination?.total ?? 0);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [orgFilter, userFilter, fromDate, toDate, flaggedOnly, offset]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const loadDetail = useCallback(async (sessionId: string) => {
    try {
      setDetailLoading(true);
      const res = await fetchWithAuth(`/client-ai/admin/sessions/${sessionId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDetail((await res.json()) as SessionDetail);
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const openDetail = (sessionId: string) => {
    setDetailId(sessionId);
    setDetail(null);
    void loadDetail(sessionId);
  };
  const closeDetail = () => {
    setDetailId(null);
    setDetail(null);
  };

  const flagSession = async () => {
    if (!detailId || mutating) return;
    setMutating(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/client-ai/admin/sessions/${detailId}/flag`, {
            method: 'POST',
            // flagSessionSchema: reason is string-or-absent (null is rejected).
            body: JSON.stringify(flagReason.trim() ? { reason: flagReason.trim() } : {}),
          }),
        errorFallback: 'Failed to flag session',
        successMessage: 'Session flagged',
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      setFlagOpen(false);
      setFlagReason('');
      await Promise.all([loadDetail(detailId), loadSessions()]);
    } catch (err) {
      handleActionError(err, 'Failed to flag session');
    } finally {
      setMutating(false);
    }
  };

  const unflagSession = async () => {
    if (!detailId || mutating) return;
    setMutating(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/client-ai/admin/sessions/${detailId}/flag`, { method: 'DELETE' }),
        errorFallback: 'Failed to unflag session',
        successMessage: 'Session unflagged',
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      setUnflagOpen(false);
      await Promise.all([loadDetail(detailId), loadSessions()]);
    } catch (err) {
      handleActionError(err, 'Failed to unflag session');
    } finally {
      setMutating(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">
          Organization
          <select
            value={orgFilter}
            onChange={(e) => {
              setOrgFilter(e.target.value);
              setOffset(0);
            }}
            className="mt-0.5 block rounded-md border bg-background px-2 py-1.5 text-sm"
            data-testid="ai-office-sessions-org"
          >
            <option value="">All organizations</option>
            {orgs.map((o) => (
              <option key={o.orgId} value={o.orgId}>
                {o.orgName}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          User
          <select
            value={userFilter}
            onChange={(e) => {
              setUserFilter(e.target.value);
              setOffset(0);
            }}
            disabled={!orgFilter}
            className="mt-0.5 block rounded-md border bg-background px-2 py-1.5 text-sm disabled:opacity-50"
            data-testid="ai-office-sessions-user"
          >
            <option value="">All users</option>
            {orgUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.email}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          From
          <input
            type="date"
            value={fromDate}
            onChange={(e) => {
              setFromDate(e.target.value);
              setOffset(0);
            }}
            className="mt-0.5 block rounded-md border bg-background px-2 py-1.5 text-sm"
            data-testid="ai-office-sessions-from"
          />
        </label>
        <label className="text-xs">
          To
          <input
            type="date"
            value={toDate}
            onChange={(e) => {
              setToDate(e.target.value);
              setOffset(0);
            }}
            className="mt-0.5 block rounded-md border bg-background px-2 py-1.5 text-sm"
            data-testid="ai-office-sessions-to"
          />
        </label>
        <label className="flex items-center gap-2 pb-1.5 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={flaggedOnly}
            onChange={(e) => {
              setFlaggedOnly(e.target.checked);
              setOffset(0);
            }}
            className="rounded border-border"
            data-testid="ai-office-sessions-flagged"
          />
          Flagged only
        </label>
      </div>

      {/* Session table */}
      <div className="rounded-lg border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : loadError ? (
          <div className="p-6 text-sm text-muted-foreground" data-testid="ai-office-sessions-load-error">
            Failed to load sessions.{' '}
            <button type="button" className="text-primary underline" onClick={() => void loadSessions()}>
              Retry
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2">Started</th>
                  <th className="px-4 py-2">Organization</th>
                  <th className="px-4 py-2">User</th>
                  <th className="px-4 py-2">Title</th>
                  <th className="px-4 py-2 text-right">Turns</th>
                  <th className="px-4 py-2 text-right">Cost</th>
                  <th className="px-4 py-2">Flagged</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => openDetail(s.id)}
                    className={`cursor-pointer border-b last:border-0 hover:bg-muted/20 ${s.flaggedAt ? 'border-l-2 border-l-amber-500' : ''}`}
                    data-testid={`ai-office-session-row-${s.id}`}
                  >
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">{formatTime(s.startedAt)}</td>
                    <td className="px-4 py-2.5">{s.orgName ?? '—'}</td>
                    <td className="px-4 py-2.5">{s.userEmail ?? '—'}</td>
                    <td className="max-w-[220px] truncate px-4 py-2.5">{s.title || 'Untitled'}</td>
                    <td className="px-4 py-2.5 text-right">{s.turnCount}</td>
                    <td className="px-4 py-2.5 text-right">{formatCost(s.totalCostCents)}</td>
                    <td className="px-4 py-2.5">
                      {s.flaggedAt ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400"
                          title={s.flagReason || 'Flagged'}
                        >
                          <Flag className="h-3 w-3" /> Flagged
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                      No client AI sessions match the filters
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {/* Pagination */}
        {!loading && !loadError && total > 0 && (
          <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
            <span>
              {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                disabled={offset === 0}
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 hover:bg-muted disabled:opacity-50"
                data-testid="ai-office-sessions-prev"
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Prev
              </button>
              <button
                type="button"
                onClick={() => setOffset(offset + PAGE_SIZE)}
                disabled={offset + PAGE_SIZE >= total}
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 hover:bg-muted disabled:opacity-50"
                data-testid="ai-office-sessions-next"
              >
                Next <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Transcript drawer */}
      {detailId && (
        <Dialog
          open
          onClose={closeDetail}
          title="Session transcript"
          maxWidth="4xl"
          alignTop
          className="flex max-h-[90vh] flex-col p-6"
        >
          {detailLoading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          )}
          {!detailLoading && !detail && (
            <p className="text-sm text-muted-foreground" data-testid="ai-office-session-detail-error">
              Failed to load the session transcript.
            </p>
          )}
          {detail && (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">{detail.session.title || 'Untitled session'}</h2>
                  <p className="text-sm text-muted-foreground">
                    {detail.session.orgName ?? '—'} · {detail.session.userEmail ?? '—'} ·{' '}
                    {detail.session.model} · {formatCost(detail.session.totalCostCents)} ·{' '}
                    {detail.session.totalInputTokens} in / {detail.session.totalOutputTokens} out
                  </p>
                  {detail.session.flagReason && (
                    <p className="mt-1 text-sm text-amber-700 dark:text-amber-400" data-testid="ai-office-session-flag-reason">
                      Flag reason: {detail.session.flagReason}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  {detail.session.flaggedAt ? (
                    <button
                      type="button"
                      onClick={() => setUnflagOpen(true)}
                      className="inline-flex items-center gap-1 rounded-md border px-2 py-1.5 text-sm hover:bg-muted"
                      data-testid="ai-office-session-unflag"
                    >
                      <FlagOff className="h-4 w-4" /> Unflag
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setFlagOpen(true)}
                      className="inline-flex items-center gap-1 rounded-md border border-amber-500/50 px-2 py-1.5 text-sm text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
                      data-testid="ai-office-session-flag"
                    >
                      <Flag className="h-4 w-4" /> Flag
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-4 flex-1 space-y-4 overflow-y-auto pr-1">
                {/* Messages with redaction badges + workbook-context chips */}
                <div className="space-y-2">
                  {detail.messages.map((m) => {
                    const redactions = Object.entries(m.redactionCounts ?? {});
                    const chips = workbookChips(m);
                    return (
                      <div
                        key={m.id}
                        className={`rounded-md border p-3 ${m.role === 'user' ? 'bg-muted/30' : 'bg-card'}`}
                      >
                        <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span className="font-semibold uppercase tracking-wide">{m.role}</span>
                          <span>{formatTime(m.createdAt)}</span>
                          {chips.map((chip) => (
                            <span
                              key={chip}
                              className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-400"
                            >
                              {chip}
                            </span>
                          ))}
                          {redactions.map(([type, count]) => (
                            <span
                              key={type}
                              className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400"
                              data-testid={`ai-office-redaction-${type}`}
                            >
                              redacted: {type} ×{count}
                            </span>
                          ))}
                        </div>
                        {m.content && <p className="whitespace-pre-wrap text-sm">{m.content}</p>}
                      </div>
                    );
                  })}
                  {detail.messages.length === 0 && (
                    <p className="text-sm text-muted-foreground">No messages stored for this session.</p>
                  )}
                </div>

                {/* Tool approval trail */}
                {detail.toolExecutions.length > 0 && (
                  <div>
                    <h4 className="mb-2 text-sm font-semibold">Tool approval trail</h4>
                    <div className="space-y-2">
                      {detail.toolExecutions.map((t) => (
                        <div key={t.id} className="rounded-md border p-3 text-sm" data-testid={`ai-office-tool-exec-${t.id}`}>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs">{t.toolName}</span>
                            <ToolStatusBadge status={t.status} />
                            {typeof (t.toolInput as { range?: unknown } | null)?.range === 'string' && (
                              <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                                {(t.toolInput as { range: string }).range}
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            requested {formatTime(t.createdAt)}
                            {t.approvedAt && ` · approved ${formatTime(t.approvedAt)}`}
                            {t.completedAt &&
                              ` · ${t.status === 'rejected' ? 'rejected' : 'applied'} ${formatTime(t.completedAt)}`}
                            {t.durationMs != null && ` · ${t.durationMs}ms`}
                          </p>
                          {t.errorMessage && (
                            <p className="mt-1 text-xs text-destructive">{t.errorMessage}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </Dialog>
      )}

      {/* Flag dialog (reason prompt) */}
      <Dialog open={flagOpen} onClose={() => setFlagOpen(false)} title="Flag session" maxWidth="md" className="p-6">
        <h3 className="text-lg font-semibold">Flag session</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Flagging marks the session for follow-up and is recorded in the audit log.
        </p>
        <label className="mt-3 block text-sm">
          <span className="text-muted-foreground">Reason (optional)</span>
          <textarea
            value={flagReason}
            onChange={(e) => setFlagReason(e.target.value)}
            rows={3}
            maxLength={1000}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            data-testid="ai-office-flag-reason"
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setFlagOpen(false)}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void flagSession()}
            disabled={mutating}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
            data-testid="ai-office-flag-confirm"
          >
            {mutating ? 'Flagging…' : 'Flag session'}
          </button>
        </div>
      </Dialog>

      {/* Unflag confirm */}
      <ConfirmDialog
        open={unflagOpen}
        onClose={() => setUnflagOpen(false)}
        onConfirm={() => void unflagSession()}
        title="Unflag session"
        message="Remove the flag from this session? The flag/unflag history stays in the audit log."
        confirmLabel="Unflag"
        variant="warning"
        isLoading={mutating}
        confirmTestId="ai-office-unflag-confirm"
      />
    </div>
  );
}
