import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GraphResponse, TopologyAiExplanation, TopologyAiSelection, TopologyDiagnosticRun } from '@breeze/shared';
import { topologyDiagnosticRunSchema } from '@breeze/shared/validators/topologyDiagnostics';
import { useAiStore } from '../../stores/aiStore';
import type { PendingApproval } from '../../stores/processStreamEvent';
import AiApprovalDialog from '../ai/AiApprovalDialog';
import { topologyRead } from './topologyApi';
import TopologyEvidenceCitation, { type TopologyEvidenceTarget } from './TopologyEvidenceCitation';
import { useTopologyInvestigation, type TopologyInvestigationError } from './useTopologyInvestigation';

/**
 * Topology M4 Task 5 (#6000): "Explain this" for one selected device or
 * connection. The model runs ONLY when the user presses Explain; the answer
 * shown is the server-validated structured explanation — Findings, Possible
 * causes (hypotheses, never styled as verified health), Missing data and Next
 * checks — each statement with its citations. Host aliases in the text are
 * mapped back to names only for nodes in the viewer's own graph read. A
 * proposed diagnostic is the existing approval card over the pinned effect,
 * approved with a fresh passkey assertion; its accepted run is followed by id.
 * Any AI failure leaves the ordinary evidence, health and diagnostics intact.
 */

const RUN_TERMINAL = new Set(['completed', 'failed', 'cancelled', 'expired']);
const HOST_ALIAS = /\bhost-[0-9a-f]{8}\b/g;

/** Replace a host alias with the node's name ONLY when that node is in the viewer's authorized graph. */
export function withHostNames(text: string, explanation: TopologyAiExplanation, graph: GraphResponse): string {
  const names = new Map<string, string>();
  for (const { alias, nodeId } of explanation.hostAliases ?? []) {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    if (node) names.set(alias, node.label);
  }
  return names.size ? text.replace(HOST_ALIAS, (alias) => names.get(alias) ?? alias) : text;
}

function errorCopyKey(error: TopologyInvestigationError | null): string {
  switch (error?.code) {
    case 'topology_ai_disabled': return 'ai.errors.disabled';
    case 'topology_ai_concurrency': case 'topology_ai_user_hourly': case 'topology_ai_org_daily': case 'topology_ai_budget_exhausted': return 'ai.errors.limit';
    case 'investigation_scope_changed': case 'graph_revision_changed': case 'subject_not_found': return 'ai.errors.scopeChanged';
    case 'topology_site_unavailable': case 'topology_session_required': return 'ai.errors.accessChanged';
    default: return 'ai.errors.generic';
  }
}

type ProposalFields = { recipeId: string | null; originDeviceId: string | null; family: string | null; contextKey: string | null; expiresAt: string | null };
function proposalFields(proposal: PendingApproval): ProposalFields {
  const input = proposal.input ?? {};
  const str = (value: unknown) => (typeof value === 'string' && value.length <= 200 ? value : null);
  return { recipeId: str(input.recipe_id), originDeviceId: str(input.origin_device_id), family: str(input.family), contextKey: str(input.context_key), expiresAt: str(input.proposal_expires_at) };
}

