import { useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction } from '../../lib/runAction';
import { useBulkSelection } from '../billing/bulk/useBulkSelection';

interface AnnotatedCustomer {
  id: string;
  displayName: string;
  email?: string;
  companyName?: string;
  alreadyImported: boolean;
  organizationId: string | null;
}

interface ImportSummary {
  imported: unknown[];
  skipped: unknown[];
  errors: Array<{ customerId: string; error: string }>;
}

interface Props {
  onUnauthorized?: () => void;
}

export default function QuickbooksCustomerImport({ onUnauthorized }: Props) {
  const [customers, setCustomers] = useState<AnnotatedCustomer[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const selection = useBulkSelection();

  const importable = (customers ?? []).filter((c) => !c.alreadyImported);

  async function load() {
    setLoading(true);
    selection.clear();
    try {
      const data = await runAction<{ data: AnnotatedCustomer[] }>({
        request: () => fetchWithAuth('/accounting/quickbooks/customers'),
        errorFallback: 'Failed to load QuickBooks customers.',
        onUnauthorized,
      });
      setCustomers(data.data);
    } catch {
      // runAction already toasted; leave the list as-is.
    } finally {
      setLoading(false);
    }
  }

  async function importSelected() {
    const customerIds = Array.from(selection.selectedIds);
    if (customerIds.length === 0) return;
    setImporting(true);
    try {
      await runAction<{ data: ImportSummary }>({
        request: () => fetchWithAuth('/accounting/quickbooks/customers/import', {
          method: 'POST',
          body: JSON.stringify({ customerIds }),
        }),
        errorFallback: 'Failed to import customers.',
        successMessage: (res) => {
          const s = res.data;
          const parts = [`${s.imported.length} imported`];
          if (s.skipped.length) parts.push(`${s.skipped.length} skipped`);
          if (s.errors.length) parts.push(`${s.errors.length} failed`);
          return parts.join(', ');
        },
        onUnauthorized,
      });
      await load(); // refresh so imported rows flip to "already imported"
    } catch {
      // already toasted
    } finally {
      setImporting(false);
    }
  }

  function toggleSelectAll() {
    if (importable.length > 0 && importable.every((c) => selection.has(c.id))) {
      selection.clear();
    } else {
      selection.selectAll(importable.map((c) => c.id));
    }
  }

  return (
    <div data-testid="quickbooks-import-panel" className="mt-6 border-t border-gray-200 pt-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Import customers</h3>
        <button
          type="button"
          data-testid="quickbooks-import-load"
          onClick={load}
          disabled={loading}
          className="rounded-md bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-50"
        >
          {loading ? 'Loading…' : customers ? 'Refresh' : 'Load customers'}
        </button>
      </div>

      {customers && customers.length === 0 && (
        <p className="mt-4 text-sm text-gray-500" data-testid="quickbooks-import-empty">No customers found in QuickBooks.</p>
      )}

      {customers && customers.length > 0 && (
        <>
          <table className="mt-4 w-full text-sm" data-testid="quickbooks-import-table">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="w-8">
                  <input
                    type="checkbox"
                    data-testid="quickbooks-import-select-all"
                    aria-label="Select all"
                    checked={importable.length > 0 && importable.every((c) => selection.has(c.id))}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th>Name</th>
                <th>Email</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} data-testid={`quickbooks-import-row-${c.id}`} className="border-t border-gray-100">
                  <td>
                    <input
                      type="checkbox"
                      data-testid={`quickbooks-import-select-${c.id}`}
                      checked={selection.has(c.id)}
                      disabled={c.alreadyImported}
                      onChange={() => selection.toggle(c.id)}
                    />
                  </td>
                  <td className="py-1.5 text-gray-900">{c.displayName}</td>
                  <td className="py-1.5 text-gray-500">{c.email ?? '—'}</td>
                  <td className="py-1.5">
                    {c.alreadyImported && (
                      <span data-testid={`quickbooks-import-badge-${c.id}`} className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">
                        Already imported
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-4">
            <button
              type="button"
              data-testid="quickbooks-import-submit"
              onClick={importSelected}
              disabled={importing || selection.size === 0}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {importing ? 'Importing…' : `Import ${selection.size} selected`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
