import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { KEPT_REASONS, PARTNER_WIDE, readImport, type CreatedContact, type ImportSource, type RemoveCreatedContactsResult } from './ticketImportApi';
import { Notice, Panel, buttonDanger, buttonSecondary, formatCount, importFriendly } from './importUi';

/**
 * The contacts this source created (#8313 W6; spec 2026-10-19 §5.13): listed
 * from their links (GET /sources/:id/created-contacts, paged by contact id),
 * each with why a removal would keep it, and removable as a set
 * (POST …/created-contacts/remove, at most 500 per call, any partner-wide
 * admin, refused while a run is active). The runbook's step 6 removes a wrong
 * set and runs again with the option changed. While the source still has
 * "create missing requester contacts" on, the panel says a later run creates
 * removed contacts again (§5.13), next to the removal and after it.
 */
type Props = {
  source: ImportSource;
  nameOfOrg: (orgId: string) => string;
  runActive: boolean;
  /** Opens the mappings step, where the option is turned off. */
  onOpenMappings?: () => void;
};

const PAGE = 100;

export default function CreatedContactsPanel({ source, nameOfOrg, runActive, onOpenMappings }: Props) {
  const { t } = useTranslation('ticketImport');
  const [contacts, setContacts] = useState<CreatedContact[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [result, setResult] = useState<RemoveCreatedContactsResult | null>(null);

  const load = useCallback(async (after: string | null) => {
    setLoading(true);
    setFailed(false);
    const params = new URLSearchParams({ limit: String(PAGE) });
    if (after) params.set('after', after);
    try {
      const page = await readImport<CreatedContact[]>(`/ticket-imports/sources/${source.id}/created-contacts?${params}`);
      setContacts((prev) => (after ? [...prev, ...page.data] : page.data));
      setNext(page.next);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [source.id]);

  useEffect(() => { void load(null); }, [load]);

  // A run that just ended may have created contacts: read the set again.
  const wasActive = useRef(runActive);
  useEffect(() => {
    if (wasActive.current && !runActive) void load(null);
    wasActive.current = runActive;
  }, [runActive, load]);

  const remove = async () => {
    setRemoving(true);
    try {
      const body = await runAction<{ data: RemoveCreatedContactsResult }>({
        request: () => fetchWithAuth(`/ticket-imports/sources/${source.id}/created-contacts/remove`, { ...PARTNER_WIDE, method: 'POST' }),
        errorFallback: t('contacts.removeFailed'),
        friendly: importFriendly(t),
        successMessage: (d) => t('contacts.removedToast', { count: d.data.removed }),
      });
      setResult(body.data);
      void load(null);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('contacts.removeFailed') });
    } finally {
      setRemoving(false);
      setConfirm(false);
    }
  };

  const removable = contacts.filter((c) => c.keptBecause.length === 0).length;
  const createStillOn = source.options.createRequesterContacts === true;
  const recreateHint = t('contacts.recreateHint', { option: t('mappings.createContacts') });
  const removeMessage = next
    ? `${t('contacts.removeMessage', { count: removable })} ${t('contacts.removeMessageMore')}`
    : t('contacts.removeMessage', { count: removable });

  return (
    <Panel
      title={t('contacts.title')}
      testId="ticket-import-contacts"
      actions={contacts.length > 0 ? (
        <button type="button" className={buttonDanger} onClick={() => setConfirm(true)} disabled={removing || runActive}
          data-testid="ticket-import-contacts-remove">{t('contacts.remove')}</button>
      ) : undefined}
    >
      <p className="mb-3 text-sm text-muted-foreground">{t('contacts.intro')}</p>
      {runActive && contacts.length > 0 && <div className="mb-3"><Notice>{t('contacts.runActive')}</Notice></div>}
      {result && (
        <div className="mb-3">
          <Notice tone={result.stoppedBy ? 'warning' : 'success'} testId="ticket-import-contacts-result">
            {t('contacts.result', { removed: result.removed, skipped: result.skipped, remaining: result.remaining })}
            {result.skipped > 0 && (
              <span className="block text-xs">
                {KEPT_REASONS.filter((r) => (result.skippedBy[r] ?? 0) > 0)
                  .map((r) => `${t(/* i18n-dynamic */ `contacts.kept.${r}`)}: ${formatCount(result.skippedBy[r])}`).join(' · ')}
              </span>
            )}
            {result.stoppedBy === 'run_active' && <span className="block text-xs">{t('contacts.stoppedByRun')}</span>}
          </Notice>
        </div>
      )}
      {result && result.removed > 0 && createStillOn && (
        <div className="mb-3">
          <Notice tone="warning" testId="ticket-import-contacts-recreate-hint">
            {recreateHint}
            {onOpenMappings && (
              <button type="button" className="ml-1 font-medium underline underline-offset-2" onClick={onOpenMappings}
                data-testid="ticket-import-contacts-open-mappings">{t('contacts.openMappings')}</button>
            )}
          </Notice>
        </div>
      )}
      {failed && <Notice tone="error" testId="ticket-import-contacts-failed">{t('contacts.loadFailed')}</Notice>}
      {!failed && !loading && contacts.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="ticket-import-contacts-empty">{t('contacts.empty')}</p>
      )}
      {contacts.length > 0 && (
        <div className="max-h-80 overflow-y-auto rounded-md border">
          <table className="w-full text-sm" data-testid="ticket-import-contacts-table">
            <thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-2 py-1 font-medium">{t('contacts.name')}</th>
                <th className="px-2 py-1 font-medium">{t('contacts.email')}</th>
                <th className="px-2 py-1 font-medium">{t('contacts.org')}</th>
                <th className="px-2 py-1 font-medium">{t('contacts.status')}</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.contactId} className="border-t" data-testid={`ticket-import-contact-${c.contactId}`}>
                  <td className="px-2 py-1">{c.name ?? '—'}</td>
                  <td className="px-2 py-1 break-all">{c.email ?? '—'}</td>
                  <td className="px-2 py-1">{nameOfOrg(c.orgId)}</td>
                  <td className="px-2 py-1 text-xs">
                    {c.keptBecause.length === 0
                      ? t('contacts.asImported')
                      : c.keptBecause.map((r) => t(/* i18n-dynamic */ `contacts.kept.${r}`)).join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <button type="button" className={`${buttonSecondary} mt-2`} onClick={() => void load(next)} disabled={loading}
          data-testid="ticket-import-contacts-more">{t('contacts.more')}</button>
      )}

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => void remove()}
        title={t('contacts.removeTitle')}
        message={createStillOn ? `${removeMessage} ${recreateHint}` : removeMessage}
        confirmLabel={t('contacts.remove')}
        isLoading={removing}
        confirmTestId="ticket-import-contacts-remove-confirm"
      />
    </Panel>
  );
}
