import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/dateTimeFormat';
import BaselineFormModal, { type Baseline } from './BaselineFormModal';

type Props = {
  baseline: Baseline;
  onUpdated: () => void;
};

const osLabelKey: Record<string, string> = { windows: 'windows', macos: 'macos', linux: 'linux' };
const profileLabelKey: Record<string, string> = { cis_l1: 'cisL1', cis_l2: 'cisL2', custom: 'custom' };

export default function BaselineOverviewTab({ baseline, onUpdated }: Props) {
  const { t } = useTranslation('security');
  const [editing, setEditing] = useState(false);

  const settings = baseline.settings && typeof baseline.settings === 'object'
    ? Object.entries(baseline.settings as Record<string, unknown>)
    : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t('auditBaselinesBaselineOverviewTab.title')}</h3>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <Pencil className="h-3.5 w-3.5" />
          {t('auditBaselinesBaselineOverviewTab.actions.edit')}
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <p className="text-xs text-muted-foreground">{t('auditBaselinesBaselineOverviewTab.fields.name')}</p>
          <p className="mt-1 font-medium">{baseline.name}</p>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <p className="text-xs text-muted-foreground">{t('auditBaselinesBaselineOverviewTab.fields.osType')}</p>
          <p className="mt-1 font-medium">
            {osLabelKey[baseline.osType] ? t(`auditBaselinesBaselineOverviewTab.os.${osLabelKey[baseline.osType]}`) : baseline.osType}
          </p>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <p className="text-xs text-muted-foreground">{t('auditBaselinesBaselineOverviewTab.fields.profile')}</p>
          <p className="mt-1 font-medium">
            {profileLabelKey[baseline.profile]
              ? t(`auditBaselinesBaselineOverviewTab.profiles.${profileLabelKey[baseline.profile]}`)
              : baseline.profile}
          </p>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <p className="text-xs text-muted-foreground">{t('auditBaselinesBaselineOverviewTab.fields.status')}</p>
          <span
            className={cn(
              'mt-1 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
              baseline.isActive
                ? 'bg-green-500/15 text-green-700 border-green-500/30'
                : 'bg-gray-500/15 text-gray-600 border-gray-500/30'
            )}
          >
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                baseline.isActive ? 'bg-green-500' : 'bg-gray-400'
              )}
            />
            {baseline.isActive
              ? t('auditBaselinesBaselineOverviewTab.status.active')
              : t('auditBaselinesBaselineOverviewTab.status.inactive')}
          </span>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <p className="text-xs text-muted-foreground">{t('auditBaselinesBaselineOverviewTab.fields.created')}</p>
          <p className="mt-1 text-sm">{formatDateTime(baseline.createdAt)}</p>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <p className="text-xs text-muted-foreground">{t('auditBaselinesBaselineOverviewTab.fields.lastUpdated')}</p>
          <p className="mt-1 text-sm">{formatDateTime(baseline.updatedAt)}</p>
        </div>
      </div>

      {settings.length > 0 && (
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <h3 className="text-sm font-semibold">{t('auditBaselinesBaselineOverviewTab.settings')}</h3>
          <div className="mt-4 space-y-2">
            {settings.map(([key, value]) => (
              <div
                key={key}
                className="flex items-start justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2"
              >
                <code className="text-xs font-medium">{key}</code>
                <code className="text-xs text-muted-foreground">
                  {typeof value === 'string' ? value : JSON.stringify(value)}
                </code>
              </div>
            ))}
          </div>
        </div>
      )}

      {editing && (
        <BaselineFormModal
          baseline={baseline}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onUpdated();
          }}
        />
      )}
    </div>
  );
}
