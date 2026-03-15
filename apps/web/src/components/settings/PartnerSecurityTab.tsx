import type { InheritableSecuritySettings } from '@breeze/shared';

type Props = {
  data: InheritableSecuritySettings;
  onChange: (data: InheritableSecuritySettings) => void;
};

const PLACEHOLDER = 'Not set — orgs configure individually';

export default function PartnerSecurityTab({ data, onChange }: Props) {
  const set = (patch: Partial<InheritableSecuritySettings>) =>
    onChange({ ...data, ...patch });

  return (
    <div className="space-y-6">
      <div className="grid gap-6 sm:grid-cols-2">
        {/* Password Policy */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Minimum Password Length</label>
          <input
            type="number"
            value={data.minLength ?? ''}
            onChange={e => set({ minLength: e.target.value ? Number(e.target.value) : undefined })}
            placeholder={PLACEHOLDER}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            min={6}
            max={128}
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Password Complexity</label>
          <select
            value={data.complexity ?? ''}
            onChange={e => set({ complexity: (e.target.value || undefined) as InheritableSecuritySettings['complexity'] })}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">{PLACEHOLDER}</option>
            <option value="standard">Standard</option>
            <option value="strict">Strict</option>
            <option value="passphrase">Passphrase</option>
          </select>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Password Expiration (days)</label>
          <input
            type="number"
            value={data.expirationDays ?? ''}
            onChange={e => set({ expirationDays: e.target.value ? Number(e.target.value) : undefined })}
            placeholder={PLACEHOLDER}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            min={30}
            max={365}
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Session Timeout (minutes)</label>
          <input
            type="number"
            value={data.sessionTimeout ?? ''}
            onChange={e => set({ sessionTimeout: e.target.value ? Number(e.target.value) : undefined })}
            placeholder={PLACEHOLDER}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            min={15}
            max={240}
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Max Concurrent Sessions</label>
          <input
            type="number"
            value={data.maxSessions ?? ''}
            onChange={e => set({ maxSessions: e.target.value ? Number(e.target.value) : undefined })}
            placeholder={PLACEHOLDER}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            min={1}
            max={10}
          />
        </div>

        <div className="flex items-center gap-3 self-end pb-2">
          <input
            type="checkbox"
            checked={data.requireMfa ?? false}
            onChange={e => set({ requireMfa: e.target.checked })}
            className="h-4 w-4 rounded border"
          />
          <label className="text-sm font-medium">Require MFA for all users</label>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">IP Allowlist</label>
        <textarea
          value={(data.ipAllowlist ?? []).join('\n')}
          onChange={e => {
            const lines = e.target.value.split('\n').filter(Boolean);
            set({ ipAllowlist: lines.length > 0 ? lines : undefined });
          }}
          rows={4}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          placeholder="Enter one IP or CIDR range per line. Leave blank to let each org decide."
        />
        <p className="text-xs text-muted-foreground">
          Leave blank to let each organization configure individually. Use CIDR notation for ranges.
        </p>
      </div>
    </div>
  );
}
