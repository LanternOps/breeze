import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { contactsPage, type ContactOption } from '@/lib/api/callerVerification';

/** Paged picker over the existing org-contacts list (100 per page, explicit "load more"). */
export function ContactPicker({ orgId, value, onChange }: { orgId: string; value: string; onChange: (id: string) => void }) {
  const { t } = useTranslation('callerVerificationTech');
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    contactsPage(orgId, page, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setContacts((prev) => (page === 1 ? res.data : [...prev, ...res.data.filter((c) => !prev.some((p) => p.id === c.id))]));
        setTotal(res.total);
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [orgId, page]);

  if (failed) return <p role="alert" className="text-destructive">{t('errors.loadFailed')}</p>;
  if (!loading && contacts.length === 0) return <p className="text-muted-foreground">{t('modal.noContacts')}</p>;
  return (
    <div className="space-y-1">
      <select data-testid="cv-contact" className="h-9 w-full rounded-md border bg-background px-2" value={value}
        onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('modal.pickContact')}</option>
        {contacts.map((c) => <option key={c.id} value={c.id}>{c.name ?? c.email ?? c.phone ?? c.id}{c.name && c.email ? ` · ${c.email}` : ''}</option>)}
      </select>
      {contacts.length < total && (
        <button type="button" className="text-xs underline disabled:opacity-50" disabled={loading} onClick={() => setPage((p) => p + 1)}>
          {t('modal.loadMore')}
        </button>
      )}
    </div>
  );
}