export default function TopologyExplanationPanel({ siteId, selection, graph, canApprove, initialSessionId, initialRunId, onInvestigation, onRun, onEvidenceSelect }: {
  siteId: string; selection: TopologyAiSelection; graph: GraphResponse;
  /** Execute at this site (settings authority). Without it a proposal is shown read-only. */
  canApprove: boolean;
  initialSessionId?: string; initialRunId?: string;
  onInvestigation: (sessionId: string | undefined) => void; onRun: (runId: string | undefined) => void;
  onEvidenceSelect: (target: TopologyEvidenceTarget) => void;
}) {
  const { t } = useTranslation('topology');
  const headingId = useId();
  const investigation = useTopologyInvestigation(selection, { initialSessionId, initialRunId, onSession: onInvestigation });
  const { status, phase, explanation, error, proposal, runId, historical } = investigation;
  const busy = status === 'starting' || status === 'running';
  const [dismissedRun, setDismissedRun] = useState<string | null>(null);
  const shownRun = runId && runId !== dismissedRun ? runId : null;
  useEffect(() => { if (runId && runId !== initialRunId) onRun(runId); }, [runId]);

  const citationIndex = new Map((explanation?.citations ?? []).map((citation, index) => [citation.id, index]));
  const citationsFor = (ids: string[]) => ids.map((id) => citationIndex.get(id)).filter((index): index is number => index !== undefined).map((index) =>
    <TopologyEvidenceCitation key={index} citation={explanation!.citations[index]!} index={index} graph={graph} onSelect={onEvidenceSelect} />);
  const text = (value: string) => explanation ? withHostNames(value, explanation, graph) : value;
  const findings = explanation?.findings.filter((finding) => finding.kind === 'finding') ?? [];
  const hypotheses = explanation?.findings.filter((finding) => finding.kind === 'hypothesis') ?? [];
  const empty = explanation && !findings.length && !hypotheses.length && !explanation.missingData.length && !explanation.nextChecks.length;

  return <section data-testid="topology-explain-panel" aria-labelledby={headingId} className="space-y-3 rounded border p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 id={headingId} className="font-medium">{t('ai.heading')}</h4>
      <div className="flex gap-2">
        <button type="button" data-testid="topology-explain" className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" disabled={busy} onClick={() => void investigation.explain()}>
          {explanation || status === 'fallback' || status === 'error' ? t('ai.explainAgain') : t('ai.explain')}</button>
        {busy && <button type="button" data-testid="topology-explain-cancel" className="rounded border px-3 py-2 text-sm" onClick={investigation.cancel}>{t('ai.cancel')}</button>}
      </div>
    </div>
    {status === 'idle' && !explanation && <p className="text-sm text-muted-foreground">{t('ai.intro')}</p>}
    <p data-testid="topology-explain-status" role="status" aria-live="polite" className="text-sm text-muted-foreground">
      {proposal ? t('ai.phase.awaiting_approval') : phase ? t(/* i18n-dynamic */ `ai.phase.${phase}`) : ''}</p>

    {(status === 'error' || status === 'fallback') && <div data-testid="topology-explain-fallback" role="alert" className="rounded border border-dashed p-2 text-sm">
      <p>{status === 'fallback' ? t('ai.errors.invalid') : t(/* i18n-dynamic */ errorCopyKey(error))}</p>
      <p className="text-muted-foreground">{t('ai.fallback')}</p>
    </div>}

    {explanation && <div data-testid="topology-explanation" className="space-y-3">
      {historical && <p data-testid="topology-explain-historical" className="rounded bg-muted p-2 text-sm">{t('ai.historical')}</p>}
      {explanation.status === 'partial' && <p data-testid="topology-explain-partial" className="text-sm text-muted-foreground">{t('ai.partial')}</p>}
      {explanation.status === 'evidence_changed' && <p data-testid="topology-explain-partial" className="text-sm text-muted-foreground">{t('ai.evidenceChanged')}</p>}
      {empty && <p data-testid="topology-explain-no-evidence" className="text-sm">{t('ai.noEvidence')}</p>}
      {findings.length > 0 && <div data-testid="topology-explain-findings"><h5 className="text-sm font-medium">{t('ai.findings')}</h5>
        <ul className="space-y-2">{findings.map((finding, i) => <li key={i} data-testid="topology-explain-finding" className="space-y-1 text-sm">
          <p>{text(finding.text)}</p><div className="flex flex-wrap gap-1">{citationsFor(finding.citationIds)}</div></li>)}</ul></div>}
      {hypotheses.length > 0 && <div data-testid="topology-explain-hypotheses"><h5 className="text-sm font-medium">{t('ai.hypotheses')}</h5>
        <p className="text-xs text-muted-foreground">{t('ai.hypothesisNote')}</p>
        <ul className="space-y-2">{hypotheses.map((finding, i) => <li key={i} data-testid="topology-explain-hypothesis" className="space-y-1 border-l-2 border-dashed pl-2 text-sm italic">
          <p>{text(finding.text)}</p><div className="flex flex-wrap gap-1 not-italic">{citationsFor(finding.citationIds)}</div></li>)}</ul></div>}
      {explanation.missingData.length > 0 && <div data-testid="topology-explain-missing-data"><h5 className="text-sm font-medium">{t('ai.missingData')}</h5>
        <ul className="list-inside list-disc text-sm">{explanation.missingData.map((item, i) => <li key={i}>{text(item)}</li>)}</ul></div>}
      {explanation.nextChecks.length > 0 && <div data-testid="topology-explain-next-checks"><h5 className="text-sm font-medium">{t('ai.nextChecks')}</h5>
        <ul className="space-y-2">{explanation.nextChecks.map((check, i) => <li key={i} data-testid="topology-explain-next-check" className="space-y-1 text-sm">
          <p><span className="font-medium">{t(/* i18n-dynamic */ `recipes.${check.recipeId}`)}</span>: {text(check.rationale)}</p>
          <div className="flex flex-wrap gap-1">{citationsFor(check.citationIds)}</div></li>)}</ul></div>}
    </div>}

    {proposal && <ProposedCheck proposal={proposal} graph={graph} disabled={historical || !canApprove} reason={historical ? t('ai.proposal.historical') : t('ai.proposal.readOnly')} />}
    {shownRun && <ApprovedRun siteId={siteId} runId={shownRun} onClose={() => { setDismissedRun(shownRun); onRun(undefined); }} />}
  </section>;
}

