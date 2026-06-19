import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, ShieldAlert, UserCheck, XCircle } from 'lucide-react';

import { runAction, handleActionError } from '../../lib/runAction';
import { fetchWithAuth } from '../../stores/auth';
import { useMlFeatureFlags } from '../../hooks/useMlFeatureFlags';

type UserRiskScore = {
  orgId: string;
  userId: string;
  userName: string;
  userEmail: string;
  score: number;
  trendDirection: 'up' | 'down' | 'stable' | null;
  calculatedAt: string;
  factors: Record<string, number>;
};

type UserRiskEvent = {
  id: string;
  eventType: string;
  severity: string | null;
  scoreImpact: number;
  description: string;
  occurredAt: string;
};

type UserRiskDetail = {
  user: {
    id: string;
    name: string;
    email: string;
  };
  latestScore: {
    score: number;
    severity: 'low' | 'medium' | 'high' | 'critical';
    factors: Record<string, number>;
    calculatedAt: string;
  };
  recentEvents: UserRiskEvent[];
};

type Evaluation = {
  windowDays: number;
  totalLabels: number;
  truePositives: number;
  falsePositives: number;
  precision: number | null;
  trainingAssigned: number;
  trainingCompleted: number;
  trainingCompletionRate: number | null;
  riskSignals: number;
  usersWithRiskSignals: number;
  repeatSignalUsers: number;
  repeatSignalRate: number | null;
};

const scoreTextClass = (score: number): string => {
  if (score >= 85) return 'text-red-700';
  if (score >= 70) return 'text-orange-700';
  if (score >= 50) return 'text-amber-700';
  return 'text-emerald-700';
};

const scoreBarClass = (score: number): string => {
  if (score >= 85) return 'bg-red-500';
  if (score >= 70) return 'bg-orange-500';
  if (score >= 50) return 'bg-amber-500';
  return 'bg-emerald-500';
};

const severityClass = (severity: string | null): string => {
  if (severity === 'critical') return 'border-red-500/40 bg-red-500/10 text-red-700';
  if (severity === 'high') return 'border-orange-500/40 bg-orange-500/10 text-orange-700';
  if (severity === 'medium') return 'border-amber-500/40 bg-amber-500/10 text-amber-700';
  return 'border-blue-500/40 bg-blue-500/10 text-blue-700';
};

const formatPercent = (value: number | null): string => (
  value === null ? 'n/a' : `${Math.round(value * 100)}%`
);

const formatDate = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const formatFactor = (value: string): string => (
  value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
);

