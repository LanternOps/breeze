import { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Clock3,
  HardDrive,
  Server,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDeviceOptions } from '../../hooks/useDeviceOptions';
import { DeviceOptionPicker } from '../filters/DeviceOptionPicker';
import '../../lib/i18n';

/** DR step types the dispatcher accepts (`DR_ALLOWED_COMMAND_TYPES` on the
 *  API, plus the W05b non-command `BARE_METAL_REBUILD` step). Order is the
 *  order the selector lists them in. */
export const DR_STEP_TYPES = [
  'VM_RESTORE_FROM_BACKUP',
  'VM_INSTANT_BOOT',
  'HYPERV_RESTORE',
  'MSSQL_RESTORE',
  'BMR_RECOVER',
  'BARE_METAL_REBUILD',
] as const;

export type DRStepType = (typeof DR_STEP_TYPES)[number];

export const DEFAULT_REBUILD_OUTPUT_DIR = '/var/lib/breeze/rebuild/out';
export const DEFAULT_REBUILD_WAIT_TIMEOUT_MINUTES = 240;
export const REBUILD_WAIT_TIMEOUT_MIN = 5;
export const REBUILD_WAIT_TIMEOUT_MAX = 1440;

export function isDRStepType(value: unknown): value is DRStepType {
  return typeof value === 'string' && (DR_STEP_TYPES as readonly string[]).includes(value);
}

export type DRGroupForm = {
  localId: string;
  id?: string;
  name: string;
  deviceIds: string[];
  estimatedDurationMinutes: string;
  dependsOnGroupKey: string | null;
  /** `restoreConfig.commandType`; '' until the operator picks one (required on save). */
  stepType: DRStepType | '';
  /** BARE_METAL_REBUILD only: Linux device that runs the rebuild engine for rehearsals. */
  rebuildHostDeviceId: string | null;
  /** BARE_METAL_REBUILD only: directory on the rebuild host that receives the VHDX images. */
  outputDir: string;
  /** BARE_METAL_REBUILD only: minutes to wait for `checked_in` before the device is marked failed. */
  waitTimeoutMinutes: string;
  /** Opaque `restoreConfig.payload` of a loaded command-type step, re-sent untouched. */
  restorePayload?: Record<string, unknown>;
};

type DRPlanGroupCardProps = {
  group: DRGroupForm;
  index: number;
  total: number;
  dependencyOptions: DRGroupForm[];
  onChange: (updater: (group: DRGroupForm) => DRGroupForm) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  onCanSubmitChange: (canSubmit: boolean) => void;
};