function ProposedCheck({ proposal, graph, disabled, reason }: { proposal: PendingApproval; graph: GraphResponse; disabled: boolean; reason: string }) {
  const { t } = useTranslation('topology');
  const fields = proposalFields(proposal);
  const origin = fields.originDeviceId
    ? graph.nodes.find((node) => node.bindings.some((binding) => binding.type === 'device' && binding.referenceId === fields.originDeviceId))?.label ?? t('outsideProjection')
    : t('unknown');
  return <div data-testid="topology-proposed-check" className="space-y-2 rounded border p-2">
    <h5 className="text-sm font-medium">{t('ai.proposal.heading')}</h5>
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt>{t('ai.proposal.recipe')}</dt><dd data-testid="topology-proposal-recipe">{fields.recipeId ? t(/* i18n-dynamic */ `recipes.${fields.recipeId}`, { defaultValue: fields.recipeId }) : t('unknown')}</dd>
      <dt>{t('ai.proposal.origin')}</dt><dd data-testid="topology-proposal-origin">{origin}{fields.contextKey ? ` · ${fields.contextKey}` : ''}{fields.family ? ` · ${fields.family}` : ''}</dd>
      <dt>{t('ai.proposal.expires')}</dt><dd>{fields.expiresAt ? new Date(fields.expiresAt).toLocaleString() : t('unknown')}</dd>
    </dl>
    {disabled
      ? <p data-testid="topology-proposal-disabled" className="text-sm text-muted-foreground">{proposal.description} — {reason}</p>
      : <AiApprovalDialog key={proposal.executionId} toolName={proposal.toolName} description={proposal.description} input={proposal.input}
        onApprove={() => void useAiStore.getState().approveExecution(proposal.executionId, true)}
        onReject={() => void useAiStore.getState().approveExecution(proposal.executionId, false)}
        intentBacked={proposal.intentBacked} selfApprovalRequestId={proposal.selfApprovalRequestId} approvalScope={proposal.approvalScope}
        intentExpiresAt={proposal.intentExpiresAt} approvalWindowMs={proposal.approvalWindowMs} approvalExpiresAt={proposal.approvalExpiresAt}
        onIntentDecided={() => useAiStore.getState().clearPendingApproval()} testIdPrefix="topology-proposal" />}
  </div>;
}

/** The accepted run of an approved proposal, re-read by id through the ordinary site-authorized route — never re-POSTed. */
function ApprovedRun({ siteId, runId, onClose }: { siteId: string; runId: string; onClose: () => void }) {
  const { t } = useTranslation('topology');
  const [run, setRun] = useState<TopologyDiagnosticRun | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined; let count = 0;
    setRun(null); setFailed(false);
    const poll = async () => {
      try {
        const next = await topologyRead(`/topology/sites/${encodeURIComponent(siteId)}/diagnostic-runs/${encodeURIComponent(runId)}`, topologyDiagnosticRunSchema, controller.signal);
        if (controller.signal.aborted) return;
        setRun(next);
        if (RUN_TERMINAL.has(next.state)) return;
      } catch { if (!controller.signal.aborted) { setFailed(true); return; } }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), ++count < 5 ? 2000 : 5000);
    };
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [siteId, runId]);
  return <div data-testid="topology-ai-run-status" className="space-y-1 rounded border p-2 text-sm">
    <div className="flex items-center justify-between gap-2"><h5 className="font-medium">{t('ai.run.heading')}</h5>
      <button type="button" data-testid="topology-ai-run-close" className="text-xs underline" onClick={onClose}>{t('close')}</button></div>
    {failed ? <p role="alert">{t('ai.run.loadFailed')}</p> : !run ? <p role="status">{t('loading')}</p> : <>
      <p role="status" data-testid="topology-ai-run-state">{t('ai.run.state', { state: t(/* i18n-dynamic */ `ai.states.${run.state}`, { defaultValue: run.state }) })}</p>
      <p className="break-words">{t(/* i18n-dynamic */ `recipes.${run.plan.recipeId}`)} · {run.plan.origin.agentId} · {run.plan.origin.contextKey} · {run.plan.family}</p>
      {RUN_TERMINAL.has(run.state) && <p>{t(/* i18n-dynamic */ `healthStatus.${run.assessment}`, { defaultValue: run.assessment })}</p>}
    </>}
  </div>;
}
