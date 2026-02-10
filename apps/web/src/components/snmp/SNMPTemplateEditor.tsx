import { useCallback, useEffect, useState } from 'react';
import { FileUp, Loader2, PlusCircle, Trash2, CheckCircle2, Layers, Search, Copy, AlertCircle } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type OidRow = {
  id: string;
  oid: string;
  name: string;
  type: string;
  description: string;
};

type Template = {
  id: string;
  name: string;
  vendor: string;
  deviceType: string;
  description: string;
  oids: OidRow[];
};

type OidLookupResult = {
  oid: string;
  name: string;
  type: string;
  description: string;
  source?: string;
};

type OidValidationResult = {
  id?: string;
  oid: string;
  valid: boolean;
  errors?: string[];
  warnings?: string[];
};

type Props = {
  selectedTemplateId?: string;
  refreshToken?: number;
  onTemplateSaved?: (templateId: string) => void;
};

function normalizeOid(raw: Record<string, unknown>, index: number): OidRow {
  return {
    id: String(raw.id ?? `oid-${index}`),
    oid: String(raw.oid ?? raw.objectId ?? ''),
    name: String(raw.name ?? raw.metricName ?? ''),
    type: String(raw.type ?? raw.dataType ?? 'Gauge'),
    description: String(raw.description ?? '')
  };
}

