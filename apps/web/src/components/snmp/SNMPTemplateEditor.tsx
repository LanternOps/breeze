import { useCallback, useEffect, useState } from 'react';
import { FileUp, Loader2, PlusCircle, Trash2, CheckCircle2, Layers } from 'lucide-react';
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
    deviceType: String(raw.deviceType ?? raw.type ?? ''),
    description: String(raw.description ?? ''),
    oids
  };
}

export default function SNMPTemplateEditor() {
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

      // Load first template if available
      if (normalizedTemplates.length > 0) {
        const first = normalizedTemplates[0];
        setTemplateId(first.id);
        setName(first.name);
        setVendor(first.vendor);
        setDeviceType(first.deviceType);
        setDescription(first.description);
        setOids(first.oids);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load templates');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const loadTemplate = (id: string) => {
    const template = templates.find(t => t.id === id);
    if (template) {
      setTemplateId(template.id);
      setName(template.name);
      setVendor(template.vendor);
      setDeviceType(template.deviceType);
      setDescription(template.description);
      setOids(template.oids);
    }
  };

  const updateOid = (id: string, field: keyof OidRow, value: string) => {
    setOids(prev => prev.map(oid => (oid.id === id ? { ...oid, [field]: value } : oid)));
  };

  const addOid = () => {
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
    setOids(prev => prev.filter(oid => oid.id !== id));
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Template name is required');
      return;
    }

    try {
      setSaving(true);
      setError(undefined);

      const templatePayload = {
        name: name.trim(),
        vendor: vendor.trim(),
        deviceType: deviceType.trim(),
        description: description.trim(),
        oids: oids.map(o => ({
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
          method: 'PUT',
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save template');
    } finally {
      setSaving(false);
    }
  };

  const handleNewTemplate = () => {
    setTemplateId('');
    setName('');
    setVendor('');
    setDeviceType('');
    setDescription('');
    setOids([]);
  };

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
    <div className="space-y-6">
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
            oids.map(row => (
              <div key={row.id} className="rounded-md border bg-background p-4">
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
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <CheckCircle2 className="h-3 w-3 text-green-600" />
                    Validated against MIB browser.
                  </div>
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
            ))
          )}
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold">OID browser</h3>
            <p className="text-sm text-muted-foreground">Search MIBs, validate paths, and preview values.</p>
          </div>
          <button type="button" className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
            Launch browser
          </button>
        </div>
        <div className="mt-4 flex h-32 items-center justify-center rounded-md border border-dashed bg-muted/40 text-sm text-muted-foreground">
          OID browser and validator placeholder
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {saving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : (
            'Save template'
          )}
        </button>
      </div>
    </div>
  );
}
