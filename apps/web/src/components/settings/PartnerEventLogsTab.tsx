import type { InheritableEventLogSettings } from '@breeze/shared';

type Props = {
  data: InheritableEventLogSettings;
  onChange: (data: InheritableEventLogSettings) => void;
};

const PLACEHOLDER = 'Not set — orgs configure individually';

export default function PartnerEventLogsTab({ data, onChange }: Props) {
  const set = (patch: Partial<InheritableEventLogSettings>) =>
    onChange({ ...data, ...patch });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={data.enabled ?? false}
          onChange={e => set({ enabled: e.target.checked })}
          className="h-4 w-4 rounded border"
        />
        <label className="text-sm font-medium">Enable centralized event log shipping</label>
      </div>

      {data.enabled && (
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">Elasticsearch URL</label>
            <input
              type="url"
              value={data.elasticsearchUrl ?? ''}
              onChange={e => set({ elasticsearchUrl: e.target.value || undefined })}
              placeholder="https://elasticsearch.example.com:9200"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Index Prefix</label>
            <input
              type="text"
              value={data.indexPrefix ?? ''}
              onChange={e => set({ indexPrefix: e.target.value || undefined })}
              placeholder="breeze-logs"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">API Key</label>
            <input
              type="password"
              value={data.elasticsearchApiKey ?? ''}
              onChange={e => set({ elasticsearchApiKey: e.target.value || undefined })}
              placeholder={PLACEHOLDER}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Username (basic auth)</label>
            <input
              type="text"
              value={data.elasticsearchUsername ?? ''}
              onChange={e => set({ elasticsearchUsername: e.target.value || undefined })}
              placeholder={PLACEHOLDER}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Password (basic auth)</label>
            <input
              type="password"
              value={data.elasticsearchPassword ?? ''}
              onChange={e => set({ elasticsearchPassword: e.target.value || undefined })}
              placeholder={PLACEHOLDER}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        When enabled, all child organizations will ship event logs to the configured Elasticsearch instance.
        Leave disabled to let each organization configure individually.
      </p>
    </div>
  );
}