export default function UserRiskPage() {
  const mlFlags = useMlFeatureFlags();
  const [scores, setScores] = useState<UserRiskScore[]>([]);
  const [detail, setDetail] = useState<UserRiskDetail | null>(null);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [selected, setSelected] = useState<UserRiskScore | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  const [labeling, setLabeling] = useState<'true_positive' | 'false_positive' | null>(null);
  const userRiskDisabled = mlFlags.isDisabled('ml.user_risk_v0.enabled');

  const loadScores = useCallback(async () => {
    if (!mlFlags.loaded || userRiskDisabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [scoresResponse, evaluationResponse] = await Promise.all([
        fetchWithAuth('/user-risk/scores?limit=25&minScore=50'),
        fetchWithAuth('/user-risk/evaluation?days=30'),
      ]);
      if (!scoresResponse.ok) throw new Error('Failed to load user risk scores');
      if (!evaluationResponse.ok) throw new Error('Failed to load user risk evaluation');
      const scoresJson = await scoresResponse.json();
      const evaluationJson = await evaluationResponse.json();
      const rows = Array.isArray(scoresJson?.data) ? scoresJson.data as UserRiskScore[] : [];
      setScores(rows);
      setEvaluation(evaluationJson?.data ?? null);
      setSelected((current) => current ?? rows[0] ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load user risk');
    } finally {
      setLoading(false);
    }
  }, [mlFlags.loaded, userRiskDisabled]);

  useEffect(() => {
    if (!mlFlags.loaded) return;
    if (userRiskDisabled) {
      setScores([]);
      setEvaluation(null);
      setSelected(null);
      setDetail(null);
      setError(null);
      setLoading(false);
      return;
    }
    void loadScores();
  }, [loadScores, mlFlags.loaded, userRiskDisabled]);

  useEffect(() => {
    if (userRiskDisabled) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    if (!selected) {
      setDetail(null);
      setDetailError(null);
      return;
    }

    let active = true;
    setDetailLoading(true);
    setDetailError(null);
    fetchWithAuth(`/user-risk/users/${selected.userId}?orgId=${selected.orgId}`)
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to load user risk detail');
        const json = await response.json();
        if (active) setDetail(json?.data ?? null);
      })
      .catch((err) => {
        if (active) {
          setDetail(null);
          setDetailError(err instanceof Error ? err.message : 'Failed to load user risk detail');
        }
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });

    return () => {
      active = false;
    };
  }, [selected, userRiskDisabled, detailReloadKey]);

  const factors = useMemo(() => (
    Object.entries(detail?.latestScore.factors ?? selected?.factors ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
  ), [detail?.latestScore.factors, selected?.factors]);

  async function submitLabel(outcome: 'true_positive' | 'false_positive') {
    if (!selected) return;
    setLabeling(outcome);
    try {
      await runAction({
        request: () => fetchWithAuth(`/user-risk/users/${selected.userId}/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orgId: selected.orgId,
            outcome,
            score: selected.score,
          }),
        }),
        errorFallback: 'Could not save user risk feedback',
        successMessage: outcome === 'true_positive' ? 'True positive label saved' : 'False positive label saved',
      });
      await loadScores();
    } catch (err) {
      handleActionError(err, 'Could not save user risk feedback');
    } finally {
      setLabeling(null);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[420px] items-center justify-center" data-testid="user-risk-loading">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (userRiskDisabled) {
    return (
      <div className="space-y-5" data-testid="user-risk-page">
        <header>
          <h1 className="text-2xl font-semibold tracking-normal">User Risk</h1>
          <p className="text-sm text-muted-foreground">Review rules-v0 risk scores, evidence, and evaluation labels.</p>
        </header>
        <section className="rounded-lg border bg-card p-6" data-testid="user-risk-disabled">
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 h-5 w-5 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-semibold">User risk scoring is disabled for this organization.</h2>
              <p className="mt-1 text-sm text-muted-foreground">Scores, evidence, and labels will appear here when the user-risk v0 producer is enabled.</p>
            </div>
          </div>
        </section>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-5 text-sm text-destructive">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          <span>{error}</span>
        </div>
        <button type="button" onClick={() => void loadScores()} className="mt-4 inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs font-medium">
          <RefreshCw className="h-4 w-4" />
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="user-risk-page">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">User Risk</h1>
          <p className="text-sm text-muted-foreground">Review rules-v0 risk scores, evidence, and evaluation labels.</p>
        </div>
        <button type="button" onClick={() => void loadScores()} className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted">
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </header>

      <section className="grid gap-3 md:grid-cols-4">
        <MetricCard label="Precision" value={formatPercent(evaluation?.precision ?? null)} />
        <MetricCard label="Labels" value={`${evaluation?.totalLabels ?? 0}`} />
        <MetricCard label="Training completion" value={formatPercent(evaluation?.trainingCompletionRate ?? null)} />
        <MetricCard label="Repeat signal users" value={`${evaluation?.repeatSignalUsers ?? 0}`} />
      </section>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.35fr)]">
        <section className="rounded-lg border bg-card">
          <div className="border-b p-4">
            <h2 className="text-sm font-semibold">At-risk users</h2>
          </div>
          <div className="max-h-[620px] divide-y overflow-y-auto">
            {scores.length === 0 ? (
              <div className="p-5 text-sm text-muted-foreground">No users are above the current risk threshold.</div>
            ) : scores.map((score) => (
              <button
                key={`${score.orgId}:${score.userId}`}
                type="button"
                onClick={() => setSelected(score)}
                className={`block w-full p-4 text-left hover:bg-muted/60 ${selected?.userId === score.userId && selected.orgId === score.orgId ? 'bg-muted' : ''}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{score.userName}</div>
                    <div className="truncate text-xs text-muted-foreground">{score.userEmail}</div>
                  </div>
                  <div className={`text-xl font-semibold ${scoreTextClass(score.score)}`}>{score.score}</div>
                </div>
                <div className="mt-3 h-2 rounded-full bg-muted">
                  <div className={`h-2 rounded-full ${scoreBarClass(score.score)}`} style={{ width: `${score.score}%` }} />
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-lg border bg-card">
          {!selected ? (
            <div className="p-6 text-sm text-muted-foreground">Select a user to inspect risk evidence.</div>
          ) : (
            <div className="space-y-5 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="h-5 w-5 text-orange-600" />
                    <h2 className="text-lg font-semibold">{detail?.user.name ?? selected.userName}</h2>
                  </div>
                  <p className="text-sm text-muted-foreground">{detail?.user.email ?? selected.userEmail}</p>
                </div>
                <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${severityClass(detail?.latestScore.severity ?? null)}`}>
                  {detail?.latestScore.severity ?? 'score'} {detail?.latestScore.score ?? selected.score}
                </span>
              </div>

              {detailError && (
                <div
                  className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                  data-testid="user-risk-detail-error"
                >
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4" />
                    <span>{detailError}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDetailReloadKey((key) => key + 1)}
                    className="mt-3 inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                  >
                    <RefreshCw className="h-4 w-4" />
                    Retry
                  </button>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void submitLabel('true_positive')}
                  disabled={labeling !== null}
                  className="inline-flex items-center gap-2 rounded-md border border-emerald-500/40 px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-500/10 disabled:opacity-60"
                >
                  {labeling === 'true_positive' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                  True positive
                </button>
                <button
                  type="button"
                  onClick={() => void submitLabel('false_positive')}
                  disabled={labeling !== null}
                  className="inline-flex items-center gap-2 rounded-md border border-slate-400/50 px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60"
                >
                  {labeling === 'false_positive' ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                  False positive
                </button>
              </div>

              <div>
                <h3 className="mb-3 text-sm font-semibold">Top drivers</h3>
                <div className="space-y-3">
                  {factors.map(([factor, value]) => (
                    <div key={factor}>
                      <div className="mb-1 flex items-center justify-between gap-3 text-xs">
                        <span className="capitalize text-muted-foreground">{formatFactor(factor)}</span>
                        <span className="font-medium">{value}</span>
                      </div>
                      <div className="h-2 rounded-full bg-muted">
                        <div className={`h-2 rounded-full ${scoreBarClass(value)}`} style={{ width: `${value}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h3 className="mb-3 text-sm font-semibold">Recent evidence</h3>
                {detailLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading evidence
                  </div>
                ) : detail?.recentEvents?.length ? (
                  <div className="space-y-2">
                    {detail.recentEvents.slice(0, 6).map((event) => (
                      <div key={event.id} className="rounded-md border p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-sm font-medium">{event.description}</span>
                          <span className={`rounded-full border px-2 py-0.5 text-xs ${severityClass(event.severity)}`}>{event.severity ?? 'info'}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                          <span>{event.eventType}</span>
                          <span>{formatDate(event.occurredAt)}</span>
                          <span>{event.scoreImpact >= 0 ? '+' : ''}{event.scoreImpact} impact</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-md border p-3 text-sm text-muted-foreground">No recent evidence found for this score.</div>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <UserCheck className="h-4 w-4" />
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </div>
  );
}
