/**
 * The Recipe Library (Operator Recipe Library W06 R1b, spec §4.1): every
 * recipe this org can run, with its readiness, recomputed by the server on
 * every load. Loading, error (with retry), empty and no-org each render
 * something — never a blank panel.
 *
 * The selected recipe (its start form open) is `#recipe=<key>` in the hash,
 * alongside whatever else the page keeps there.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { AiOperatorWorkflowDto } from '@breeze/shared';
import { useHashState } from '@/lib/useHashState';
import { useOperatorWorkflows } from '@/lib/api/aiOperatorWorkflows';
import RecipeCard from './RecipeCard';
import { readHashParam, writeHashParam } from './operatorHash';

export interface RecipeLibraryProps {
  orgId: string | null;
  /** The start surface for a selected recipe. Absent → the Library only lists. */
  renderStart?: (workflow: AiOperatorWorkflowDto, close: () => void) => ReactNode;
}

export default function RecipeLibrary({ orgId, renderStart }: RecipeLibraryProps) {
  const { t } = useTranslation('aiOperator');
  const library = useOperatorWorkflows(orgId, orgId !== null);
  const [selected, setSelected] = useHashState<string | null>(null, (hash) => readHashParam(hash, 'recipe') ?? undefined);

  const select = (key: string | null) => {
    setSelected(key);
    writeHashParam('recipe', key);
  };

  if (!orgId) {
    return <p data-testid="recipe-library-no-org" className="text-sm text-muted-foreground">{t('workspace.noOrg')}</p>;
  }
  if (library.status === 'idle' || library.status === 'loading') {
    return (
      <div data-testid="recipe-library-loading" className="space-y-3" aria-busy="true">
        <p className="text-sm text-muted-foreground">{t('recipeLibrary.loading')}</p>
        <div className="h-32 animate-pulse rounded-lg border bg-muted/40" />
      </div>
    );
  }
  if (library.status === 'error') {
    return (
      <div data-testid="recipe-library-error" className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{t('recipeLibrary.loadFailed')}</p>
        <button
          type="button"
          data-testid="recipe-library-retry"
          onClick={library.reload}
          className="mt-3 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t('common:actions.retry')}
        </button>
      </div>
    );
  }
  if (library.workflows.length === 0) {
    return <p data-testid="recipe-library-empty" className="text-sm text-muted-foreground">{t('recipeLibrary.empty')}</p>;
  }

  // An unavailable recipe never opens its form, not even from a deep link: a
  // form that cannot submit is worse than none.
  const active = library.workflows.find((w) => w.recipeKey === selected && w.readiness !== 'unavailable') ?? null;

  return (
    <div data-testid="recipe-library" className="space-y-4">
      {active && renderStart && (
        <div data-testid={`recipe-start-panel-${active.recipeKey}`}>{renderStart(active, () => select(null))}</div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {library.workflows.map((w) => (
          <RecipeCard
            key={w.recipeKey}
            workflow={w}
            onStart={renderStart ? (wf) => select(wf.recipeKey) : undefined}
            onChanged={library.reload}
          />
        ))}
      </div>
    </div>
  );
}
