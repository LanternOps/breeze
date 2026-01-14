import { useState } from 'react';
import { ShieldCheck, Router, KeyRound, User, RefreshCcw, Save } from 'lucide-react';

const templates = [
  'Cisco Core',
  'Cisco Access',
  'Juniper Edge',
  'Fortinet Firewall',
  'NetApp Storage',
  'Generic Router'
];

const authProtocols = ['MD5', 'SHA-1', 'SHA-256'];
const privProtocols = ['DES', 'AES-128', 'AES-256'];

export default function SNMPDeviceEditor() {
  const [version, setVersion] = useState<'v1' | 'v2c' | 'v3'>('v2c');
  const [interval, setInterval] = useState(60);

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted">
            <Router className="h-6 w-6 text-muted-foreground" />
          </div>
          <div>
            <h2 className="text-xl font-semibold">SNMP Device Editor</h2>
            <p className="text-sm text-muted-foreground">Configure how the device is polled and authenticated.</p>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h3 className="text-lg font-semibold">Basic information</h3>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="text-sm font-medium">Device name</label>
                <input
                  type="text"
                  placeholder="Core-Switch-01"
                  className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm font-medium">IP address</label>
                <input
                  type="text"
                  placeholder="10.0.0.10"
                  className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Port</label>
                <input
                  type="number"
                  defaultValue={161}
                  className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Template</label>
                <select className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm">
                  {templates.map(template => (
                    <option key={template} value={template}>
                      {template}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h3 className="text-lg font-semibold">SNMP configuration</h3>
            <div className="mt-4">
              <label className="text-sm font-medium">Version</label>
              <div className="mt-2 flex flex-wrap gap-2">
                {(['v1', 'v2c', 'v3'] as const).map(item => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setVersion(item)}
                    className={`rounded-md border px-3 py-1.5 text-sm font-medium ${
                      version === item
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-muted-foreground/30 text-muted-foreground'
                    }`}
                  >
                    {item.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            {(version === 'v1' || version === 'v2c') && (
              <div className="mt-4">
                <label className="text-sm font-medium">Community string</label>
                <div className="mt-2 flex items-center gap-2">
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                  <input
                    type="password"
                    placeholder="public"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">Used for read-only access with SNMP {version}.</p>
              </div>
            )}

            {version === 'v3' && (
              <div className="mt-4 space-y-4">
                <div>
                  <label className="text-sm font-medium">Username</label>
                  <div className="mt-2 flex items-center gap-2">
                    <User className="h-4 w-4 text-muted-foreground" />
                    <input
                      type="text"
                      placeholder="snmp-admin"
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    />
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="text-sm font-medium">Auth protocol</label>
                    <select className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm">
                      {authProtocols.map(protocol => (
                        <option key={protocol} value={protocol}>
                          {protocol}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-sm font-medium">Auth password</label>
                    <input
                      type="password"
                      className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium">Privacy protocol</label>
                    <select className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm">
                      {privProtocols.map(protocol => (
                        <option key={protocol} value={protocol}>
                          {protocol}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-sm font-medium">Privacy password</label>
                    <input
                      type="password"
                      className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h3 className="text-lg font-semibold">Polling interval</h3>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{interval} seconds</span>
              <span className="text-xs text-muted-foreground">Recommended: 60s</span>
            </div>
            <input
              type="range"
              min={30}
              max={300}
              step={15}
              value={interval}
              onChange={event => setInterval(Number(event.target.value))}
              className="mt-3 w-full"
            />
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h3 className="text-lg font-semibold">Connection test</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Verify connectivity and credentials before saving the device.
            </p>
            <button
              type="button"
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-medium"
            >
              <RefreshCcw className="h-4 w-4" />
              Test connection
            </button>
            <div className="mt-4 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              Last test: Successful handshake with 6 OIDs retrieved.
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h3 className="text-lg font-semibold">Save changes</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Saving will update polling jobs and device inventory.
            </p>
            <button
              type="button"
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              <Save className="h-4 w-4" />
              Save device
            </button>
            <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="h-4 w-4" />
              Credentials are stored in the secrets vault.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
