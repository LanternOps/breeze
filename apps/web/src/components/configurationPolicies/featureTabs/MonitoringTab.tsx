import { useState, useEffect } from 'react';
import { Activity } from 'lucide-react';
import type { FeatureTabProps } from './types';
import { FEATURE_META } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';

type MonitorType = 'icmp_ping' | 'tcp_port' | 'http_check' | 'dns_check';

type MonitoringSettings = {
  monitorType: MonitorType;
  pollingInterval: number;
  timeout: number;
  // ICMP
  pingCount: number;
  // TCP
  tcpPort: number;
  expectedBanner: string;
  // HTTP
  httpUrl: string;
  httpMethod: string;
  expectedStatus: number;
  expectedBody: string;
  verifySsl: boolean;
  followRedirects: boolean;
  // DNS
  dnsHostname: string;
  dnsRecordType: string;
  dnsExpectedValue: string;
  dnsNameserver: string;
};

const defaults: MonitoringSettings = {
  monitorType: 'icmp_ping',
  pollingInterval: 60,
  timeout: 10,
  pingCount: 3,
  tcpPort: 443,
  expectedBanner: '',
  httpUrl: '',
  httpMethod: 'GET',
  expectedStatus: 200,
  expectedBody: '',
  verifySsl: true,
  followRedirects: true,
  dnsHostname: '',
  dnsRecordType: 'A',
  dnsExpectedValue: '',
  dnsNameserver: '',
};

const monitorTypeOptions: { value: MonitorType; label: string; description: string }[] = [
  { value: 'icmp_ping', label: 'ICMP Ping', description: 'Basic reachability check' },
  { value: 'tcp_port', label: 'TCP Port', description: 'Port connectivity check' },
  { value: 'http_check', label: 'HTTP Check', description: 'HTTP endpoint monitoring' },
  { value: 'dns_check', label: 'DNS Check', description: 'DNS resolution check' },
];

const httpMethods = ['GET', 'POST', 'PUT', 'HEAD', 'OPTIONS'];
const dnsRecordTypes = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'SRV'];

export default function MonitoringTab({ policyId, existingLink, onLinkChanged }: FeatureTabProps) {
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const [settings, setSettings] = useState<MonitoringSettings>(() => ({
    ...defaults,
    ...(existingLink?.inlineSettings as Partial<MonitoringSettings> | undefined),
  }));

  useEffect(() => {
    if (existingLink?.inlineSettings) {
      setSettings((prev) => ({ ...prev, ...(existingLink.inlineSettings as Partial<MonitoringSettings>) }));
    }
  }, [existingLink]);

  const update = <K extends keyof MonitoringSettings>(key: K, value: MonitoringSettings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    clearError();
    const result = await save(existingLink?.id ?? null, {
      featureType: 'monitoring',
      inlineSettings: settings,
    });
    if (result) onLinkChanged(result, 'monitoring');
  };

  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, 'monitoring');
  };

  const meta = FEATURE_META.monitoring;

  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<Activity className="h-5 w-5" />}
      isConfigured={!!existingLink}
      saving={saving}
      error={error}
      onSave={handleSave}
      onRemove={existingLink ? handleRemove : undefined}
    >
      {/* Monitor type */}
      <div>
        <h3 className="text-sm font-semibold">Monitor Type</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {monitorTypeOptions.map((opt) => (
            <label
              key={opt.value}
              className={`flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-sm transition ${
                settings.monitorType === opt.value
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-muted text-muted-foreground hover:text-foreground'
              }`}
            >
              <input
                type="radio"
                name="monitorType"
                value={opt.value}
                checked={settings.monitorType === opt.value}
                onChange={() => update('monitorType', opt.value)}
                className="hidden"
              />
              <span className="font-medium text-foreground">{opt.label}</span>
              <span className="text-xs text-muted-foreground">{opt.description}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Common fields */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="text-sm font-medium">Polling Interval (seconds)</label>
          <input
            type="number"
            min={10}
            max={86400}
            value={settings.pollingInterval}
            onChange={(e) => update('pollingInterval', Number(e.target.value) || 60)}
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div>
          <label className="text-sm font-medium">Timeout (seconds)</label>
          <input
            type="number"
            min={1}
            max={300}
            value={settings.timeout}
            onChange={(e) => update('timeout', Number(e.target.value) || 10)}
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>

      {/* ICMP fields */}
      {settings.monitorType === 'icmp_ping' && (
        <div className="mt-6">
          <label className="text-sm font-medium">Ping Count</label>
          <input
            type="number"
            min={1}
            max={20}
            value={settings.pingCount}
            onChange={(e) => update('pingCount', Number(e.target.value) || 3)}
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-48"
          />
        </div>
      )}

      {/* TCP fields */}
      {settings.monitorType === 'tcp_port' && (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium">Port</label>
            <input
              type="number"
              min={1}
              max={65535}
              value={settings.tcpPort}
              onChange={(e) => update('tcpPort', Number(e.target.value) || 443)}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Expected Banner (optional)</label>
            <input
              value={settings.expectedBanner}
              onChange={(e) => update('expectedBanner', e.target.value)}
              placeholder="SSH-2.0"
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>
      )}

      {/* HTTP fields */}
      {settings.monitorType === 'http_check' && (
        <div className="mt-6 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-sm font-medium">URL</label>
              <input
                value={settings.httpUrl}
                onChange={(e) => update('httpUrl', e.target.value)}
                placeholder="https://example.com/health"
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Method</label>
              <select
                value={settings.httpMethod}
                onChange={(e) => update('httpMethod', e.target.value)}
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                {httpMethods.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">Expected Status Code</label>
              <input
                type="number"
                min={100}
                max={599}
                value={settings.expectedStatus}
                onChange={(e) => update('expectedStatus', Number(e.target.value) || 200)}
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Expected Body (optional)</label>
              <input
                value={settings.expectedBody}
                onChange={(e) => update('expectedBody', e.target.value)}
                placeholder="OK"
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
          <div className="flex gap-6">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={settings.verifySsl} onChange={(e) => update('verifySsl', e.target.checked)} className="h-4 w-4 rounded border-muted" />
              Verify SSL
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={settings.followRedirects} onChange={(e) => update('followRedirects', e.target.checked)} className="h-4 w-4 rounded border-muted" />
              Follow Redirects
            </label>
          </div>
        </div>
      )}

      {/* DNS fields */}
      {settings.monitorType === 'dns_check' && (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium">Hostname</label>
            <input
              value={settings.dnsHostname}
              onChange={(e) => update('dnsHostname', e.target.value)}
              placeholder="example.com"
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Record Type</label>
            <select
              value={settings.dnsRecordType}
              onChange={(e) => update('dnsRecordType', e.target.value)}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {dnsRecordTypes.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className="text-sm font-medium">Expected Value (optional)</label>
            <input
              value={settings.dnsExpectedValue}
              onChange={(e) => update('dnsExpectedValue', e.target.value)}
              placeholder="93.184.216.34"
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Nameserver (optional)</label>
            <input
              value={settings.dnsNameserver}
              onChange={(e) => update('dnsNameserver', e.target.value)}
              placeholder="8.8.8.8"
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>
      )}
    </FeatureTabShell>
  );
}
