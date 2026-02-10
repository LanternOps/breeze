import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Pencil, PlusCircle, Trash2, Layers } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type TemplateRow = {
  id: string;
  name: string;
  vendor: string;
  deviceType: string;
  oidCount: number;
  usageCount: number;
  source: 'builtin' | 'custom';
};

type DashboardTemplateUsage = {
  templateId: string | null;
  name: string;
  deviceCount: number;
};

type Props = {
  selectedTemplateId?: string;
  onSelectTemplate?: (templateId: string) => void;
  onCreateTemplate?: () => void;
  refreshToken?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function normalizeTemplate(raw: Record<string, unknown>, usageMap: Map<string, number>): TemplateRow {
  const id = String(raw.id ?? '');
  const source = String(raw.source ?? '').toLowerCase() === 'builtin' ? 'builtin' : 'custom';
  return {
    id,
    name: String(raw.name ?? ''),
    vendor: String(raw.vendor ?? ''),
    deviceType: String(raw.deviceClass ?? raw.deviceType ?? ''),
    oidCount: Number(raw.oidCount ?? (Array.isArray(raw.oids) ? raw.oids.length : 0)),
    usageCount: usageMap.get(id) ?? 0,
    source
  };
}

function parseTemplateUsage(payload: unknown): Map<string, number> {
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  const usageRows = Array.isArray(data?.templateUsage) ? data.templateUsage : [];
  const map = new Map<string, number>();
  usageRows.forEach((item) => {
    const row = asRecord(item);
    const id = row?.templateId;
    const count = row?.deviceCount;
    if (typeof id === 'string') {
      map.set(id, Number(count ?? 0));
    }
  });
  return map;
}

function scrollToEditor() {
  const editor = document.getElementById('snmp-template-editor');
  editor?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export default function SNMPTemplateList({
  selectedTemplateId,
  onSelectTemplate,
  onCreateTemplate,
  refreshToken = 0
}: Props = {}) {
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchTemplates = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);

      const [templatesResponse, dashboardResponse] = await Promise.all([
        fetchWithAuth('/snmp/templates'),
        fetchWithAuth('/snmp/dashboard')
      ]);

      if (templatesResponse.status === 401 || dashboardResponse.status === 401) {
        window.location.href = '/login';
        return;
      }

      if (!templatesResponse.ok) {
        throw new Error('Failed to fetch SNMP templates');
      }

      const templatesPayload = await templatesResponse.json();
      const dashboardPayload = dashboardResponse.ok
        ? await dashboardResponse.json()
        : {};

      const usageMap = parseTemplateUsage(dashboardPayload);
      const rawTemplates = templatesPayload.data ?? templatesPayload.templates ?? [];
      const mappedTemplates = Array.isArray(rawTemplates)
        ? rawTemplates
            .map((item) => {
              const row = asRecord(item);
              return row ? normalizeTemplate(row, usageMap) : null;
            })
            .filter((item): item is TemplateRow => Boolean(item?.id))
        : [];

      setTemplates(mappedTemplates);
    } catch (err) {
      setTemplates([]);
      setError(err instanceof Error ? err.message : 'Failed to load SNMP templates');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTemplates();
  }, [fetchTemplates, refreshToken]);

  const handleSelectTemplate = useCallback((templateId: string) => {
    onSelectTemplate?.(templateId);
    scrollToEditor();
  }, [onSelectTemplate]);

  const handleCreateTemplate = useCallback(() => {
    if (onCreateTemplate) {
      onCreateTemplate();
    } else {
      onSelectTemplate?.('');
    }
    scrollToEditor();
  }, [onCreateTemplate, onSelectTemplate]);

  const handleDeleteTemplate = useCallback(async (template: TemplateRow) => {
    if (template.source === 'builtin') return;
    if (!window.confirm(`Delete template "${template.name}"?`)) return;

    setDeletingId(template.id);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/snmp/templates/${template.id}`, { method: 'DELETE' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const apiError = asRecord(payload)?.error;
        throw new Error(typeof apiError === 'string' ? apiError : 'Failed to delete template');
      }
      await fetchTemplates();
      if (selectedTemplateId === template.id) {
        onCreateTemplate?.();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete template');
    } finally {
      setDeletingId(null);
    }
  }, [fetchTemplates, onCreateTemplate, selectedTemplateId]);

  const sortedTemplates = useMemo(
    () => [...templates].sort((a, b) => a.name.localeCompare(b.name)),
    [templates]
  );

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading SNMP templates...
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">SNMP Templates</h2>
          <p className="text-sm text-muted-foreground">{sortedTemplates.length} templates available</p>
        </div>
        <button
          type="button"
          onClick={handleCreateTemplate}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm"
        >
          <PlusCircle className="h-4 w-4" />
          Add template
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="mt-6 overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3 text-left font-medium">Name</th>
              <th className="px-4 py-3 text-left font-medium">Vendor</th>
              <th className="px-4 py-3 text-left font-medium">Device type</th>
              <th className="px-4 py-3 text-left font-medium">OID count</th>
              <th className="px-4 py-3 text-left font-medium">Usage</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {sortedTemplates.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No SNMP templates found.
                </td>
              </tr>
            ) : (
              sortedTemplates.map((template) => (
                <tr key={template.id} className={`bg-background ${selectedTemplateId === template.id ? 'bg-muted/30' : ''}`}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{template.name}</span>
                      {template.source === 'builtin' && (
                        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          Built-in
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{template.vendor || '—'}</td>
                  <td className="px-4 py-3">{template.deviceType || '—'}</td>
                  <td className="px-4 py-3">{template.oidCount}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                      <Layers className="h-3 w-3" />
                      {template.usageCount}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => handleSelectTemplate(template.id)}
                        className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs"
                      >
                        <Pencil className="h-3 w-3" />
                        Edit
                      </button>
                      {template.source === 'custom' && (
                        <button
                          type="button"
                          disabled={deletingId === template.id}
                          onClick={() => {
                            void handleDeleteTemplate(template);
                          }}
                          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-red-600 disabled:opacity-50"
                        >
                          {deletingId === template.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
