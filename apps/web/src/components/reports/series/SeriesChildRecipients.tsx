import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { handleActionError } from '@/lib/runAction';
import { fetchChildOverrides, fetchOrgContacts, setChildRecipientOverride } from './seriesApi';
import { matchesRecipientRule } from './seriesConfig';
import type { OrgContact, RecipientChoice, SeriesRecipientRule } from './types';

const CHOICES: RecipientChoice[] = ['default', 'add', 'remove'];

/**
 * A series child's only editable surface (spec D5, §3.5): per-contact add /
 * remove overrides on top of the series rule. `rule` is null when the viewer
 * cannot read the series (org users) — then no "Included by rule" hint.
 */
export function SeriesChildRecipients({ reportId, orgId, rule }: { reportId: string; orgId: string; rule: SeriesRecipientRule | null }) {
  const { t } = useTranslation('reports');
  const [contacts, setContacts] = useState<OrgContact[]>([]);
  const [choices, setChoices] = useState<Map<string, RecipientChoice>>(new Map());
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [loadedContacts, overrides] = await Promise.all([fetchOrgContacts(orgId), fetchChildOverrides(reportId)]);
      setContacts(loadedContacts);
      setChoices(new Map(overrides.map((o) => [o.contactId, o.mode])));
      setState('ready');
    } catch (err) {
      console.error('[SeriesChildRecipients] load failed', err);
      setState('failed');
    }
  }, [orgId, reportId]);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (contact: OrgContact, next: RecipientChoice) => {
    const current = choices.get(contact.id) ?? 'default';
    if (next === current) return;
    setBusyId(contact.id);
    try {
      await setChildRecipientOverride(reportId, contact.id, current, next, {
        errorFallback: t('reports.series.child.recipients.updateFailed'),
        successMessage: t('reports.series.child.recipients.updated'),
      });
      setChoices((prev) => new Map(prev).set(contact.id, next));
    } catch (err) {
      handleActionError(err, t('reports.series.child.recipients.updateFailed'));
      // A switch is DELETE-then-POST; after a partial failure only the server knows.
      await load();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section data-testid="series-child-recipients" className="space-y-3 rounded-lg border bg-card p-6 shadow-xs">
      <div>
        <h2 className="text-sm font-semibold">{t('reports.series.child.recipients.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('reports.series.child.recipients.description')}</p>
      </div>
      {state === 'loading' && <Loader2 className="h-5 w-5 animate-spin text-primary" />}
      {state === 'failed' && <p role="status" className="text-sm text-destructive">{t('reports.series.child.recipients.loadFailed')}</p>}
      {state === 'ready' && contacts.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('reports.series.child.recipients.empty')}</p>
      )}
      {state === 'ready' && contacts.length > 0 && (
        <ul className="divide-y">
          {contacts.map((contact) => (
            <li key={contact.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="text-sm">
                {contact.name || contact.email}
                {contact.name && <span className="block text-xs text-muted-foreground">{contact.email}</span>}
                {rule && matchesRecipientRule(contact, rule) && (
                  <span data-testid={`series-child-by-rule-${contact.id}`} className="block text-xs text-primary">
                    {t('reports.series.child.recipients.byRule')}
                  </span>
                )}
              </span>
              <select
                data-testid={`series-child-recipient-${contact.id}`}
                aria-label={contact.name || contact.email || contact.id}
                value={choices.get(contact.id) ?? 'default'}
                disabled={busyId === contact.id}
                onChange={(e) => void change(contact, e.target.value as RecipientChoice)}
                className="h-9 rounded-md border bg-background px-2 text-sm"
              >
                {CHOICES.map((choice) => (
                  <option key={choice} value={choice}>
                    {t(/* i18n-dynamic */ `reports.series.child.recipients.${choice}`)}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
