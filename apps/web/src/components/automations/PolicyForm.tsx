import { useMemo, useState } from 'react';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Plus,
  Trash2,
  GripVertical,
  Eye,
  AlertTriangle,
  ShieldAlert,
  HelpCircle,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { EnforcementLevel } from './PolicyList';

const ruleSchema = z.object({
  type: z.enum([
    'required_software',
    'prohibited_software',
    'disk_space_minimum',
    'os_version',
    'registry_check',
    'config_check'
  ]),
  softwareName: z.string().optional(),
  softwareVersion: z.string().optional(),
  versionOperator: z.enum(['any', 'exact', 'minimum', 'maximum']).optional(),
  diskSpaceGB: z.coerce.number().optional(),
  diskPath: z.string().optional(),
  osType: z.enum(['windows', 'macos', 'linux', 'any']).optional(),
  osMinVersion: z.string().optional(),
  registryPath: z.string().optional(),
  registryValueName: z.string().optional(),
  registryExpectedValue: z.string().optional(),
  configFilePath: z.string().optional(),
  configKey: z.string().optional(),
  configExpectedValue: z.string().optional()
});

const policySchema = z.object({
  name: z.string().min(1, 'Policy name is required'),
  description: z.string().optional(),
  targetType: z.enum(['all', 'sites', 'groups', 'tags']),
  targetIds: z.array(z.string()).optional(),
  rules: z.array(ruleSchema).min(1, 'At least one rule is required'),
  enforcementLevel: z.enum(['monitor', 'warn', 'enforce']),
  remediationScriptId: z.string().optional(),
  checkIntervalMinutes: z.coerce
    .number()
    .int()
    .min(5, 'Minimum interval is 5 minutes')
    .max(1440, 'Maximum interval is 24 hours')
});

export type PolicyFormValues = z.infer<typeof policySchema>;
export type RuleFormValues = z.infer<typeof ruleSchema>;

type Site = { id: string; name: string };
type Group = { id: string; name: string };
type Tag = { id: string; name: string };
type Script = { id: string; name: string };

type PolicyFormProps = {
  onSubmit?: (values: PolicyFormValues) => void | Promise<void>;
  onCancel?: () => void;
  defaultValues?: Partial<PolicyFormValues>;
  submitLabel?: string;
  loading?: boolean;
  sites?: Site[];
  groups?: Group[];
  tags?: Tag[];
  scripts?: Script[];
};

const enforcementLevelOptions: {
  value: EnforcementLevel;
  label: string;
  description: string;
  icon: typeof Eye;
  color: string;
}[] = [
  {
    value: 'monitor',
    label: 'Monitor',
    description: 'Track compliance status without taking action. Ideal for initial policy rollout.',
    icon: Eye,
    color: 'border-blue-500/40 bg-blue-500/10'
  },
  {
    value: 'warn',
    label: 'Warn',
    description: 'Generate alerts when violations are detected. Notifies admins but does not auto-remediate.',
    icon: AlertTriangle,
    color: 'border-yellow-500/40 bg-yellow-500/10'
  },
  {
    value: 'enforce',
    label: 'Enforce',
    description: 'Automatically run remediation scripts when violations are detected. Use with caution.',
    icon: ShieldAlert,
    color: 'border-red-500/40 bg-red-500/10'
  }
];

const ruleTypeOptions = [
  { value: 'required_software', label: 'Required Software' },
  { value: 'prohibited_software', label: 'Prohibited Software' },
  { value: 'disk_space_minimum', label: 'Minimum Disk Space' },
  { value: 'os_version', label: 'OS Version Requirement' },
  { value: 'registry_check', label: 'Registry Check (Windows)' },
  { value: 'config_check', label: 'Config File Check' }
];

const targetTypeOptions = [
  { value: 'all', label: 'All Devices' },
  { value: 'sites', label: 'Specific Sites' },
  { value: 'groups', label: 'Specific Groups' },
  { value: 'tags', label: 'Specific Tags' }
];

const versionOperatorOptions = [
  { value: 'any', label: 'Any version' },
  { value: 'exact', label: 'Exact version' },
  { value: 'minimum', label: 'Minimum version' },
  { value: 'maximum', label: 'Maximum version' }
];

const osTypeOptions = [
  { value: 'any', label: 'Any OS' },
  { value: 'windows', label: 'Windows' },
  { value: 'macos', label: 'macOS' },
  { value: 'linux', label: 'Linux' }
];

