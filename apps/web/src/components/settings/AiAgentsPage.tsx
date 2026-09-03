import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Bot, Plus } from 'lucide-react';
import { AI_AGENT_KINDS } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { useDefaultOwnerScope } from '@/hooks/useDefaultOwnerScope';
import { badgeClass, modeTone } from '../aiAgents/statusBadge';
import { Drawer } from '../shared/Drawer';
import { EmptyState } from '../shared/EmptyState';
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
  const allOrgsHintId = useId();

  // Literal keys, not a dynamic `t()` on the token: the closed three-member
  // union is spelled out so the keyUsage guard verifies every label and hint
  // statically (same reason as AiAgentSchedulesSection's `scheduleKindLabel`).
  const KIND_LABEL: Record<(typeof AI_AGENT_KINDS)[number], string> = {
    triage: t('aiAgentsPage.kinds.triage'),
    patch: t('aiAgentsPage.kinds.patch'),
    helpdesk: t('aiAgentsPage.kinds.helpdesk'),
  };
  const KIND_HINT: Record<(typeof AI_AGENT_KINDS)[number], string> = {
    triage: t('aiAgentsPage.kindHints.triage'),
    patch: t('aiAgentsPage.kindHints.patch'),
    helpdesk: t('aiAgentsPage.kindHints.helpdesk'),
  };

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

      {/* The editor used to render INLINE, above the list, which pushed every
          existing agent below the fold the moment you clicked Edit. It opens
          in the app's Drawer instead — the same idiom as the impact-weights
          editor — so the list you are editing against stays on screen. */}
      <Drawer
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.agent ? t('aiAgentsPage.editor.editTitle') : t('aiAgentsPage.editor.newTitle')}
        width="max-w-3xl"
        dataTestId="ai-agent-editor-drawer"
      >
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
      </Drawer>

      {loading && (
        <p className="text-sm text-muted-foreground" data-testid="ai-agents-loading">
          {t('aiAgentsPage.loading')}
        </p>
      )}

      {/* First run, not a blank line of muted text: this is the only place the
          product explains what an agent IS before you are asked to configure
          one, and the safe starting mode is named here rather than discovered
          from the mode cards. */}
      {!loading && !error && agents.length === 0 && (
        <EmptyState
          testId="ai-agents-empty"
          headingLevel={2}
          icon={<Bot className="h-7 w-7" />}
          title={t('aiAgentsPage.emptyState.title')}
          description={t('aiAgentsPage.emptyState.description')}
          action={
            <button
              type="button"
              onClick={() => setEditing({ agent: null })}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
              data-testid="ai-agents-empty-create"
            >
              <Plus className="h-4 w-4" />
              {t('aiAgentsPage.emptyState.action')}
            </button>
          }
          secondary={
            <dl className="mx-auto max-w-md space-y-1 text-left text-xs text-muted-foreground">
              {AI_AGENT_KINDS.map((kind) => (
                <div key={kind} className="flex gap-2">
                  <dt className="font-medium text-foreground">{KIND_LABEL[kind]}</dt>
                  <dd>{KIND_HINT[kind]}</dd>
                </div>
              ))}
            </dl>
          }
        />
      )}

      {agents.length > 0 && (
        <>
        <span id={allOrgsHintId} className="sr-only">{t('aiAgentsPage.allOrgsHint')}</span>
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
                    // `title=` alone is invisible to touch and to keyboard
                    // users, so the explanation is a real described-by node.
                    <span
                      className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary"
                      aria-describedby={allOrgsHintId}
                      data-testid={`ai-agent-allorgs-${agent.id}`}
                    >
                      {t('aiAgentsPage.allOrgs')}
                    </span>
                  )}
                </div>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className={badgeClass(modeTone(agent.mode), { size: 'sm' })}>
                    {t(/* i18n-dynamic */ `aiAgentsPage.modes.${agent.mode}`)}
                  </span>
                  <span className={badgeClass(agent.enabled ? 'success' : 'muted', { size: 'sm' })}>
                    {agent.enabled ? t('aiAgentsPage.stateEnabled') : t('aiAgentsPage.stateDisabled')}
                  </span>
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
        </>
      )}
    </div>
  );
}
