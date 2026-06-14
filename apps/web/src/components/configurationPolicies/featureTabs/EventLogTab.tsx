import { useState, useEffect } from 'react';
import { ScrollText } from 'lucide-react';
import type { FeatureTabProps } from './types';
import { FEATURE_META } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';

type EventLogSettings = {
  retentionDays: number;
  maxEventsPerCycle: number;
  collectCategories: string[];
  minimumLevel: 'info' | 'warning' | 'error' | 'critical';
  collectionIntervalMinutes: number;
  rateLimitPerHour: number;
};

const defaults: EventLogSettings = {
  retentionDays: 30,
  maxEventsPerCycle: 100,
  collectCategories: ['security', 'hardware', 'application', 'system'],
  minimumLevel: 'info',
  collectionIntervalMinutes: 5,
  rateLimitPerHour: 12000,
};

const allCategories = [
  { value: 'security', label: 'Security' },
  { value: 'hardware', label: 'Hardware' },
  { value: 'application', label: 'Application' },
  { value: 'system', label: 'System' },
];

const levelOptions = [
  { value: 'info', label: 'Info (all events)' },
  { value: 'warning', label: 'Warning+' },
  { value: 'error', label: 'Error+' },
  { value: 'critical', label: 'Critical only' },
];

export default function EventLogTab({ policyId, existingLink, onLinkChanged, linkedPolicyId, parentLink }: FeatureTabProps) {
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const isInherited = !!parentLink && !existingLink;
  const effectiveLink = existingLink ?? parentLink;
  const [settings, setSettings] = useState<EventLogSettings>(() => {
    const stored = effectiveLink?.inlineSettings as Partial<EventLogSettings> | undefined;
    const merged = { ...defaults, ...stored };
    if (!Array.isArray(merged.collectCategories)) merged.collectCategories = [...defaults.collectCategories];
    return merged;
  });

  useEffect(() => {
    const link = existingLink ?? parentLink;
    if (link?.inlineSettings) {
      setSettings((prev) => {
        const merged = { ...prev, ...(link.inlineSettings as Partial<EventLogSettings>) };
        if (!Array.isArray(merged.collectCategories)) merged.collectCategories = [...defaults.collectCategories];
        return merged;
      });
    }
  }, [existingLink, parentLink]);

  const update = <K extends keyof EventLogSettings>(key: K, value: EventLogSettings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  const toggleCategory = (category: string) => {
    setSettings((prev) => {
      const cats = prev.collectCategories.includes(category)
        ? prev.collectCategories.filter((c) => c !== category)
        : [...prev.collectCategories, category];
      return { ...prev, collectCategories: cats.length > 0 ? cats : [category] };
    });
  };

  // Build the payload from the known keys only, so removed/legacy fields
  // (e.g. the dead enableFullTextSearch / enableCorrelation toggles, #1323)
  // are never re-persisted even if they were present on an older link.
  const toPayload = (s: EventLogSettings): EventLogSettings => ({
    retentionDays: s.retentionDays,
    maxEventsPerCycle: s.maxEventsPerCycle,
    collectCategories: s.collectCategories,
    minimumLevel: s.minimumLevel,
    collectionIntervalMinutes: s.collectionIntervalMinutes,
    rateLimitPerHour: s.rateLimitPerHour,
  });

  const handleSave = async () => {
    clearError();
    const result = await save(existingLink?.id ?? null, {
      featureType: 'event_log',
      featurePolicyId: linkedPolicyId,
      inlineSettings: toPayload(settings),
    });
    if (result) onLinkChanged(result, 'event_log');
  };

  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, 'event_log');
  };

  const handleOverride = async () => {
    clearError();
    const result = await save(null, {
      featureType: 'event_log',
      featurePolicyId: linkedPolicyId,
      inlineSettings: toPayload(settings),
    });
    if (result) onLinkChanged(result, 'event_log');
  };

  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, 'event_log');
  };

  const meta = FEATURE_META.event_log;

  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<ScrollText className="h-5 w-5" />}
      isConfigured={!!existingLink || isInherited}
      saving={saving}
      error={error}
      onSave={handleSave}
      onRemove={existingLink && !linkedPolicyId ? handleRemove : undefined}
      isInherited={isInherited}
      onOverride={isInherited ? handleOverride : undefined}
      onRevert={!isInherited && !!linkedPolicyId && !!existingLink ? handleRevert : undefined}
    >
      <p className="mb-6 rounded-md border border-muted bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
        Event logs are collected from all devices by default. These settings tune what's
        collected, how often, and how long it's retained — they do not turn collection on or off.
      </p>

      <div className="grid gap-6 sm:grid-cols-2">
        {/* Retention */}
        <div>
          <label className="text-sm font-medium">Retention (days)</label>
          <input
            type="number"
            min={7}
            max={365}
            value={settings.retentionDays}
            onChange={(e) => update('retentionDays', Math.max(7, Math.min(365, Number(e.target.value) || 30)))}
            className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <p className="mt-1 text-xs text-muted-foreground">How long to keep event logs (7-365 days).</p>
        </div>

        {/* Max events per cycle */}
        <div>
          <label className="text-sm font-medium">Max events per cycle</label>
          <input
            type="number"
            min={10}
            max={500}
            value={settings.maxEventsPerCycle}
            onChange={(e) => update('maxEventsPerCycle', Math.max(10, Math.min(500, Number(e.target.value) || 100)))}
            className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <p className="mt-1 text-xs text-muted-foreground">Agent-side cap per collection cycle.</p>
        </div>

        {/* Minimum level */}
        <div>
          <label className="text-sm font-medium">Minimum severity level</label>
          <select
            value={settings.minimumLevel}
            onChange={(e) => update('minimumLevel', e.target.value as EventLogSettings['minimumLevel'])}
            className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {levelOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted-foreground">Events below this level are filtered out.</p>
        </div>

        {/* Collection interval */}
        <div>
          <label className="text-sm font-medium">Collection interval (minutes)</label>
          <input
            type="number"
            min={1}
            max={60}
            value={settings.collectionIntervalMinutes}
            onChange={(e) => update('collectionIntervalMinutes', Math.max(1, Math.min(60, Number(e.target.value) || 5)))}
            className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <p className="mt-1 text-xs text-muted-foreground">How often the agent sends logs (1-60 minutes).</p>
        </div>

        {/* Rate limit */}
        <div>
          <label className="text-sm font-medium">Rate limit per hour</label>
          <input
            type="number"
            min={100}
            max={100000}
            value={settings.rateLimitPerHour}
            onChange={(e) => update('rateLimitPerHour', Math.max(100, Math.min(100000, Number(e.target.value) || 12000)))}
            className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <p className="mt-1 text-xs text-muted-foreground">API-side per-device rate limit (events/hour).</p>
        </div>
      </div>

      {/* Categories */}
      <div className="mt-6 space-y-3">
        <h3 className="text-sm font-semibold">Collect Categories</h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {allCategories.map((cat) => (
            <button
              key={cat.value}
              type="button"
              onClick={() => toggleCategory(cat.value)}
              className={`rounded-md border px-3 py-2 text-sm font-medium transition ${
                settings.collectCategories.includes(cat.value)
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-muted bg-muted/50 text-muted-foreground hover:bg-muted'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>
    </FeatureTabShell>
  );
}
