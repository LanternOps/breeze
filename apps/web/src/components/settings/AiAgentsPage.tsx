import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Bot, Plus } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { useDefaultOwnerScope } from '@/hooks/useDefaultOwnerScope';
import AiAgentForm, { type AiAgentDto } from './AiAgentForm';

type Editing = { agent: AiAgentDto | null } | null;

/**
 * Settings → AI Agents (wave 1). An agent is a named policy row, not a running
 * process: nothing executes until a later wave, and `BREEZE_AI_AGENTS_ENABLED`
 * keeps the resolved policy disabled on deployments that have not opted in.
 *
 * Partner-wide rows are invisible to an org session by design — RLS hides them
 * from org tokens — so an org admin manages only their own overrides here and
 * sees the inherited baseline through the effective-policy endpoint.
 */
export default function AiAgentsPage() {
  const { t } = useTranslation('settings');
  const { isPartnerScope, defaultOwnerScope } = useDefaultOwnerScope();

  const [agents, setAgents] = useState<AiAgentDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      // fetchWithAuth appends the selected orgId; the route ignores it and
      // scopes the read through RLS plus the caller's accessible orgs.
      const response = await fetchWithAuth('/ai/agents');
      if (!response.ok) throw new Error(`GET /ai/agents ${response.status}`);
      // response.json() throws on a non-JSON 200 — a gateway error page, a
      // truncated body. Unguarded, that rejection escaped `void load()` with
      // no unhandledrejection handler anywhere, leaving the page in a
      // permanent loading state that renders as an ordinary empty screen.
      const body = (await response.json()) as { data?: unknown };
      // A body we cannot read is an ERROR, not zero agents. `?? []` reported
      // "no agents yet" for a shape change and, worse, told the create form
      // every kind was free — so the next save 409'd on an agent the page had
      // just said did not exist.
      if (!Array.isArray(body.data)) throw new Error('GET /ai/agents: malformed body');
      setAgents(body.data as AiAgentDto[]);
    } catch (err) {
      console.error('[AiAgentsPage] could not load agents', err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6" data-testid="ai-agents-page">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Bot className="h-5 w-5" />
            {t('aiAgentsPage.title')}
          </h1>
          <p className="text-muted-foreground">{t('aiAgentsPage.description')}</p>
        </div>
        <button
          type="button"
          onClick={() => setEditing({ agent: null })}
          className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          data-testid="ai-agent-create-button"
        >
          <Plus className="h-4 w-4" />
          {t('aiAgentsPage.actions.add')}
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {t('aiAgentsPage.errors.load')}
        </div>
      )}

      {editing && (
        <AiAgentForm
          // The draft lives in the form's own state, seeded once at mount. With
          // the list still on screen, switching edit targets kept the previous
          // draft and PATCHed the newly-selected agent with the old agent's
          // policy. Keying on the target remounts it instead.
          key={editing.agent?.id ?? 'new'}
          agent={editing.agent}
          agents={agents}
          showOwnerScope={isPartnerScope}
          defaultOwnerScope={defaultOwnerScope}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}

      {loading && (
        <p className="text-sm text-muted-foreground" data-testid="ai-agents-loading">
          {t('aiAgentsPage.loading')}
        </p>
      )}

      {!loading && !error && agents.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="ai-agents-empty">
          {t('aiAgentsPage.empty')}
        </p>
      )}

      {agents.length > 0 && (
        <ul className="divide-y rounded-lg border" data-testid="ai-agents-list">
          {agents.map((agent) => (
            <li key={agent.id} className="flex flex-wrap items-center gap-3 p-3" data-testid={`ai-agent-row-${agent.id}`}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{agent.name}</span>
                  <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {t(/* i18n-dynamic */ `aiAgentsPage.kinds.${agent.kind}`)}
                  </span>
                  {agent.allOrgs && (
                    <span
                      className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary"
                      title={t('aiAgentsPage.allOrgsHint')}
                      data-testid={`ai-agent-allorgs-${agent.id}`}
                    >
                      {t('aiAgentsPage.allOrgs')}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t(/* i18n-dynamic */ `aiAgentsPage.modes.${agent.mode}`)}
                  {' · '}
                  {agent.enabled ? t('aiAgentsPage.stateEnabled') : t('aiAgentsPage.stateDisabled')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditing({ agent })}
                className="rounded-md border px-3 py-1.5 text-sm font-medium"
                data-testid={`ai-agent-edit-${agent.id}`}
              >
                {t('aiAgentsPage.actions.edit')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