export default function DRPlanGroupCard({
  group,
  index,
  total,
  dependencyOptions,
  onChange,
  onMove,
  onRemove,
  onCanSubmitChange,
}: DRPlanGroupCardProps) {
  const { t } = useTranslation('backup');
  const [deviceSearch, setDeviceSearch] = useState('');
  const [hostSearch, setHostSearch] = useState('');
  const deviceOptions = useDeviceOptions({
    search: deviceSearch,
    includeIds: group.deviceIds,
  });
  const isRebuild = group.stepType === 'BARE_METAL_REBUILD';
  // Rebuild hosts: Linux only in this wave (the engine refuses other
  // platforms), filtered server-side and only loaded once the step needs one.
  const hostOptions = useDeviceOptions({
    search: hostSearch,
    osType: 'linux',
    includeIds: group.rebuildHostDeviceId ? [group.rebuildHostDeviceId] : [],
    enabled: isRebuild,
  });
  const stepTypeLabels: Record<DRStepType, string> = {
    VM_RESTORE_FROM_BACKUP: t('dRPlanGroupCard.stepTypes.vmRestoreFromBackup'),
    VM_INSTANT_BOOT: t('dRPlanGroupCard.stepTypes.vmInstantBoot'),
    HYPERV_RESTORE: t('dRPlanGroupCard.stepTypes.hypervRestore'),
    MSSQL_RESTORE: t('dRPlanGroupCard.stepTypes.mssqlRestore'),
    BMR_RECOVER: t('dRPlanGroupCard.stepTypes.bmrRecover'),
    BARE_METAL_REBUILD: t('dRPlanGroupCard.stepTypes.bareMetalRebuild'),
  };
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
        <div className="space-y-4">
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
            <label
              htmlFor={`dr-group-step-type-${group.localId}`}
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              {t('dRPlanGroupCard.stepType')}
            </label>
            <select
              id={`dr-group-step-type-${group.localId}`}
              data-testid="dr-group-step-type"
              value={group.stepType}
              onChange={(event) => {
                const value = event.target.value;
                onChange((current) => ({
                  ...current,
                  stepType: isDRStepType(value) ? value : '',
                }));
              }}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">{t('dRPlanGroupCard.chooseAStepType')}</option>
              {DR_STEP_TYPES.map((type) => (
                <option key={type} value={type}>
                  {stepTypeLabels[type]}
                </option>
              ))}
            </select>
          </div>
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
          <div className="rounded-md border bg-background p-2">
            <DeviceOptionPicker
              result={deviceOptions}
              selectedIds={group.deviceIds}
              onSelectedIdsChange={(deviceIds) =>
                onChange((current) => ({ ...current, deviceIds }))
              }
              search={deviceSearch}
              onSearchChange={setDeviceSearch}
              showSelectAll
              onCanSubmitChange={onCanSubmitChange}
            />
          </div>
        </div>
      </div>

      {isRebuild && (
        <div
          className="grid gap-4 border-t p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,280px)_160px]"
          data-testid="dr-group-rebuild-options"
        >
          <div className="rounded-lg border bg-muted/20 p-3">
            <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <HardDrive className="h-3.5 w-3.5" />
              {t('dRPlanGroupCard.rebuildHost')}
            </div>
            <p className="mb-2 text-xs text-muted-foreground">{t('dRPlanGroupCard.rebuildHostHint')}</p>
            <div className="rounded-md border bg-background p-2">
              <DeviceOptionPicker
                result={hostOptions}
                selectedIds={group.rebuildHostDeviceId ? [group.rebuildHostDeviceId] : []}
                onSelectedIdsChange={(ids) =>
                  onChange((current) => ({ ...current, rebuildHostDeviceId: ids[0] ?? null }))
                }
                search={hostSearch}
                onSearchChange={setHostSearch}
                selectionMode="single"
              />
            </div>
          </div>
          <div>
            <label
              htmlFor={`dr-group-output-dir-${group.localId}`}
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              {t('dRPlanGroupCard.outputDir')}
            </label>
            <input
              id={`dr-group-output-dir-${group.localId}`}
              data-testid="dr-group-rebuild-output-dir"
              value={group.outputDir}
              onChange={(event) => {
                const outputDir = event.target.value;
                onChange((current) => ({ ...current, outputDir }));
              }}
              placeholder={DEFAULT_REBUILD_OUTPUT_DIR}
              className="h-10 w-full rounded-md border bg-background px-3 font-mono text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('dRPlanGroupCard.outputDirHint')}</p>
          </div>
          <div>
            <label
              htmlFor={`dr-group-wait-timeout-${group.localId}`}
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              {t('dRPlanGroupCard.waitTimeout')}
            </label>
            <input
              id={`dr-group-wait-timeout-${group.localId}`}
              data-testid="dr-group-rebuild-wait-timeout"
              type="number"
              min={REBUILD_WAIT_TIMEOUT_MIN}
              max={REBUILD_WAIT_TIMEOUT_MAX}
              value={group.waitTimeoutMinutes}
              onChange={(event) => {
                const waitTimeoutMinutes = event.target.value;
                onChange((current) => ({ ...current, waitTimeoutMinutes }));
              }}
              placeholder={`${DEFAULT_REBUILD_WAIT_TIMEOUT_MINUTES}`}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('dRPlanGroupCard.waitTimeoutHint')}</p>
          </div>
        </div>
      )}
    </article>
  );
}
