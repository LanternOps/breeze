import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { TicketRoutingTestResult } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, handleActionError, runAction } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import type { OrgOption } from './TicketRoutingRuleDrawer';
import type { RoutingLookups } from './useTicketRoutingLookups';
import { ROUTING_PRIORITIES, ROUTING_SOURCES } from './ticketRoutingModel';

const inputClass =
  'h-9 w-full rounded-md border bg-background px-2 py-1.5 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring';
const labelClass = 'block text-xs font-medium text-muted-foreground';
const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

interface Props {
  orgs: OrgOption[];
  defaultOrgId: string;
  lookups: RoutingLookups;
}

/**
 * "Test a ticket": POST /ticket-routing-rules/test is a read-only dry run
 * through the same evaluator the create path uses. It is a POST, so it goes
 * through runAction (errors toast) — with no successMessage, since a result
 * panel is the feedback and a "success" toast per probe would be noise.
 */
export default function TicketRoutingTestPanel({ orgs, defaultOrgId, lookups }: Props) {
  const { t } = useTranslation('settings');
  const [orgId, setOrgId] = useState(defaultOrgId);
  const [source, setSource] = useState('email');
  const [subject, setSubject] = useState('');
  const [email, setEmail] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [priority, setPriority] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TicketRoutingTestResult | null>(null);

  const effectiveOrgId = orgId || defaultOrgId || orgs[0]?.id || '';
  const canRun = !running && subject.trim().length > 0 && effectiveOrgId.length > 0;

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canRun) return;
    setRunning(true);
    try {
      const body: Record<string, unknown> = {
        orgId: effectiveOrgId,
        source,
        subject: subject.trim(),
        requesterEmail: email.trim() || null,
        ...(categoryId ? { categoryId } : {}),
        ...(priority ? { priority } : {}),
      };
      const out = await runAction<{ data: TicketRoutingTestResult }>({
        request: () => fetchWithAuth('/ticket-routing-rules/test', { method: 'POST', body: JSON.stringify(body) }),
        errorFallback: t('ticketRouting.test.failed'),
        onUnauthorized: UNAUTHORIZED,
      });
      setResult(out.data);
    } catch (err) {
      setResult(null);
      if (!(err instanceof ActionError)) handleActionError(err, t('ticketRouting.test.failed'));
    } finally {
      setRunning(false);
    }
  };

  const userName = (id: string) => {
    const u = lookups.users.find((x) => x.id === id);
    return u ? u.name || u.email : id;
  };
  const appliedLines: string[] = [];
  if (result) {
    const a = result.applied;
    if (a.assigneeId) appliedLines.push(`${t('ticketRouting.drawer.setAssignee')}: ${userName(a.assigneeId)}`);
    if (a.priority)
      appliedLines.push(
        `${t('ticketRouting.drawer.setPriority')}: ${t(/* i18n-dynamic */ `ticketRouting.priorities.${a.priority}`)}`,
      );
    if (a.categoryId)
      appliedLines.push(
        `${t('ticketRouting.drawer.setCategory')}: ${lookups.categories.find((c) => c.id === a.categoryId)?.name ?? a.categoryId}`,
      );
    if (a.statusId)
      appliedLines.push(
        `${t('ticketRouting.drawer.setStatus')}: ${lookups.statuses.find((s) => s.id === a.statusId)?.name ?? a.statusId}`,
      );
    if (a.tags?.length) appliedLines.push(`${t('ticketRouting.drawer.addTags')}: ${a.tags.join(', ')}`);
  }

  return (
    <section className="space-y-3 rounded-lg border p-4" data-testid="routing-test-panel">
      <div>
        <h3 className="text-sm font-semibold">{t('ticketRouting.test.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('ticketRouting.test.description')}</p>
      </div>
      <form onSubmit={run} className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="routing-test-org">
            {t('ticketRouting.test.org')}
          </label>
          <select
            id="routing-test-org"
            data-testid="routing-test-org"
            className={inputClass}
            value={effectiveOrgId}
            onChange={(e) => setOrgId(e.target.value)}
          >
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="routing-test-source">
            {t('ticketRouting.test.source')}
          </label>
          <select
            id="routing-test-source"
            data-testid="routing-test-source"
            className={inputClass}
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            {ROUTING_SOURCES.map((s) => (
              <option key={s} value={s}>
                {t(/* i18n-dynamic */ `ticketRouting.sources.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass} htmlFor="routing-test-subject">
            {t('ticketRouting.test.subject')}
          </label>
          <input
            id="routing-test-subject"
            data-testid="routing-test-subject"
            className={inputClass}
            maxLength={255}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass} htmlFor="routing-test-email">
            {t('ticketRouting.test.email')}
          </label>
          <input
            id="routing-test-email"
            data-testid="routing-test-email"
            className={inputClass}
            maxLength={320}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="routing-test-category">
            {t('ticketRouting.test.category')}
          </label>
          <select
            id="routing-test-category"
            data-testid="routing-test-category"
            className={inputClass}
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">{t('ticketRouting.test.notChosen')}</option>
            {lookups.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="routing-test-priority">
            {t('ticketRouting.test.priority')}
          </label>
          <select
            id="routing-test-priority"
            data-testid="routing-test-priority"
            className={inputClass}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          >
            <option value="">{t('ticketRouting.test.notChosen')}</option>
            {ROUTING_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {t(/* i18n-dynamic */ `ticketRouting.priorities.${p}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <button
            type="submit"
            data-testid="routing-test-run"
            disabled={!canRun}
            className="h-9 rounded-md border px-4 text-sm font-medium hover:bg-muted disabled:opacity-60"
          >
            {running ? t('ticketRouting.test.running') : t('ticketRouting.test.run')}
          </button>
        </div>
      </form>

      {result && (
        <div data-testid="routing-test-result" className="space-y-2 rounded-md bg-muted/50 p-3 text-sm">
          <p className="font-medium">
            {result.ruleName ? t('ticketRouting.test.matched', { name: result.ruleName }) : t('ticketRouting.test.noMatch')}
          </p>
          {result.ruleName && (
            <div data-testid="routing-test-applied">
              <p className="text-xs font-medium text-muted-foreground">{t('ticketRouting.test.applied')}</p>
              {appliedLines.length > 0 ? (
                <ul className="list-disc pl-5">
                  {appliedLines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">{t('ticketRouting.test.appliedNothing')}</p>
              )}
            </div>
          )}
          {result.skipped.length > 0 && (
            <div data-testid="routing-test-skipped">
              <p className="text-xs font-medium text-muted-foreground">{t('ticketRouting.test.skipped')}</p>
              <ul className="list-disc pl-5">
                {result.skipped.map((s) => (
                  <li key={`${s.action}:${s.reason}`}>
                    {t(/* i18n-dynamic */ `ticketRouting.test.actions.${s.action}`)}
                    {' — '}
                    {t(/* i18n-dynamic */ `ticketRouting.test.reasons.${s.reason}`)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
