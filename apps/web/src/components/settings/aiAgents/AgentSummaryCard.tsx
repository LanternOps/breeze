import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentPreviewDto } from '@breeze/shared';
import { badgeClass, modeTone } from '../../aiAgents/statusBadge';
import { formatCurrency, formatPercent, resolvedFormattingLocale } from '@/lib/i18n/format';
import type { OperationOutcome } from './capabilityModel';

export interface AgentSummaryCardProps {
  preview: AgentPreviewDto;
  name: string;
  orgName: string | null;
  /** Whether the agent will be created/saved enabled. Defaults to false — the
   *  guided create flow always creates disabled (spec §4.6 step 1's footer). */
  enabled?: boolean;
  /** Role id -> display name for the caller's GET /roles list. When every
   *  recipient role resolves, the approvers row names them; otherwise (no
   *  map, or a role deleted since) it falls back to the count (#5048 QA). */
  recipientRoleNames?: ReadonlyMap<string, string>;
  onEdit?: (section: 'purpose' | 'does' | 'safety') => void;
}

/** Which create-flow step (spec §4.6) owns each row's underlying setting. */
type EditSection = 'purpose' | 'does' | 'safety';
const ROW_SECTION: Record<
  'runsWhen' | 'canRead' | 'mayPropose' | 'executesUnattended' | 'neverTouches' | 'limits' | 'approvers',
  EditSection
> = {
  // Step 2 ("What it does"): triggers + the capability picker, including its
  // always-on reads disclosure.
  runsWhen: 'does',
  canRead: 'does',
  mayPropose: 'does',
  // Step 3 ("Safety and oversight"): unattended-ceiling keys, protected
  // resources, limits and recipients all live there.
  executesUnattended: 'safety',
  neverTouches: 'safety',
  limits: 'safety',
  approvers: 'safety',
};

/** Outcome -> badge tone, matching OperationRow.tsx's OUTCOME_TONE (duplicated
 *  locally per CLAUDE.md's "helpers used by multiple files may be duplicated"
 *  guidance — this component never imports from OperationRow, which expects
 *  a full `AgentToolCatalogToolDto` operation, not `AgentPreviewDto`'s
 *  server-evaluated summary shape). */
const OUTCOME_TONE: Record<OperationOutcome, 'warning' | 'info' | 'danger'> = {
  approval_request: 'warning',
  logged_proposal: 'info',
  unattended: 'danger',
};

/** `manage_startup_items` -> "Manage startup items" — last-resort label for a
 *  tool/action this catalog namespace has no translation for yet. Mirrors
 *  CapabilityPicker.tsx's own `sentenceCase`. */
