import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { handleActionError } from '../../lib/runAction';
import { runClientAction } from '../../lib/runClientAction';
import { ResponsiveTable, DataCard } from '../shared/ResponsiveTable';
import { Switch } from '../pam/ui';
import { bulkTools, patchSourceTool, type ToolSourceToolDto, type ToolTier } from './api';

const TIERS: ToolTier[] = [1, 2, 3];

/** A tool the assistant can never actually call: removed upstream, or carrying
 *  a name the resolver refuses (`name_not_addressable`, written by discovery).
 *  Enabling it would be a switch that silently does nothing. */
function isUnusable(tool: ToolSourceToolDto): boolean {
  return tool.removedAt !== null || tool.lastError === 'name_not_addressable';
}

/**
 * The discovered tools of one source (#5216 W01 PR C): what the assistant may
 * call, and at what approval bar. Every mutation goes through
 * `runClientAction` (CLAUDE.md, "Web Mutation Handlers"); the bulk actions use
 * the API's own bulk route rather than fanning out per row, so a partial
 * failure is one outcome instead of N silent ones.
 */
export function DiscoveredToolsTable({
  sourceId,
  tools,
  onChanged,
  onTest,
}: {
  sourceId: string;
  tools: ToolSourceToolDto[];
  onChanged: () => void;
  onTest: (tool: ToolSourceToolDto) => void;
}) {
  const { t } = useTranslation('toolSources');
  const [busyId, setBusyId] = useState<string | null>(null);

  const patch = async (tool: ToolSourceToolDto, body: { tier?: ToolTier; enabled?: boolean }) => {
    setBusyId(tool.id);
    try {
      await runClientAction(() => patchSourceTool(fetchWithAuth, sourceId, tool.id, body), {
        errorFallback: t('toasts.toolUpdateFailed'),
        successMessage: t('toasts.toolUpdated'),
      });
      onChanged();
    } catch (err) {
      handleActionError(err, t('toasts.toolUpdateFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const runBulk = async (mode: 'enable_reads' | 'disable_all') => {
    try {
      const result = await runClientAction(() => bulkTools(fetchWithAuth, sourceId, mode), {
        errorFallback: t('toasts.toolUpdateFailed'),
        successMessage: (r) => t('toasts.bulkUpdated', { count: r.updated }),
      });
      if (result) onChanged();
    } catch (err) {
      handleActionError(err, t('toasts.toolUpdateFailed'));
    }
  };

  const flags = (tool: ToolSourceToolDto, surface: 'row' | 'card' = 'row') => (
    <div className="flex flex-wrap gap-1">
      {tool.removedAt && (
        <span data-testid={`tool-${surface}-${tool.id}-flag-removed`} className="rounded-full bg-muted px-2 py-0.5 text-xs">
          {t('tools.removed')}
        </span>
      )}
      {tool.lastError === 'name_not_addressable' && (
        <span
          data-testid={`tool-${surface}-${tool.id}-flag-not-addressable`}
          className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive"
        >
          {t('tools.notAddressable')}
        </span>
      )}
      {tool.reviewNeeded && (
        <span
          data-testid={`tool-${surface}-${tool.id}-flag-review`}
          className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400"
        >
          {t('tools.reviewNeeded')}
        </span>
      )}
    </div>
  );

  // `surface` keeps the mobile card's controls addressable WITHOUT colliding
  // with the table's ids: ResponsiveTable renders both trees and hides one
  // with CSS, so a shared id would match twice in jsdom (and for a screen
  // reader walking the DOM).
  const tierSelect = (tool: ToolSourceToolDto, surface: 'row' | 'card' = 'row') => (
    <select
      data-testid={`tool-${surface}-${tool.id}-tier`}
      aria-label={t('tools.tier')}
      className="h-8 rounded-md border bg-background px-1.5 text-sm"
      value={tool.tier}
      disabled={tool.removedAt !== null || busyId === tool.id}
      onChange={(e) => void patch(tool, { tier: Number(e.target.value) as ToolTier })}
    >
      {TIERS.map((tier) => (
        <option key={tier} value={tier}>
          {/* i18n-dynamic: TIERS is a literal tuple in this file. */}
          {t(/* i18n-dynamic */ `tools.tier${tier}`)}
        </option>
      ))}
    </select>
  );

  const enabledSwitch = (tool: ToolSourceToolDto, surface: 'row' | 'card' = 'row') => (
    <Switch
      checked={tool.enabled}
      testId={`tool-${surface}-${tool.id}-enabled`}
      ariaLabel={t('tools.enabled')}
      disabled={isUnusable(tool) || busyId === tool.id}
      onToggle={() => void patch(tool, { enabled: !tool.enabled })}
    />
  );

  const testButton = (tool: ToolSourceToolDto, surface: 'row' | 'card' = 'row') =>
    tool.tier === 1 && !isUnusable(tool) ? (
      <button
        type="button"
        data-testid={`tool-${surface}-${tool.id}-test`}
        className="h-8 rounded-md border px-2 text-sm"
        onClick={() => onTest(tool)}
      >
        {t('tools.test')}
      </button>
    ) : null;

  if (tools.length === 0) {
    return (
      <p data-testid="tools-empty" className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        {t('tools.empty')}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end gap-2">
        <button type="button" data-testid="tools-enable-reads" className="h-8 rounded-md border px-2 text-sm" onClick={() => void runBulk('enable_reads')}>
          {t('tools.enableReads')}
        </button>
        <button type="button" data-testid="tools-disable-all" className="h-8 rounded-md border px-2 text-sm" onClick={() => void runBulk('disable_all')}>
          {t('tools.disableAll')}
        </button>
      </div>

      <ResponsiveTable
        table={
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-2">{t('tools.name')}</th>
                <th className="p-2">{t('tools.description')}</th>
                <th className="p-2">{t('tools.proposedTier')}</th>
                <th className="p-2">{t('tools.tier')}</th>
                <th className="p-2">{t('tools.enabled')}</th>
                <th className="p-2">{t('tools.flags')}</th>
                <th className="p-2">{t('tools.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((tool) => (
                <tr key={tool.id} data-testid={`tool-row-${tool.id}`} className="border-t">
                  <td className="p-2 font-mono text-xs">{tool.qualifiedName}</td>
                  <td className="max-w-xs truncate p-2" title={tool.description}>{tool.description}</td>
                  <td className="p-2" data-testid={`tool-row-${tool.id}-proposed`}>{tool.proposedTier}</td>
                  <td className="p-2">{tierSelect(tool)}</td>
                  <td className="p-2">{enabledSwitch(tool)}</td>
                  <td className="p-2">{flags(tool)}</td>
                  <td className="p-2">{testButton(tool)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        }
        cards={
          <>
            {tools.map((tool) => (
              <DataCard key={tool.id}>
                <div className="space-y-2">
                  <p className="font-mono text-xs">{tool.qualifiedName}</p>
                  <p className="text-sm text-muted-foreground">{tool.description}</p>
                  <div className="flex items-center gap-2">
                    {tierSelect(tool, 'card')}
                    {enabledSwitch(tool, 'card')}
                    {testButton(tool, 'card')}
                  </div>
                  {flags(tool, 'card')}
                </div>
              </DataCard>
            ))}
          </>
        }
      />
    </div>
  );
}
