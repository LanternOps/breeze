import { useState, useEffect, useCallback } from 'react';
import { Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import {
  DETECTION_CLASSES,
  RISK_LEVELS,
  FINDING_STATUSES,
  RISK_COLORS,
  DATA_TYPE_COLORS,
  STATUS_COLORS,
} from './constants';
import RemediationModal from './RemediationModal';

type Finding = {
  id: string;
  deviceId: string;
  deviceName: string;
  filePath: string;
  dataType: string;
  patternId: string;
  risk: string;
  confidence: number;
  status: string;
  lastSeenAt: string | null;
  createdAt: string | null;
};

type Pagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export default function FindingsTab() {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 25, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  // Filters
  const [dataType, setDataType] = useState('');
  const [risk, setRisk] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');

  // Remediation
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showRemediation, setShowRemediation] = useState(false);

  const fetchFindings = useCallback(async (page = 1) => {
    try {
      setLoading(true);
      setError(undefined);
      const params = new URLSearchParams({ page: String(page), limit: String(pagination.limit) });
      if (dataType) params.set('dataType', dataType);
      if (risk) params.set('risk', risk);
      if (status) params.set('status', status);

      const res = await fetchWithAuth(`/sensitive-data/report?${params}`);
      if (!res.ok) throw new Error('Failed to fetch findings');
      const json = await res.json();
      setFindings(json.data ?? []);
      setPagination(json.pagination ?? { page: 1, limit: 25, total: 0, totalPages: 1 });
      setSelectedIds(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [dataType, risk, status, pagination.limit]);

  useEffect(() => {
    fetchFindings(1);
  }, [dataType, risk, status]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === findings.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(findings.map((f) => f.id)));
    }
  };

  const handleQuickAction = async (findingId: string, action: 'accept_risk' | 'false_positive') => {
    try {
      const res = await fetchWithAuth('/sensitive-data/remediate', {
        method: 'POST',
        body: JSON.stringify({ findingIds: [findingId], action }),
      });
      if (!res.ok) throw new Error('Failed to update finding');
      await fetchFindings(pagination.page);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    }
  };

  const handleRemediationComplete = () => {
    setShowRemediation(false);
    setSelectedIds(new Set());
    fetchFindings(pagination.page);
  };

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select value={dataType} onChange={(e) => setDataType(e.target.value)} className="h-9 rounded-md border bg-background px-3 text-sm">
          <option value="">All Types</option>
          {DETECTION_CLASSES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <select value={risk} onChange={(e) => setRisk(e.target.value)} className="h-9 rounded-md border bg-background px-3 text-sm">
          <option value="">All Risks</option>
          {RISK_LEVELS.map((r) => <option key={r} value={r} className="capitalize">{r}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="h-9 rounded-md border bg-background px-3 text-sm">
          <option value="">All Statuses</option>
          {FINDING_STATUSES.map((s) => <option key={s} value={s} className="capitalize">{s.replace('_', ' ')}</option>)}
        </select>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search file paths..."
            className="h-9 rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        {selectedIds.size > 0 && (
          <button
            type="button"
            onClick={() => setShowRemediation(true)}
            className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Remediate ({selectedIds.size})
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      )}

      {/* Table */}
      <div className="overflow-hidden rounded-lg border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">
                <input
                  type="checkbox"
                  checked={findings.length > 0 && selectedIds.size === findings.length}
                  onChange={toggleAll}
                  className="rounded border-gray-300"
                />
              </th>
              <th className="px-4 py-3">File Path</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Pattern</th>
              <th className="px-4 py-3">Risk</th>
              <th className="px-4 py-3">Confidence</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Device</th>
              <th className="px-4 py-3">Found</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading && (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center">
                  <div className="mx-auto h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
                </td>
              </tr>
            )}
            {!loading && findings.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No findings match the current filters.
                </td>
              </tr>
            )}
            {!loading && findings
              .filter((f) => !search || f.filePath.toLowerCase().includes(search.toLowerCase()))
              .map((f) => (
                <tr key={f.id} className="text-sm hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(f.id)}
                      onChange={() => toggleSelect(f.id)}
                      className="rounded border-gray-300"
                    />
                  </td>
                  <td className="max-w-[200px] truncate px-4 py-3 font-mono text-xs" title={f.filePath}>
                    {f.filePath}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${DATA_TYPE_COLORS[f.dataType] ?? ''}`}>
                      {f.dataType}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{f.patternId}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${RISK_COLORS[f.risk] ?? ''}`}>
                      {f.risk}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs">{(f.confidence * 100).toFixed(0)}%</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${STATUS_COLORS[f.status] ?? ''}`}>
                      {f.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{f.deviceName}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {f.lastSeenAt ? new Date(f.lastSeenAt).toLocaleDateString() : '-'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      {f.status === 'open' && (
                        <>
                          <button
                            type="button"
                            onClick={() => handleQuickAction(f.id, 'accept_risk')}
                            className="rounded border px-2 py-1 text-xs hover:bg-muted"
                            title="Accept Risk"
                          >
                            Accept
                          </button>
                          <button
                            type="button"
                            onClick={() => handleQuickAction(f.id, 'false_positive')}
                            className="rounded border px-2 py-1 text-xs hover:bg-muted"
                            title="Mark False Positive"
                          >
                            FP
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          Showing {findings.length} of {pagination.total} findings
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={pagination.page <= 1}
            onClick={() => fetchFindings(pagination.page - 1)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-50 hover:bg-muted"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span>Page {pagination.page} of {pagination.totalPages}</span>
          <button
            type="button"
            disabled={pagination.page >= pagination.totalPages}
            onClick={() => fetchFindings(pagination.page + 1)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-50 hover:bg-muted"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {showRemediation && (
        <RemediationModal
          findingIds={Array.from(selectedIds)}
          onClose={() => setShowRemediation(false)}
          onComplete={handleRemediationComplete}
        />
      )}
    </div>
  );
}
