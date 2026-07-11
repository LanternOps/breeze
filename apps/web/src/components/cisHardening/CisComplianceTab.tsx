import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Loader2, Search } from 'lucide-react';
import { friendlyFetchError } from '@/lib/utils';
import { fetchWithAuth } from '@/stores/auth';
import CisComplianceRow from './CisComplianceRow';
import type { ComplianceEntry } from './types';

interface CisComplianceTabProps {
  refreshKey: number;
}

export default function CisComplianceTab({ refreshKey }: CisComplianceTabProps) {
  const { t } = useTranslation('security');
  const [entries, setEntries] = useState<ComplianceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState('');
  const [osFilter, setOsFilter] = useState('all');
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    setError(undefined);
    setLoading(true);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const params = new URLSearchParams({ limit: '200' });
      if (osFilter !== 'all') params.set('osType', osFilter);

      const response = await fetchWithAuth(`/cis/compliance?${params.toString()}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

      const payload = await response.json();
      const data: ComplianceEntry[] = Array.isArray(payload.data) ? payload.data : [];
      data.sort((a, b) => a.result.score - b.result.score);
      setEntries(data);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [osFilter]);

  useEffect(() => {
    fetchData();
    return () => abortRef.current?.abort();
  }, [fetchData, refreshKey]);

  const filtered = search.trim()
    ? entries.filter(
        (e) =>
          e.device.hostname.toLowerCase().includes(search.toLowerCase()) ||
          e.baseline.name.toLowerCase().includes(search.toLowerCase())
      )
    : entries;

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            placeholder={t('cisHardeningCisComplianceTab.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
        </div>
        <select
          value={osFilter}
          onChange={(e) => setOsFilter(e.target.value)}
          className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        >
          <option value="all">{t('cisHardeningCisComplianceTab.os.all')}</option>
          <option value="windows">{t('cisHardeningCisComplianceTab.os.windows')}</option>
          <option value="macos">{t('cisHardeningCisComplianceTab.os.macos')}</option>
          <option value="linux">{t('cisHardeningCisComplianceTab.os.linux')}</option>
        </select>
      </div>

      <div className="mt-4 overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="w-8 px-4 py-3" />
              <th className="px-4 py-3">{t('cisHardeningCisComplianceTab.table.device')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisComplianceTab.table.baseline')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisComplianceTab.table.os')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisComplianceTab.table.score')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisComplianceTab.table.failedChecks')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisComplianceTab.table.lastScanned')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('cisHardeningCisComplianceTab.loading')}
                  </span>
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {t('cisHardeningCisComplianceTab.empty')}
                </td>
              </tr>
            ) : (
              filtered.map((entry) => (
                <CisComplianceRow key={entry.result.id} entry={entry} />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
