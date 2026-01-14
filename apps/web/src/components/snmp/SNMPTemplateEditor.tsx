import { useState } from 'react';
import { FileUp, PlusCircle, Trash2, CheckCircle2, Layers } from 'lucide-react';

type OidRow = {
  id: string;
  oid: string;
  name: string;
  type: string;
  description: string;
};

const initialOids: OidRow[] = [
  {
    id: 'o1',
    oid: '1.3.6.1.2.1.1.3.0',
    name: 'System Uptime',
    type: 'TimeTicks',
    description: 'Device uptime in ticks'
  },
  {
    id: 'o2',
    oid: '1.3.6.1.2.1.2.2.1.10',
    name: 'Interface In Octets',
    type: 'Counter64',
    description: 'Inbound traffic per interface'
  }
];

export default function SNMPTemplateEditor() {
  const [oids, setOids] = useState<OidRow[]>(initialOids);

  const updateOid = (id: string, field: keyof OidRow, value: string) => {
    setOids(prev => prev.map(oid => (oid.id === id ? { ...oid, [field]: value } : oid)));
  };

  const addOid = () => {
    setOids(prev => [
      ...prev,
      {
        id: `oid-${prev.length + 1}`,
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

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted">
            <Layers className="h-6 w-6 text-muted-foreground" />
          </div>
          <div>
            <h2 className="text-xl font-semibold">SNMP Template Editor</h2>
            <p className="text-sm text-muted-foreground">Define which OIDs are collected for a device type.</p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <h3 className="text-lg font-semibold">Template details</h3>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium">Name</label>
            <input
              type="text"
              placeholder="Cisco Core"
              className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Vendor</label>
            <input
              type="text"
              placeholder="Cisco"
              className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Device type</label>
            <input
              type="text"
              placeholder="Core Switch"
              className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Description</label>
            <input
              type="text"
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
          {oids.map(row => (
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
          ))}
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
        <button type="button" className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
          Save template
        </button>
      </div>
    </div>
  );
}