function normalizeTemplate(raw: Record<string, unknown>): Template {
  const oidsRaw = raw.oids ?? raw.metrics ?? [];
  const oids = Array.isArray(oidsRaw)
    ? oidsRaw.map((o: Record<string, unknown>, i: number) => normalizeOid(o, i))
    : [];

  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    vendor: String(raw.vendor ?? ''),
    deviceType: String(raw.deviceType ?? raw.deviceClass ?? raw.type ?? ''),
    description: String(raw.description ?? ''),
    oids
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function parseOidLookup(payload: unknown): OidLookupResult[] {
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  const rawResults = Array.isArray(data?.results)
    ? data.results
    : Array.isArray(root?.results)
      ? root.results
      : [];

  return rawResults
    .map((item) => {
      const row = asRecord(item);
      if (!row) return null;

      const oid = String(row.oid ?? '').trim();
      if (!oid) return null;

      return {
        oid,
        name: String(row.name ?? 'Unnamed OID'),
        type: String(row.type ?? 'Gauge'),
        description: String(row.description ?? ''),
        source: String(row.source ?? '')
      } satisfies OidLookupResult;
    })
    .filter((item): item is OidLookupResult => item !== null);
}

function parseOidValidation(payload: unknown): OidValidationResult[] {
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  const rawResults = Array.isArray(data?.results)
    ? data.results
    : Array.isArray(root?.results)
      ? root.results
      : [];

  return rawResults
    .map((item) => {
      const row = asRecord(item);
      if (!row) return null;

      return {
        id: row.id ? String(row.id) : undefined,
        oid: String(row.oid ?? ''),
        valid: Boolean(row.valid),
        errors: Array.isArray(row.errors) ? row.errors.map(error => String(error)) : [],
        warnings: Array.isArray(row.warnings) ? row.warnings.map(warning => String(warning)) : []
      } satisfies OidValidationResult;
    })
    .filter((item): item is OidValidationResult => item !== null);
}

export default function SNMPTemplateEditor({ selectedTemplateId, refreshToken = 0, onTemplateSaved }: Props = {}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [templateId, setTemplateId] = useState<string>('');
  const [templates, setTemplates] = useState<Template[]>([]);

  const [name, setName] = useState('');
  const [vendor, setVendor] = useState('');
  const [deviceType, setDeviceType] = useState('');
  const [description, setDescription] = useState('');
  const [oids, setOids] = useState<OidRow[]>([]);
  const [oidQuery, setOidQuery] = useState('');
  const [oidSearchResults, setOidSearchResults] = useState<OidLookupResult[]>([]);
  const [oidSearchLoading, setOidSearchLoading] = useState(false);
  const [oidSearchError, setOidSearchError] = useState<string>();
  const [validating, setValidating] = useState(false);
  const [oidValidationResults, setOidValidationResults] = useState<OidValidationResult[]>([]);

  const handleNewTemplate = useCallback(() => {
    setTemplateId('');
    setName('');
    setVendor('');
    setDeviceType('');
    setDescription('');
    setOids([]);
    setOidValidationResults([]);
  }, []);

  const applyTemplate = useCallback((template: Template) => {
    setTemplateId(template.id);
    setName(template.name);
    setVendor(template.vendor);
    setDeviceType(template.deviceType);
    setDescription(template.description);
    setOids(template.oids);
    setOidValidationResults([]);
  }, []);

  const fetchTemplates = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);

      const response = await fetchWithAuth('/snmp/templates');

      if (!response.ok) {
        throw new Error('Failed to fetch SNMP templates');
      }

      const payload = await response.json();
      const rawTemplates = payload.data ?? payload.templates ?? payload ?? [];
      const normalizedTemplates = Array.isArray(rawTemplates)
        ? rawTemplates.map((t: Record<string, unknown>) => normalizeTemplate(t))
        : [];

      setTemplates(normalizedTemplates);

      if (normalizedTemplates.length === 0) {
        setTemplateId('');
        return;
      }

      if (selectedTemplateId === '') {
        handleNewTemplate();
        return;
      }

      const preferredTemplate = selectedTemplateId
        ? normalizedTemplates.find((template) => template.id === selectedTemplateId)
        : normalizedTemplates[0];
      if (preferredTemplate) {
        applyTemplate(preferredTemplate);
      } else {
        applyTemplate(normalizedTemplates[0]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load templates');
    } finally {
      setLoading(false);
    }
  }, [applyTemplate, handleNewTemplate, selectedTemplateId]);

  useEffect(() => {
    void fetchTemplates();
  }, [fetchTemplates, refreshToken]);

  useEffect(() => {
    if (selectedTemplateId === '') {
      handleNewTemplate();
      return;
    }

    if (!selectedTemplateId) return;
    const template = templates.find((entry) => entry.id === selectedTemplateId);
    if (template) {
      applyTemplate(template);
    }
  }, [selectedTemplateId, templates, applyTemplate]);

  const fetchOidBrowserResults = useCallback(async (query: string) => {
    try {
      setOidSearchLoading(true);
      setOidSearchError(undefined);

      const params = new URLSearchParams();
      if (query.trim()) {
        params.set('query', query.trim());
      }
      params.set('limit', '25');

      const response = await fetchWithAuth(`/snmp/oids/browse?${params.toString()}`);
      if (!response.ok) {
        throw new Error('Failed to load OID browser results');
      }

      const payload = await response.json();
      setOidSearchResults(parseOidLookup(payload));
    } catch (err) {
      setOidSearchResults([]);
      setOidSearchError(err instanceof Error ? err.message : 'Failed to load OID browser results');
    } finally {
      setOidSearchLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchOidBrowserResults(oidQuery);
    }, 250);

    return () => window.clearTimeout(timer);
  }, [fetchOidBrowserResults, oidQuery]);

  const loadTemplate = (id: string) => {
    const template = templates.find(t => t.id === id);
    if (template) {
      applyTemplate(template);
    }
  };

  const updateOid = (id: string, field: keyof OidRow, value: string) => {
    setOidValidationResults(prev => prev.filter(result => result.id !== id));
    setOids(prev => prev.map(oid => (oid.id === id ? { ...oid, [field]: value } : oid)));
  };

  const addOid = () => {
    setOidValidationResults([]);
    setOids(prev => [
      ...prev,
      {
        id: `oid-new-${Date.now()}`,
        oid: '',
        name: '',
        type: 'Gauge',
        description: ''
      }
    ]);
  };

  const removeOid = (id: string) => {
    setOidValidationResults(prev => prev.filter(result => result.id !== id));
    setOids(prev => prev.filter(oid => oid.id !== id));
  };

  const copyOid = async (oid: string) => {
    try {
      await navigator.clipboard.writeText(oid);
    } catch {
      setError('Failed to copy OID to clipboard');
    }
  };

  const addOidFromBrowser = (entry: OidLookupResult) => {
    setOidValidationResults([]);
    setOids((prev) => {
      const existing = prev.find((row) => row.oid.trim() === entry.oid.trim());
      if (existing) {
        return prev.map((row) => (
          row.id === existing.id
            ? {
                ...row,
                name: row.name || entry.name,
                type: row.type || entry.type,
                description: row.description || entry.description
              }
            : row
        ));
      }

      return [
        ...prev,
        {
          id: `oid-new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          oid: entry.oid,
          name: entry.name,
          type: entry.type || 'Gauge',
          description: entry.description
        }
      ];
    });
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Template name is required');
      return;
    }

    try {
      setSaving(true);
      setValidating(true);
      setError(undefined);
      setOidValidationResults([]);

      const oidPayload = oids
        .map((row) => ({
          id: row.id,
          oid: row.oid.trim(),
          name: row.name.trim(),
          type: row.type.trim(),
          description: row.description.trim()
        }))
        .filter((row) => row.oid.length > 0);

      if (oidPayload.length === 0) {
        throw new Error('At least one OID is required');
      }

      const validationResponse = await fetchWithAuth('/snmp/oids/validate', {
        method: 'POST',
        body: JSON.stringify({ oids: oidPayload })
      });

      if (!validationResponse.ok) {
        throw new Error('Failed to validate OIDs');
      }

      const validationPayload = await validationResponse.json();
      const validationResults = parseOidValidation(validationPayload);
      setOidValidationResults(validationResults);

      const invalidResults = validationResults.filter((result) => !result.valid);
      if (invalidResults.length > 0) {
        const first = invalidResults[0];
        throw new Error(first.errors?.[0] ?? `OID validation failed for ${first.oid}`);
      }

      const templatePayload = {
        name: name.trim(),
        vendor: vendor.trim(),
        deviceType: deviceType.trim(),
        description: description.trim(),
        oids: oidPayload.map(o => ({
          oid: o.oid,
          name: o.name,
          type: o.type,
          description: o.description
        }))
      };

      let response: Response;
      if (templateId) {
        // Update existing template
        response = await fetchWithAuth(`/snmp/templates/${templateId}`, {
          method: 'PATCH',
          body: JSON.stringify(templatePayload)
        });
      } else {
        // Create new template
        response = await fetchWithAuth('/snmp/templates', {
          method: 'POST',
          body: JSON.stringify(templatePayload)
        });
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error ?? errorData.message ?? 'Failed to save template');
      }

      const result = await response.json();
      const savedTemplate = normalizeTemplate(result.data ?? result);

      // Update local state
      if (templateId) {
        setTemplates(prev => prev.map(t => (t.id === templateId ? savedTemplate : t)));
      } else {
        setTemplates(prev => [...prev, savedTemplate]);
        setTemplateId(savedTemplate.id);
      }
      onTemplateSaved?.(savedTemplate.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save template');
    } finally {
      setValidating(false);
      setSaving(false);
    }
  };

  const validationById = new Map(
    oidValidationResults
      .filter(result => result.id)
      .map(result => [result.id as string, result])
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">Loading SNMP templates...</p>
        </div>
      </div>
    );
  }

  return (
    <div id="snmp-template-editor" className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted">
              <Layers className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <h2 className="text-xl font-semibold">SNMP Template Editor</h2>
              <p className="text-sm text-muted-foreground">Define which OIDs are collected for a device type.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {templates.length > 0 && (
              <select
                value={templateId}
                onChange={e => loadTemplate(e.target.value)}
                className="h-10 rounded-md border bg-background px-3 text-sm"
              >
                <option value="">Select template...</option>
                {templates.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={handleNewTemplate}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted"
            >
              <PlusCircle className="h-4 w-4" />
              New Template
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <h3 className="text-lg font-semibold">Template details</h3>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Cisco Core"
              className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Vendor</label>
            <input
              type="text"
              value={vendor}
              onChange={e => setVendor(e.target.value)}
              placeholder="Cisco"
              className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Device type</label>
            <input
              type="text"
              value={deviceType}
              onChange={e => setDeviceType(e.target.value)}
              placeholder="Core Switch"
              className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Description</label>
            <input
              type="text"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="High-throughput switches with multiple uplinks"
              className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-lg font-semibold">OID list</h3>
            <p className="text-sm text-muted-foreground">Configure the OIDs that power metrics and thresholds.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <FileUp className="h-4 w-4" />
              Import from file
            </button>
            <button
              type="button"
              onClick={addOid}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
            >
              <PlusCircle className="h-4 w-4" />
              Add OID
            </button>
          </div>
        </div>

        <div className="mt-4 space-y-4">
          {oids.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No OIDs configured. Click "Add OID" to get started.
            </div>
          ) : (
            oids.map(row => {
              const validation = validationById.get(row.id);
              const hasValidationError = validation ? !validation.valid : false;
              const validationWarnings = validation?.warnings ?? [];

              return (
                <div
                  key={row.id}
                  className={`rounded-md border bg-background p-4 ${hasValidationError ? 'border-destructive/60' : ''}`}
                >
                  <div className="grid gap-3 md:grid-cols-4">
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">OID</label>
                      <input
                        type="text"
                        value={row.oid}
                        onChange={event => updateOid(row.id, 'oid', event.target.value)}
                        placeholder="1.3.6.1.2.1.1.3.0"
                        className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Name</label>
                      <input
                        type="text"
                        value={row.name}
                        onChange={event => updateOid(row.id, 'name', event.target.value)}
                        placeholder="System Uptime"
                        className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Type</label>
                      <select
                        value={row.type}
                        onChange={event => updateOid(row.id, 'type', event.target.value)}
                        className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
                      >
                        <option>Gauge</option>
                        <option>Counter64</option>
                        <option>TimeTicks</option>
                        <option>Integer</option>
                        <option>OctetString</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Description</label>
                      <input
                        type="text"
                        value={row.description}
                        onChange={event => updateOid(row.id, 'description', event.target.value)}
                        placeholder="What this OID measures"
                        className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
                      />
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    {validation ? (
                      <div className={`flex items-center gap-2 text-xs ${validation.valid ? 'text-green-700' : 'text-destructive'}`}>
                        {validation.valid ? (
                          <CheckCircle2 className="h-3 w-3 text-green-600" />
                        ) : (
                          <AlertCircle className="h-3 w-3" />
                        )}
                        {validation.valid
                          ? (validationWarnings[0] ?? 'Validated')
                          : (validation.errors?.[0] ?? 'OID validation failed')}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <AlertCircle className="h-3 w-3" />
                        Not validated yet
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => removeOid(row.id)}
                      className="inline-flex items-center gap-1 text-xs text-red-600"
                    >
                      <Trash2 className="h-3 w-3" />
                      Remove
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold">OID browser</h3>
            <p className="text-sm text-muted-foreground">Search available OIDs and add them to this template.</p>
          </div>
          <button
            type="button"
            onClick={() => void fetchOidBrowserResults(oidQuery)}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted"
          >
            Refresh
          </button>
        </div>
        <div className="mt-4">
          <label className="text-xs font-medium text-muted-foreground">Search by OID or name</label>
          <div className="mt-2 flex items-center rounded-md border bg-background px-3">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              type="search"
              value={oidQuery}
              onChange={event => setOidQuery(event.target.value)}
              placeholder="e.g. 1.3.6.1.2.1.1.3.0 or sysUpTime"
              className="h-10 w-full bg-transparent px-2 text-sm outline-none"
            />
          </div>
        </div>
        {oidSearchError && (
          <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {oidSearchError}
          </div>
        )}
        <div className="mt-4 max-h-72 space-y-2 overflow-y-auto">
          {oidSearchLoading ? (
            <div className="flex items-center gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading OID browser...
            </div>
          ) : oidSearchResults.length === 0 ? (
            <div className="rounded-md border border-dashed bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
              No matching OIDs found.
            </div>
          ) : (
            oidSearchResults.map(result => (
              <div key={`${result.oid}-${result.name}`} className="rounded-md border bg-background px-3 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">{result.name}</p>
                    <p className="font-mono text-xs text-muted-foreground">{result.oid}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{result.description || 'No description provided.'}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void copyOid(result.oid)}
                      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
                    >
                      <Copy className="h-3 w-3" />
                      Copy
                    </button>
                    <button
                      type="button"
                      onClick={() => addOidFromBrowser(result)}
                      className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground"
                    >
                      <PlusCircle className="h-3 w-3" />
                      Add
                    </button>
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="rounded-full border bg-muted px-2 py-0.5">{result.type}</span>
                  {result.source && <span className="rounded-full border bg-muted px-2 py-0.5">{result.source}</span>}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || validating}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {saving || validating ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {validating ? 'Validating OIDs...' : 'Saving...'}
            </>
          ) : (
            'Save template'
          )}
        </button>
      </div>
    </div>
  );
}
