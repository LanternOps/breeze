import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

export interface ScriptProposalsMetrics {
  perDay: { date: string; count: number }[];
  reviewerDisagreements: { humanRejectedAfterApprove: number; humanApprovedAfterReject: number };
  unattendedRuns?: number;
  laneState?: 'open' | 'closed' | null;
}

interface Props {
  data: ScriptProposalsMetrics | null;
  loading: boolean;
}

export function ScriptProposalsPanel({ data, loading }: Props) {
  const { t } = useTranslation("security");

  if (loading || !data) {
    return (
      <div>
        <h2 className="mb-4 text-lg font-semibold">{t("aiRiskScriptProposalsPanel.title")}</h2>
        {!loading && (
          <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground shadow-xs">
            {t("aiRiskScriptProposalsPanel.noData")}
          </div>
        )}
        {loading && (
          <div className="h-56 animate-pulse rounded-lg border bg-muted/30" />
        )}
      </div>
    );
  }

  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold">{t("aiRiskScriptProposalsPanel.title")}</h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <h3 className="mb-3 text-sm font-medium text-muted-foreground">
            {t("aiRiskScriptProposalsPanel.proposalsPerDay")}
          </h3>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.perDay}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="date" className="fill-muted-foreground text-xs" />
                <YAxis allowDecimals={false} className="fill-muted-foreground text-xs" />
                <Tooltip />
                <Line type="monotone" dataKey="count" stroke="#3b82f6" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <h3 className="mb-3 text-sm font-medium text-muted-foreground">
            {t("aiRiskScriptProposalsPanel.reviewerDisagreements")}
          </h3>
          <dl className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">{t("aiRiskScriptProposalsPanel.humanRejectedAfterApprove")}</dt>
              <dd className="text-lg font-semibold tabular-nums">{data.reviewerDisagreements.humanRejectedAfterApprove}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">{t("aiRiskScriptProposalsPanel.humanApprovedAfterReject")}</dt>
              <dd className="text-lg font-semibold tabular-nums">{data.reviewerDisagreements.humanApprovedAfterReject}</dd>
            </div>
          </dl>
        </div>

        {data.unattendedRuns !== undefined && (
          <div data-testid="script-proposals-unattended-card" className="rounded-lg border bg-card p-4 shadow-xs">
            <h3 className="mb-3 text-sm font-medium text-muted-foreground">
              {t("aiRiskScriptProposalsPanel.unattendedRuns")}
            </h3>
            <p className="text-lg font-semibold tabular-nums">{data.unattendedRuns}</p>
          </div>
        )}

        {data.laneState !== undefined && (
          <div data-testid="script-proposals-lane-card" className="rounded-lg border bg-card p-4 shadow-xs">
            <h3 className="mb-3 text-sm font-medium text-muted-foreground">
              {t("aiRiskScriptProposalsPanel.laneState")}
            </h3>
            <p className="text-lg font-semibold">
              {data.laneState === 'open'
                ? t("aiRiskScriptProposalsPanel.laneOpen")
                : data.laneState === 'closed'
                  ? t("aiRiskScriptProposalsPanel.laneClosed")
                  : t("aiRiskScriptProposalsPanel.laneNotConfigured")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
