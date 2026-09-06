import { useTranslation } from 'react-i18next';
import { ALERT_SEVERITIES, type AgentCeilingDto, type AgentToolCatalogDto } from '@breeze/shared';
import CapabilityPicker from '../CapabilityPicker';
import { ALERT_SEVERITY_KINDS, lines, toggle, type Draft } from '../agentDraft';

const inputCls = 'w-full rounded-md border bg-background px-2.5 py-1.5 text-sm';

export interface WhatItDoesStepProps {
  draft: Draft;
  patch: (values: Partial<Draft>) => void;
  catalog: AgentToolCatalogDto | null;
  ceiling: AgentCeilingDto | null;
  catalogLoading: boolean;
}

/**
 * Step 2 of the guided create flow (spec §4.6): "Runs when" (severities for
 * triage, maintenance windows, helpdesk ticket writes) above the capability
 * picker — same order and test ids as `AiAgentForm.tsx`'s "When it runs"
 * fieldset and Permissions section, so an operator moving between the drawer
 * and the guided flow finds identical controls.
 */
export default function WhatItDoesStep({ draft, patch, catalog, ceiling, catalogLoading }: WhatItDoesStepProps) {
  const { t } = useTranslation('settings');
  const usesAlertSeverities = ALERT_SEVERITY_KINDS.has(draft.kind);

  return (
    <div className="space-y-3">
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

      <section className="space-y-2 rounded-md border p-3" data-testid="ai-agent-permissions">
        <div>
          <h3 className="text-sm font-semibold">{t('aiAgentsPage.sections.permissions')}</h3>
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
            <label className="space-y-1 text-sm">
              <span className="font-medium">{t('aiAgentsPage.fields.toolAllowlist')}</span>
              <textarea
                className={`${inputCls} font-mono`}
                rows={4}
                value={draft.toolAllowlist}
                onChange={(e) => patch({ toolAllowlist: e.target.value })}
                data-testid="ai-agent-toolallowlist"
              />
            </label>
          </>
        )}
      </section>
    </div>
  );
}
