import { useState } from "react";
import { fetchWithAuth } from "../../stores/auth";
import { runAction } from "../../lib/runAction";
import { showToast } from "../shared/Toast";
import { useBulkSelection } from "../billing/bulk/useBulkSelection";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

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
  errors: Array<{ customerId: string; displayName?: string; error: string }>;
}

interface Props {
  onUnauthorized?: () => void;
}

export default function QuickbooksCustomerImport({ onUnauthorized }: Props) {
  const { t } = useTranslation("integrations");
  const [customers, setCustomers] = useState<AnnotatedCustomer[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [failures, setFailures] = useState<ImportSummary["errors"]>([]);
  const selection = useBulkSelection();

  const importable = (customers ?? []).filter((c) => !c.alreadyImported);

  async function load() {
    setLoading(true);
    selection.clear();
    setFailures([]);
    try {
      const data = await runAction<{ data: AnnotatedCustomer[] }>({
        request: () => fetchWithAuth("/accounting/quickbooks/customers"),
        errorFallback: t(
          "quickbooksCustomerImport.failedToLoadQuickBooksCustomers",
        ),
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
      // The endpoint always returns HTTP 200 with a summary (partial success is
      // a feature), so runAction can't tell a total failure from a win — we own
      // the outcome toast here. No `successMessage`: it only emits green.
      const res = await runAction<{ data: ImportSummary }>({
        request: () =>
          fetchWithAuth("/accounting/quickbooks/customers/import", {
            method: "POST",
            body: JSON.stringify({ customerIds }),
          }),
        errorFallback: t("quickbooksCustomerImport.failedToImportCustomers"),
        onUnauthorized,
      });
      const s = res.data;
      const parts = [`${s.imported.length} imported`];
      if (s.skipped.length) parts.push(`${s.skipped.length} skipped`);
      if (s.errors.length) parts.push(`${s.errors.length} failed`);
      const message = parts.join(", ");
      if (s.imported.length === 0 && s.errors.length > 0) {
        showToast({ type: "error", message: `Import failed — ${message}.` });
      } else if (s.errors.length > 0) {
        showToast({ type: "warning", message: `${message}.` });
      } else {
        showToast({ type: "success", message: `${message}.` });
      }
      await load(); // refresh so imported rows flip to "already imported" (clears failures)
      setFailures(s.errors); // re-set after the refresh so they stay visible
    } catch {
      // runAction already toasted the request-level failure (non-200 / thrown).
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
    <div
      data-testid="quickbooks-import-panel"
      className="mt-6 border-t border-gray-200 pt-6"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">
          {t("quickbooksCustomerImport.importCustomers")}
        </h3>
        <button
          type="button"
          data-testid="quickbooks-import-load"
          onClick={load}
          disabled={loading}
          className="rounded-md bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-50"
        >
          {loading
            ? t("quickbooksCustomerImport.loading")
            : customers
              ? t("common:actions.refresh")
              : t("quickbooksCustomerImport.loadCustomers")}
        </button>
      </div>

      {customers && customers.length === 0 && (
        <p
          className="mt-4 text-sm text-gray-500"
          data-testid="quickbooks-import-empty"
        >
          {t("quickbooksCustomerImport.noCustomersFoundInQuickBooks")}
        </p>
      )}

      {customers && customers.length > 0 && (
        <>
          <table
            className="mt-4 w-full text-sm"
            data-testid="quickbooks-import-table"
          >
            <thead>
              <tr className="text-left text-gray-500">
                <th className="w-8">
                  <input
                    type="checkbox"
                    data-testid="quickbooks-import-select-all"
                    aria-label={t("quickbooksCustomerImport.selectAll")}
                    checked={
                      importable.length > 0 &&
                      importable.every((c) => selection.has(c.id))
                    }
                    onChange={toggleSelectAll}
                  />
                </th>
                <th>{t("common:labels.name")}</th>
                <th>{t("quickbooksCustomerImport.email")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr
                  key={c.id}
                  data-testid={`quickbooks-import-row-${c.id}`}
                  className="border-t border-gray-100"
                >
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
                  <td className="py-1.5 text-gray-500">{c.email ?? "—"}</td>
                  <td className="py-1.5">
                    {c.alreadyImported && (
                      <span
                        data-testid={`quickbooks-import-badge-${c.id}`}
                        className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700"
                      >
                        {t("quickbooksCustomerImport.alreadyImported")}
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
              {importing
                ? t("quickbooksCustomerImport.importing")
                : t("quickbooksCustomerImport.importSelected", {
                    count: selection.size,
                  })}
            </button>
          </div>

          {failures.length > 0 && (
            <div
              className="mt-4 rounded-md border border-red-200 bg-red-50 p-3"
              data-testid="quickbooks-import-failures"
            >
              <p className="text-sm font-medium text-red-800">
                {failures.length} {t("quickbooksCustomerImport.customer")}
                {failures.length === 1 ? "" : "s"}{" "}
                {t("quickbooksCustomerImport.failedToImport")}
              </p>
              <ul className="mt-2 space-y-1 text-xs text-red-700">
                {failures.map((f) => (
                  <li
                    key={f.customerId}
                    data-testid={`quickbooks-import-failure-${f.customerId}`}
                  >
                    <span className="font-medium">
                      {f.displayName ?? f.customerId}
                    </span>
                    : {f.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
