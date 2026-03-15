import type { InheritableBrandingSettings } from '@breeze/shared';

type Props = {
  data: InheritableBrandingSettings;
  onChange: (data: InheritableBrandingSettings) => void;
};

const PLACEHOLDER = 'Not set — orgs configure individually';

export default function PartnerBrandingTab({ data, onChange }: Props) {
  const set = (patch: Partial<InheritableBrandingSettings>) =>
    onChange({ ...data, ...patch });

  return (
    <div className="space-y-6">
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-2">
          <label className="text-sm font-medium">Primary Color</label>
          <div className="flex gap-2">
            <input
              type="color"
              value={data.primaryColor || '#3b82f6'}
              onChange={e => set({ primaryColor: e.target.value })}
              className="h-10 w-12 cursor-pointer rounded-md border bg-background p-1"
            />
            <input
              type="text"
              value={data.primaryColor ?? ''}
              onChange={e => set({ primaryColor: e.target.value || undefined })}
              placeholder={PLACEHOLDER}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Secondary Color</label>
          <div className="flex gap-2">
            <input
              type="color"
              value={data.secondaryColor || '#64748b'}
              onChange={e => set({ secondaryColor: e.target.value })}
              className="h-10 w-12 cursor-pointer rounded-md border bg-background p-1"
            />
            <input
              type="text"
              value={data.secondaryColor ?? ''}
              onChange={e => set({ secondaryColor: e.target.value || undefined })}
              placeholder={PLACEHOLDER}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Theme</label>
          <select
            value={data.theme ?? ''}
            onChange={e => set({ theme: (e.target.value || undefined) as InheritableBrandingSettings['theme'] })}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">{PLACEHOLDER}</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="system">System</option>
          </select>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Logo URL</label>
          <input
            type="url"
            value={data.logoUrl ?? ''}
            onChange={e => set({ logoUrl: e.target.value || undefined })}
            placeholder={PLACEHOLDER}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          />
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">Custom CSS</label>
        <textarea
          value={data.customCss ?? ''}
          onChange={e => set({ customCss: e.target.value || undefined })}
          rows={5}
          className="w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
          placeholder="/* Custom CSS applied to all child organizations */"
        />
        <p className="text-xs text-muted-foreground">
          CSS overrides applied to the portal for all child organizations.
        </p>
      </div>
    </div>
  );
}