export default function PolicyForm({
  onSubmit,
  onCancel,
  defaultValues,
  submitLabel = 'Save policy',
  loading,
  sites = [],
  groups = [],
  tags = [],
  scripts = []
}: PolicyFormProps) {
  const [targetSectionExpanded, setTargetSectionExpanded] = useState(true);

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    formState: { errors, isSubmitting }
  } = useForm<PolicyFormValues>({
    resolver: zodResolver(policySchema),
    defaultValues: {
      name: '',
      description: '',
      targetType: 'all',
      targetIds: [],
      rules: [{ type: 'required_software' }],
      enforcementLevel: 'monitor',
      remediationScriptId: '',
      checkIntervalMinutes: 60,
      ...defaultValues
    }
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'rules'
  });

  const watchTargetType = watch('targetType');
  const watchRules = watch('rules');
  const watchEnforcementLevel = watch('enforcementLevel');
  const watchTargetIds = watch('targetIds');

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);

  const targetOptions = useMemo(() => {
    switch (watchTargetType) {
      case 'sites':
        return sites;
      case 'groups':
        return groups;
      case 'tags':
        return tags;
      default:
        return [];
    }
  }, [watchTargetType, sites, groups, tags]);

  const handleTargetToggle = (id: string) => {
    const current = watchTargetIds || [];
    if (current.includes(id)) {
      setValue(
        'targetIds',
        current.filter(i => i !== id)
      );
    } else {
      setValue('targetIds', [...current, id]);
    }
  };

  const addRule = () => {
    append({ type: 'required_software' });
  };

  return (
    <form
      onSubmit={handleSubmit(async values => {
        await onSubmit?.(values);
      })}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-sm"
    >
      {/* Basic Information */}
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="policy-name" className="text-sm font-medium">
            Policy name
          </label>
          <input
            id="policy-name"
            placeholder="Security baseline policy"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('name')}
          />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-2 md:col-span-2">
          <label htmlFor="policy-description" className="text-sm font-medium">
            Description
          </label>
          <textarea
            id="policy-description"
            placeholder="Describe what this policy enforces..."
            rows={2}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
            {...register('description')}
          />
        </div>
      </div>

      {/* Target Selection */}
      <div className="rounded-md border bg-muted/20 p-4">
        <button
          type="button"
          onClick={() => setTargetSectionExpanded(!targetSectionExpanded)}
          className="flex w-full items-center justify-between"
        >
          <div>
            <h3 className="text-sm font-semibold">Target Devices</h3>
            <p className="text-xs text-muted-foreground">Select which devices this policy applies to</p>
          </div>
          {targetSectionExpanded ? (
            <ChevronUp className="h-5 w-5 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-5 w-5 text-muted-foreground" />
          )}
        </button>

        {targetSectionExpanded && (
          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Target Type</label>
              <select
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                {...register('targetType')}
              >
                {targetTypeOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {watchTargetType !== 'all' && targetOptions.length > 0 && (
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Select {watchTargetType === 'sites' ? 'Sites' : watchTargetType === 'groups' ? 'Groups' : 'Tags'}
                </label>
                <div className="max-h-48 overflow-y-auto rounded-md border bg-background p-2">
                  {targetOptions.map(target => (
                    <label
                      key={target.id}
                      className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-muted cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={watchTargetIds?.includes(target.id) || false}
                        onChange={() => handleTargetToggle(target.id)}
                        className="h-4 w-4 rounded border-gray-300"
                      />
                      <span className="text-sm">{target.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {watchTargetType !== 'all' && targetOptions.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No {watchTargetType} available.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Rules Builder */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Policy Rules</h3>
            <p className="text-xs text-muted-foreground">Define what this policy checks</p>
          </div>
          <button
            type="button"
            onClick={addRule}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <Plus className="h-4 w-4" />
            Add Rule
          </button>
        </div>

        {errors.rules && (
          <p className="text-sm text-destructive">{errors.rules.message}</p>
        )}

        {fields.length > 0 && (
          <div className="space-y-3">
            {fields.map((field, index) => (
              <div key={field.id} className="rounded-md border bg-muted/20 p-4">
                <div className="flex items-start gap-3">
                  <GripVertical className="h-5 w-5 text-muted-foreground mt-2 cursor-move" />
                  <div className="flex-1 space-y-3">
                    <div className="flex items-center gap-3">
                      <select
                        className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        {...register(`rules.${index}.type`)}
                      >
                        {ruleTypeOptions.map(opt => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Required Software */}
                    {watchRules?.[index]?.type === 'required_software' && (
                      <div className="grid gap-3 sm:grid-cols-3">
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">Software Name</label>
                          <input
                            placeholder="e.g., Google Chrome"
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                            {...register(`rules.${index}.softwareName`)}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">Version Check</label>
                          <select
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                            {...register(`rules.${index}.versionOperator`)}
                          >
                            {versionOperatorOptions.map(opt => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">Version</label>
                          <input
                            placeholder="e.g., 120.0"
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                            {...register(`rules.${index}.softwareVersion`)}
                          />
                        </div>
                      </div>
                    )}

                    {/* Prohibited Software */}
                    {watchRules?.[index]?.type === 'prohibited_software' && (
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">Software Name</label>
                        <input
                          placeholder="e.g., BitTorrent"
                          className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          {...register(`rules.${index}.softwareName`)}
                        />
                        <p className="text-xs text-muted-foreground">
                          Violation if this software is found installed
                        </p>
                      </div>
                    )}

                    {/* Disk Space Minimum */}
                    {watchRules?.[index]?.type === 'disk_space_minimum' && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">Minimum Free Space (GB)</label>
                          <input
                            type="number"
                            min={1}
                            placeholder="10"
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                            {...register(`rules.${index}.diskSpaceGB`)}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">Disk/Path (optional)</label>
                          <input
                            placeholder="C: or /home"
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                            {...register(`rules.${index}.diskPath`)}
                          />
                        </div>
                      </div>
                    )}

                    {/* OS Version */}
                    {watchRules?.[index]?.type === 'os_version' && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">Operating System</label>
                          <select
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                            {...register(`rules.${index}.osType`)}
                          >
                            {osTypeOptions.map(opt => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">Minimum Version</label>
                          <input
                            placeholder="e.g., 10.0 or 22.04"
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                            {...register(`rules.${index}.osMinVersion`)}
                          />
                        </div>
                      </div>
                    )}

                    {/* Registry Check */}
                    {watchRules?.[index]?.type === 'registry_check' && (
                      <div className="space-y-3">
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">Registry Path</label>
                          <input
                            placeholder="HKLM\SOFTWARE\Policies\..."
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                            {...register(`rules.${index}.registryPath`)}
                          />
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-muted-foreground">Value Name</label>
                            <input
                              placeholder="EnableFeature"
                              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                              {...register(`rules.${index}.registryValueName`)}
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-muted-foreground">Expected Value</label>
                            <input
                              placeholder="1"
                              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                              {...register(`rules.${index}.registryExpectedValue`)}
                            />
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Config Check */}
                    {watchRules?.[index]?.type === 'config_check' && (
                      <div className="space-y-3">
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">Config File Path</label>
                          <input
                            placeholder="/etc/ssh/sshd_config"
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                            {...register(`rules.${index}.configFilePath`)}
                          />
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-muted-foreground">Config Key</label>
                            <input
                              placeholder="PermitRootLogin"
                              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                              {...register(`rules.${index}.configKey`)}
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-muted-foreground">Expected Value</label>
                            <input
                              placeholder="no"
                              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                              {...register(`rules.${index}.configExpectedValue`)}
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(index)}
                    disabled={fields.length === 1}
                    className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-muted text-destructive disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {fields.length === 0 && (
          <div className="rounded-md border border-dashed p-6 text-center">
            <p className="text-sm text-muted-foreground">
              No rules defined. Click "Add Rule" to create one.
            </p>
          </div>
        )}
      </div>

      {/* Enforcement Level */}
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Enforcement Level</h3>
          <p className="text-xs text-muted-foreground">Choose how violations should be handled</p>
        </div>

        <Controller
          name="enforcementLevel"
          control={control}
          render={({ field }) => (
            <div className="grid gap-3 sm:grid-cols-3">
              {enforcementLevelOptions.map(opt => {
                const Icon = opt.icon;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => field.onChange(opt.value)}
                    className={cn(
                      'flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition',
                      field.value === opt.value
                        ? `${opt.color} border-2`
                        : 'border-input bg-background hover:bg-muted'
                    )}
                  >
                    <Icon className="h-5 w-5" />
                    <div>
                      <p className="text-sm font-medium">{opt.label}</p>
                      <p className="text-xs text-muted-foreground">{opt.description}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        />

        {watchEnforcementLevel === 'enforce' && (
          <div className="mt-4 space-y-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-4">
            <div className="flex items-center gap-2 text-yellow-700">
              <AlertTriangle className="h-4 w-4" />
              <span className="text-sm font-medium">Automatic Remediation</span>
            </div>
            <p className="text-xs text-muted-foreground">
              When enforcement is enabled, a remediation script will run automatically on non-compliant devices.
            </p>
            <div className="mt-3 space-y-2">
              <label className="text-sm font-medium">Remediation Script</label>
              <select
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                {...register('remediationScriptId')}
              >
                <option value="">Select a remediation script...</option>
                {scripts.map(script => (
                  <option key={script.id} value={script.id}>
                    {script.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Check Interval */}
      <div className="rounded-md border bg-muted/20 p-4">
        <h3 className="text-sm font-semibold mb-4">Check Interval</h3>
        <div className="space-y-2">
          <label htmlFor="check-interval" className="text-sm font-medium">
            Evaluate every (minutes)
          </label>
          <input
            id="check-interval"
            type="number"
            min={5}
            max={1440}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-48"
            {...register('checkIntervalMinutes')}
          />
          {errors.checkIntervalMinutes && (
            <p className="text-sm text-destructive">{errors.checkIntervalMinutes.message}</p>
          )}
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <HelpCircle className="h-3 w-3" />
            How often devices should be checked for compliance
          </p>
        </div>
      </div>

      {/* Form Actions */}
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="h-11 w-full rounded-md border bg-background text-sm font-medium text-foreground transition hover:bg-muted sm:w-auto sm:px-6"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isLoading}
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:px-6"
        >
          {isLoading ? 'Saving...' : submitLabel}
        </button>
      </div>
    </form>
  );
}
