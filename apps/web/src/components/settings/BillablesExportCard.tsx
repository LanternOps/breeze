import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function firstOfMonth(): string {
  const d = new Date();
  return localDateStr(new Date(d.getFullYear(), d.getMonth(), 1));
}
function today(): string {
  return localDateStr(new Date());
}

export default function BillablesExportCard() {
  const { t } = useTranslation('settings');
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [orgId, setOrgId] = useState('');
  const [orgs, setOrgs] = useState<Array<{ id: string; name: string }>>([]);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    void fetchWithAuth('/orgs/organizations?limit=100')
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => { if (b?.data) setOrgs(b.data); })
      .catch(() => {});
  }, []);

  const download = async () => {
    setDownloading(true);
    try {
      const qs = new URLSearchParams({ from, to });
      if (orgId) qs.set('orgId', orgId);
      const res = await fetchWithAuth(`/tickets/export/billables.csv?${qs.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        showToast({ type: 'error', message: (body as { error?: string } | null)?.error ?? t('billablesExport.exportFailed') });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `billables-${from}-to-${to}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      showToast({ type: 'error', message: t('billablesExport.exportFailed') });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <section className="mt-6 rounded-lg border p-4" data-testid="billables-export-card">
      <h2 className="mb-1 text-sm font-semibold">{t('billablesExport.title')}</h2>
      <p className="mb-3 text-xs text-muted-foreground">{t('billablesExport.description')}</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">
          {t('billablesExport.from')}
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-0.5 block rounded-md border bg-background px-2 py-1.5 text-sm" data-testid="billables-export-from" />
        </label>
        <label className="text-xs">
          {t('billablesExport.to')}
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-0.5 block rounded-md border bg-background px-2 py-1.5 text-sm" data-testid="billables-export-to" />
        </label>
        <label className="text-xs">
          {t('common:labels.organization')}
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="mt-0.5 block rounded-md border bg-background px-2 py-1.5 text-sm" data-testid="billables-export-org">
            <option value="">{t('billablesExport.allOrganizations')}</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => void download()} disabled={downloading} className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50" data-testid="billables-export-download">
          {downloading ? t('billablesExport.exporting') : t('billablesExport.downloadCsv')}
        </button>
      </div>
    </section>
  );
}