function sentenceCase(token: string): string {
  const words = token.replace(/[_:-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `'manage_services:restart'` -> `{ tool: 'manage_services', action: 'restart' }`; a bare entry -> `action: null`. */
function splitOpKey(key: string): { tool: string; action: string | null } {
  const colon = key.indexOf(':');
  return colon === -1 ? { tool: key, action: null } : { tool: key.slice(0, colon), action: key.slice(colon + 1) };
}

function SummaryRow({
  id,
  label,
  section,
  onEdit,
  editLabel,
  children,
}: {
  id: string;
  label: string;
  section: EditSection;
  onEdit?: (section: EditSection) => void;
  editLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[180px_minmax(0,1fr)_60px] items-start gap-2 py-2" data-testid={`agent-summary-row-${id}`}>
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      <div className="text-sm">{children}</div>
      <div className="text-right">
        {onEdit && (
          <button
            type="button"
            className="text-xs font-medium text-primary underline-offset-2 hover:underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onEdit(section)}
            data-testid={`agent-summary-row-${id}-edit`}
          >
            {editLabel}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The four-step create flow's review card (spec §4.6 step 4) and the edit
 * drawer's top-of-form summary. Renders `POST /ai/agents/preview`'s
 * server-evaluated `AgentPreviewDto` verbatim — every number and outcome here
 * came from the SAME guardrail/catalog helpers the run loop uses, so this
 * card cannot drift from what create/update would actually enforce (that is
 * the entire point of evaluating the draft server-side rather than
 * re-deriving it from the picker's own client-side model).
 *
 * The six exposed limits (spec §4.6 step 4): the five fields of
 * `preview.limits` (`AiAgentLimits`) plus `preview.cooldownSeconds`, a sibling
 * field on the agent's policy row (`AiAgentPolicy.cooldownSeconds`) rather
 * than one of `AiAgentLimits`'s own fields — `buildAgentPreview` carries it
 * through separately (agentPreview.ts) so this card can render it alongside
 * the other five without reaching into a differently-shaped policy row.
 */
export default function AgentSummaryCard({
  preview,
  name,
  orgName,
  enabled = false,
  recipientRoleNames,
  onEdit,
}: AgentSummaryCardProps) {
  const { t } = useTranslation('settings');

  const toolLabel = (toolName: string) =>
    t(/* i18n-dynamic */ `aiAgentsPage.catalog.tools.${toolName}`, { defaultValue: sentenceCase(toolName) });
  const actionLabel = (toolName: string, action: string | null) =>
    action === null
      ? toolLabel(toolName)
      : t(/* i18n-dynamic */ `aiAgentsPage.catalog.actions.${toolName}.${action}`, { defaultValue: sentenceCase(action) });
  /** Standalone (not tool-grouped) chip/list label: combines tool + action
   *  since, unlike CapabilityPicker's nested rows, nothing else on this card
   *  names the tool a bare action label belongs to. */
  const opLabel = (key: string): string => {
    const { tool, action } = splitOpKey(key);
    return action === null ? toolLabel(tool) : `${toolLabel(tool)}: ${actionLabel(tool, action)}`;
  };
  const severityLabel = (severity: string) =>
    t(/* i18n-dynamic */ `aiAgentsPage.severities.${severity}`, { defaultValue: sentenceCase(severity) });
  const listFormat = (items: string[]): string =>
    new Intl.ListFormat(resolvedFormattingLocale(), { style: 'long', type: 'conjunction' }).format(items);

  const editLabel = t('aiAgentsPage.summary.edit');
  const notInCeilingLabel = t('aiAgentsPage.catalog.notInCeiling');

  // --- Title row ---
  const kindLabel = t(/* i18n-dynamic */ `aiAgentsPage.kinds.${preview.kind}`, { defaultValue: sentenceCase(preview.kind) });
  const modeLabel = t(/* i18n-dynamic */ `aiAgentsPage.modeChoice.${preview.mode}`, { defaultValue: sentenceCase(preview.mode) });

  // --- Runs when ---
  const runsWhenParts: string[] = [];
  if (preview.kind === 'patch') runsWhenParts.push(t('aiAgentsPage.summary.runsWhen.patch'));
  else if (preview.kind === 'helpdesk') runsWhenParts.push(t('aiAgentsPage.summary.runsWhen.helpdesk'));
  else {
    const severities = preview.triggers.alertSeverities.map(severityLabel);
    runsWhenParts.push(
      t('aiAgentsPage.summary.runsWhen.triage', {
        severities: severities.length > 0 ? listFormat(severities) : t('aiAgentsPage.summary.runsWhen.anySeverity'),
      }),
    );
  }
  if (preview.triggers.respectMaintenanceWindows) runsWhenParts.push(t('aiAgentsPage.summary.runsWhen.maintenanceWindows'));
  if (preview.triggers.ticketAutonomousWrites) runsWhenParts.push(t('aiAgentsPage.summary.runsWhen.ticketWrites'));
  const runsWhenText = runsWhenParts.join(' ');

  // --- Can read ---
  const scope = orgName ?? t('aiAgentsPage.summary.allOrganizations');
  const canReadText = t('aiAgentsPage.summary.canRead', { scope, count: preview.readOnlyToolCount });

  // --- May propose ---
  const mutatingOps = preview.operations;
  const capabilitiesTouched = new Set(mutatingOps.map((op) => op.capability)).size;
  const approvalRequests = mutatingOps.filter((op) => op.outcome === 'approval_request').length;
  const loggedProposals = mutatingOps.filter((op) => op.outcome === 'logged_proposal').length;
  const unattendedOps = mutatingOps.filter((op) => op.outcome === 'unattended');
  // Every listed operation lands in exactly one of the three phrases — the
  // sentence used to skip the unattended ones, so "6 operations: 1 … and 2 …"
  // left three unaccounted for (#5048 QA). Each count pluralises on its own,
  // so the parts are pre-pluralised and joined as one `breakdown`.
  const breakdownParts: string[] = [];
  if (approvalRequests > 0) breakdownParts.push(t('aiAgentsPage.summary.approvalCount', { count: approvalRequests }));
  if (loggedProposals > 0) breakdownParts.push(t('aiAgentsPage.summary.loggedCount', { count: loggedProposals }));
  if (unattendedOps.length > 0) breakdownParts.push(t('aiAgentsPage.summary.unattendedCount', { count: unattendedOps.length }));
  const mayProposeText =
    mutatingOps.length === 0
      ? t('aiAgentsPage.summary.mayProposeNone')
      : t('aiAgentsPage.summary.mayPropose', {
          count: mutatingOps.length,
          capabilityPhrase: t('aiAgentsPage.catalog.capabilityCount', { count: capabilitiesTouched }),
          breakdown: listFormat(breakdownParts),
        });

  // --- Executes unattended ---
  const anyPreauthorized = mutatingOps.some((op) => op.preauthorized);
  let executesUnattendedText: string;
  if (preview.mode !== 'act') executesUnattendedText = t('aiAgentsPage.summary.executesUnattendedNone');
  else if (unattendedOps.length === 0) executesUnattendedText = t('aiAgentsPage.summary.executesUnattendedNoneAct');
  else executesUnattendedText = t('aiAgentsPage.summary.executesUnattendedList', { list: listFormat(unattendedOps.map((op) => opLabel(op.key))) });
  if (anyPreauthorized) executesUnattendedText = `${executesUnattendedText} ${t('aiAgentsPage.summary.preauthorizedNote')}`;
  // Act-eligible but held back by a missing prerequisite (`run_script` with
  // no authorized script): the server already downgraded the outcome to an
  // approval request; this says why, so the card never reads as if the
  // operation were simply ineligible (#5048 QA).
  const scriptGatedOps = mutatingOps.filter((op) => op.unattendedBlockedBy === 'authorized_scripts');

  // --- Never touches ---
  // Tagged with which list each entry came from: the three protected-resource
  // lists are independent (a service name and a path can coincidentally be
  // the same string), so a flat `entry` alone is not a stable React key or a
  // unique test-id — two chips from different categories with the same value
  // collided on both.
  const protectedChips = [
    ...preview.protectedResources.services.map((entry) => ({ category: 'services', entry })),
    ...preview.protectedResources.paths.map((entry) => ({ category: 'paths', entry })),
    ...preview.protectedResources.registryKeys.map((entry) => ({ category: 'registryKeys', entry })),
  ];

  // --- Limits (six exposed limits: the five in `limits` plus the sibling `cooldownSeconds`) ---
  const minutesPerRun = Math.round(preview.limits.wallClockSeconds / 60);
  const dailyBudget = formatCurrency(preview.limits.maxBudgetCentsPerDay / 100);
  const fleetPercent = formatPercent(preview.limits.maxFleetPercentPerDay / 100);
  const cooldownMinutes = Math.round(preview.cooldownSeconds / 60);
  // Four of the six numbers carry their own noun, so each is pre-pluralised
  // ("1 device", "2 minutes") before the sentence is assembled (#5048 QA:
  // "Up to 1 devices per run").
  const limitsText = t('aiAgentsPage.summary.limits', {
    devices: t('aiAgentsPage.summary.deviceCount', { count: preview.limits.maxDevicesPerRun }),
    runs: t('aiAgentsPage.summary.runsPerHourCount', { count: preview.limits.maxRunsPerHour }),
    minutes: t('aiAgentsPage.summary.minuteCount', { count: minutesPerRun }),
    budget: dailyBudget,
    fleetPercent,
    cooldown: t('aiAgentsPage.summary.minuteCount', { count: cooldownMinutes }),
  });

  // --- Approvers ---
  const approverRoleIds = preview.recipients.roleIds;
  const approverNames = approverRoleIds.map((id) => recipientRoleNames?.get(id)).filter((name): name is string => !!name);
  let approversText: string;
  if (approverRoleIds.length === 0) approversText = t('aiAgentsPage.summary.approversNone');
  else if (approverNames.length === approverRoleIds.length) {
    approversText = t('aiAgentsPage.summary.approvers', { count: approverNames.length, roles: listFormat(approverNames) });
  } else approversText = t('aiAgentsPage.summary.approversCount', { count: approverRoleIds.length });

  return (
    <div className="rounded-lg border bg-card p-4" data-testid="agent-summary-card">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base font-semibold">{name}</span>
          <span className={badgeClass('neutral', { size: 'sm' })} data-testid="agent-summary-kind">
            {kindLabel}
          </span>
          <span className={badgeClass(orgName === null ? 'info' : 'neutral', { size: 'sm' })} data-testid="agent-summary-org">
            {orgName ?? t('aiAgentsPage.allOrgs')}
          </span>
          <span className={badgeClass(modeTone(preview.mode), { size: 'sm' })} data-testid="agent-summary-mode">
            {modeLabel}
          </span>
          <span className={badgeClass(enabled ? 'success' : 'muted', { size: 'sm' })} data-testid="agent-summary-enabled-pill">
            {enabled ? t('aiAgentsPage.summary.enabled') : t('aiAgentsPage.summary.createdDisabled')}
          </span>
        </div>
        {onEdit && (
          <button
            type="button"
            className="text-xs font-medium text-primary underline-offset-2 hover:underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onEdit('purpose')}
            data-testid="agent-summary-title-edit"
          >
            {editLabel}
          </button>
        )}
      </div>

      <div className="divide-y">
        <SummaryRow id="runsWhen" label={t('aiAgentsPage.summary.rowLabels.runsWhen')} section={ROW_SECTION.runsWhen} onEdit={onEdit} editLabel={editLabel}>
          {runsWhenText}
        </SummaryRow>

        <SummaryRow id="canRead" label={t('aiAgentsPage.summary.rowLabels.canRead')} section={ROW_SECTION.canRead} onEdit={onEdit} editLabel={editLabel}>
          {canReadText}
        </SummaryRow>

        <SummaryRow id="mayPropose" label={t('aiAgentsPage.summary.rowLabels.mayPropose')} section={ROW_SECTION.mayPropose} onEdit={onEdit} editLabel={editLabel}>
          <p>{mayProposeText}</p>
          {mutatingOps.length > 0 && (
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {mutatingOps.map((op) => (
                <li key={op.key} className="flex items-center gap-1" data-testid={`agent-summary-chip-${op.key}`}>
                  <span className={badgeClass(OUTCOME_TONE[op.outcome], { size: 'sm' })}>{opLabel(op.key)}</span>
                  {!op.withinCeiling && <span className={badgeClass('muted', { size: 'sm' })}>{notInCeilingLabel}</span>}
                </li>
              ))}
            </ul>
          )}
          {preview.unrecognised.length > 0 && (
            <div className="mt-1.5" data-testid="agent-summary-unrecognised">
              <p className="text-xs text-muted-foreground">{t('aiAgentsPage.summary.unrecognisedLabel')}</p>
              <ul className="mt-1 flex flex-wrap gap-2">
                {preview.unrecognised.map((entry) => (
                  <li key={entry} className="font-mono text-xs text-muted-foreground" data-testid={`agent-summary-unrecognised-${entry}`}>
                    {entry}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </SummaryRow>

        <SummaryRow
          id="executesUnattended"
          label={t('aiAgentsPage.summary.rowLabels.executesUnattended')}
          section={ROW_SECTION.executesUnattended}
          onEdit={onEdit}
          editLabel={editLabel}
        >
          <p>{executesUnattendedText}</p>
          {scriptGatedOps.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="agent-summary-script-gate">
              {t('aiAgentsPage.summary.scriptGateNote', { list: listFormat(scriptGatedOps.map((op) => opLabel(op.key))) })}
            </p>
          )}
        </SummaryRow>

        <SummaryRow id="neverTouches" label={t('aiAgentsPage.summary.rowLabels.neverTouches')} section={ROW_SECTION.neverTouches} onEdit={onEdit} editLabel={editLabel}>
          {protectedChips.length === 0 ? (
            t('aiAgentsPage.summary.neverTouchesEmpty')
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {protectedChips.map(({ category, entry }) => (
                <li
                  key={`${category}-${entry}`}
                  className="rounded-full border px-2 py-0.5 font-mono text-xs"
                  data-testid={`agent-summary-never-touches-chip-${category}-${entry}`}
                >
                  {entry}
                </li>
              ))}
            </ul>
          )}
        </SummaryRow>

        <SummaryRow id="limits" label={t('aiAgentsPage.summary.rowLabels.limits')} section={ROW_SECTION.limits} onEdit={onEdit} editLabel={editLabel}>
          {limitsText}
        </SummaryRow>

        <SummaryRow id="approvers" label={t('aiAgentsPage.summary.rowLabels.approvers')} section={ROW_SECTION.approvers} onEdit={onEdit} editLabel={editLabel}>
          {approversText}
        </SummaryRow>
      </div>
    </div>
  );
}
