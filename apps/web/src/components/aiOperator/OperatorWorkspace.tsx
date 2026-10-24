/**
 * The /operator workspace (Operator Recipe Library W06 R1b): Tasks | Library.
 *
 * Tab state is `#tab=…` in the hash. A tab mounts on its first visit and then
 * stays mounted (hidden) so switching back does not refetch or lose state.
 * The Library is for the org currently selected in the org switcher; with no
 * org selected it says so instead of guessing one.
 */
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useHashState } from '@/lib/useHashState';
import { useOrgStore } from '../../stores/orgStore';
import OperatorTaskList from './OperatorTaskList';
import RecipeLibrary from './RecipeLibrary';
import StartRecipeForm from './StartRecipeForm';
import { readHashParam, writeHashParam } from './operatorHash';

const TABS = ['tasks', 'library'] as const;
type Tab = (typeof TABS)[number];

export default function OperatorWorkspace() {
  const { t } = useTranslation('aiOperator');
  const orgId = useOrgStore((s) => s.currentOrgId);
  const [tab, setTab] = useHashState<Tab>('tasks', (hash) => {
    const v = readHashParam(hash, 'tab');
    return (TABS as readonly string[]).includes(v ?? '') ? (v as Tab) : undefined;
  });
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(new Set());
  const seen = new Set<Tab>([...visited, tab]);
  if (seen.size !== visited.size) setVisited(seen);

  const select = (next: Tab) => {
    setTab(next);
    writeHashParam('tab', next);
  };

  const label = (k: Tab) => (k === 'tasks' ? t('workspace.tabs.tasks') : t('workspace.tabs.library'));
  const panel = (k: Tab, body: ReactNode) => (
    <div role="tabpanel" id={`operator-panel-${k}`} aria-labelledby={`operator-tab-${k}`} hidden={tab !== k}>
      {seen.has(k) ? body : null}
    </div>
  );

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label={t('workspace.tabs.label')} className="flex gap-1 border-b">
        {TABS.map((k) => (
          <button
            key={k}
            id={`operator-tab-${k}`}
            type="button"
            role="tab"
            aria-selected={tab === k}
            aria-controls={`operator-panel-${k}`}
            data-testid={`operator-tab-${k}`}
            onClick={() => select(k)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              tab === k ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label(k)}
          </button>
        ))}
      </div>
      {panel('tasks', <OperatorTaskList />)}
      {panel('library', (
        <RecipeLibrary
          orgId={orgId}
          renderStart={orgId
            ? (w, close) => <StartRecipeForm workflow={w} orgId={orgId} launch={{ kind: 'library' }} onClose={close} />
            : undefined}
        />
      ))}
    </div>
  );
}
