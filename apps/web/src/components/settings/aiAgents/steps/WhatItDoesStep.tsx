import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { ALERT_SEVERITIES, type AgentCeilingDto, type AgentToolCatalogDto } from '@breeze/shared';
import CapabilityPicker from '../CapabilityPicker';
import { listField } from '../agentFields';
import { ALERT_SEVERITY_KINDS, lines, toggle, type Draft } from '../agentDraft';

export interface WhatItDoesStepProps {
  draft: Draft;
  patch: (values: Partial<Draft>) => void;
  catalog: AgentToolCatalogDto | null;
  ceiling: AgentCeilingDto | null;
  catalogLoading: boolean;
  /** Scripts the row is effectively authorized to run unattended
   *  (`actAssets.scriptIds` ∩ the partner ceiling), for the picker's
   *  `run_script` outcome. The create flow cannot authorize scripts, so it
   *  leaves this at 0; the edit drawer passes the row's real count. */
  authorizedScriptCount?: number;
}

/**
 * "What it does" — step 2 of the guided create flow (spec §4.6) AND the same
 * block of the edit drawer (`AiAgentForm.tsx`, #5063): "Runs when"
 * (severities for triage, maintenance windows, helpdesk ticket writes) above
 * the capability picker. One rendering per setting, so the two surfaces
 * cannot drift.
 */
export default function WhatItDoesStep({
  draft,
  patch,
  catalog,
  ceiling,
  catalogLoading,
  authorizedScriptCount = 0,
}: WhatItDoesStepProps) {
  const { t } = useTranslation('settings');
  const permissionsHeadingId = useId();
  const usesAlertSeverities = ALERT_SEVERITY_KINDS.has(draft.kind);

  return (
    <div className="space-y-3" data-testid="agent-step-does">
      <fieldset className="space-y-2 rounded-md border p-3">
        <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
          {t('aiAgentsPage.sections.scope')}
        </legend>
        {usesAlertSeverities && (
          <div className="flex flex-wrap gap-3">
            {ALERT_SEVERITIES.map((severity) => (
              <label key={severity} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={draft.severities.includes(severity)}
                  onChange={() => patch({ severities: toggle(draft.severities, severity) })}
                  data-testid={`ai-agent-severity-${severity}`}
                />
                {t(/* i18n-dynamic */ `aiAgentsPage.severities.${severity}`)}
              </label>
            ))}
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.respectMaintenanceWindows}
            onChange={(e) => patch({ respectMaintenanceWindows: e.target.checked })}
            data-testid="ai-agent-respect-maintenance"
          />
          {t('aiAgentsPage.fields.respectMaintenanceWindows')}
        </label>
        {/* P2-4 (#4191) review fix — ticket-triggered runs are admitted with
            `kind: 'helpdesk'` (ticketHelpdeskSubscriber.ts's `admitTriageRun`:
            `createAndEnqueueAgentRun({ kind: 'helpdesk', triggerKind:
            'ticket', profile: 'triage', ... })`), and runService.ts's
            `resolveEffectiveAgentSystem(orgId, kind)` resolves the effective
            policy off THAT `kind` field — never `triage`, which is a different
            agent kind entirely (the drawer's scheduled-sweeps gate IS
            genuinely triage-only; do not copy this gate from that one again).
            Disabled — never hidden — on a partner-wide row: the merge reads
            ONLY the org's own override (effectivePolicy.ts), so a partner
            baseline value can never take effect; hiding it outright would
            look like the field vanished rather than explain why it cannot be
            set here. */}
        {draft.kind === 'helpdesk' && (
          <div className="space-y-1">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.ticketAutonomousWrites}
                disabled={draft.ownerScope !== 'organization'}
                onChange={(e) => patch({ ticketAutonomousWrites: e.target.checked })}
                data-testid="ai-agent-ticket-autonomous-writes"
              />
              {t('aiAgentsPage.fields.ticketAutonomousWrites')}
            </label>
            <p className="pl-6 text-xs text-muted-foreground">
              {t('aiAgentsPage.fields.ticketAutonomousWritesHint')}
            </p>
          </div>
        )}
      </fieldset>

      {/* Permissions carries the widest blast radius of the sections, so it
          gets a real heading rather than one more 12px uppercase legend of
          the same weight as "Limits". A <section> named by its <h3> — a
          `region` landmark screen readers can jump to — and not a
          <fieldset>: <legend>'s content model is phrasing content, so an
          <h3> cannot live inside one. */}
      <section
        className="space-y-2 rounded-md border p-3"
        aria-labelledby={permissionsHeadingId}
        data-testid="ai-agent-permissions"
      >
        <div>
          <h3 id={permissionsHeadingId} className="text-sm font-semibold">{t('aiAgentsPage.sections.permissions')}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('aiAgentsPage.sections.permissionsDescription')}</p>
        </div>
        {catalog ? (
          <CapabilityPicker
            catalog={catalog}
            ceiling={ceiling}
            kind={draft.kind}
            mode={draft.mode}
            entries={lines(draft.toolAllowlist)}
            onChange={(next) => patch({ toolAllowlist: next.join('\n') })}
            authorizedScriptCount={authorizedScriptCount}
          />
        ) : catalogLoading ? (
          <p className="text-xs text-muted-foreground" data-testid="ai-agent-catalog-loading">
            {t('aiAgentsPage.catalog.loading')}
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground" data-testid="ai-agent-catalog-unavailable">
              {t('aiAgentsPage.catalog.catalogUnavailable')}
            </p>
            <p className="text-xs text-muted-foreground">{t('aiAgentsPage.fields.toolAllowlistHint')}</p>
            {listField('ai-agent-toolallowlist', t('aiAgentsPage.fields.toolAllowlist'), draft.toolAllowlist, (v) => patch({ toolAllowlist: v }), 4)}
          </>
        )}
      </section>
    </div>
  );
}
