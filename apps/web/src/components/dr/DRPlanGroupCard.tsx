import {
  ArrowDown,
  ArrowUp,
  Clock3,
  Server,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';

export type DRPlanDevice = {
  id: string;
  hostname?: string | null;
  displayName?: string | null;
  status?: string | null;
};

export type DRGroupForm = {
  localId: string;
  id?: string;
  name: string;
  deviceIds: string[];
  estimatedDurationMinutes: string;
  dependsOnGroupKey: string | null;
};

type DRPlanGroupCardProps = {
  group: DRGroupForm;
  index: number;
  total: number;
  devices: DRPlanDevice[];
  dependencyOptions: DRGroupForm[];
  onChange: (updater: (group: DRGroupForm) => DRGroupForm) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
};

function deviceName(device: DRPlanDevice): string {
  return device.displayName ?? device.hostname ?? device.id;
}

export default function DRPlanGroupCard({
  group,
  index,
  total,
  devices,
  dependencyOptions,
  onChange,
  onMove,
  onRemove,
}: DRPlanGroupCardProps) {
  const { t } = useTranslation('backup');
  return (
    <article className="rounded-lg border">
      <div className="flex items-center justify-between border-b bg-muted/20 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
            {index + 1}
          </span>
          <div>
            <p className="text-sm font-medium text-foreground">
              {group.name.trim() || `Recovery group ${index + 1}`}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('dRPlanGroupCard.deviceCount', { count: group.deviceIds.length })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            className="rounded-md border p-2 hover:bg-muted disabled:opacity-40"
            aria-label={t('dRPlanGroupCard.moveGroupUp')}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={index === total - 1}
            className="rounded-md border p-2 hover:bg-muted disabled:opacity-40"
            aria-label={t('dRPlanGroupCard.moveGroupDown')}
          >
            <ArrowDown className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="rounded-md border p-2 text-destructive hover:bg-destructive/10"
            aria-label={t('dRPlanGroupCard.removeGroup')}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,280px)_160px_200px_minmax(0,1fr)]">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('dRPlanGroupCard.groupName')}</label>
          <input
            value={group.name}
            onChange={(event) => onChange((current) => ({ ...current, name: event.target.value }))}
            placeholder={t('dRPlanGroupCard.coreServices')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('dRPlanGroupCard.estimatedDuration')}</label>
          <div className="relative">
            <Clock3 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="number"
              min={0}
              value={group.estimatedDurationMinutes}
              onChange={(event) =>
                onChange((current) => ({
                  ...current,
                  estimatedDurationMinutes: event.target.value,
                }))
              }
              placeholder="45"
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm"
            />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('dRPlanGroupCard.dependency')}</label>
          <select
            value={group.dependsOnGroupKey ?? ''}
            onChange={(event) =>
              onChange((current) => ({
                ...current,
                dependsOnGroupKey: event.target.value || null,
              }))
            }
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">{t('dRPlanGroupCard.noDependency')}</option>
            {dependencyOptions.map((option, optionIndex) => (
              <option key={option.localId} value={option.localId}>
                {optionIndex + 1}. {option.name || `Recovery group ${optionIndex + 1}`}
              </option>
            ))}
          </select>
        </div>

        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Server className="h-3.5 w-3.5" />
            {t('dRPlanGroupCard.deviceSelection')} </div>
          <div className="max-h-44 overflow-y-auto rounded-md border bg-background">
            {devices.length === 0 ? (
              <div className="px-3 py-6 text-sm text-muted-foreground">{t('dRPlanGroupCard.noDevicesAvailableToAssign')}</div>
            ) : (
              devices.map((device) => {
                const selected = group.deviceIds.includes(device.id);
                return (
                  <label
                    key={device.id}
                    className={cn(
                      'flex items-center justify-between gap-3 border-b px-3 py-2 text-sm last:border-b-0 hover:bg-muted/30',
                      selected && 'bg-primary/5'
                    )}
                  >
                    <span className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() =>
                          onChange((current) => ({
                            ...current,
                            deviceIds: current.deviceIds.includes(device.id)
                              ? current.deviceIds.filter((id) => id !== device.id)
                              : [...current.deviceIds, device.id],
                          }))
                        }
                        className="h-4 w-4 rounded"
                      />
                      <span>
                        <span className="block font-medium text-foreground">{deviceName(device)}</span>
                        <span className="block text-xs text-muted-foreground">{device.id.slice(0, 8)}</span>
                      </span>
                    </span>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 chart-legend-xs font-medium',
                        device.status === 'online'
                          ? 'bg-success/10 text-success'
                          : 'bg-muted text-muted-foreground'
                      )}
                    >
                      {device.status ?? 'Unknown'}
                    </span>
                  </label>
                );
              })
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
