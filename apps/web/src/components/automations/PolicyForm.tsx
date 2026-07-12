import { useMemo, useState } from 'react';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
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

type ScriptsT = TFunction<'scripts'>;

const createRuleSchema = (t: ScriptsT) => z.object({
  type: z.enum([
    'required_software',
    'prohibited_software',
    'disk_space_minimum',
    'os_version',
    'registry_check',
    'config_check'
  ]),
  softwareName: z.string().trim().optional(),
  softwareVersion: z.string().trim().optional(),
  versionOperator: z.enum(['any', 'exact', 'minimum', 'maximum']).optional(),
  diskSpaceGB: z.coerce.number().optional(),
  diskPath: z.string().trim().optional(),
  osType: z.enum(['windows', 'macos', 'linux', 'any']).optional(),
  osMinVersion: z.string().trim().optional(),
  registryPath: z.string().trim().optional(),
  registryValueName: z.string().trim().optional(),
  registryExpectedValue: z.string().trim().optional(),
  configFilePath: z.string().trim().optional(),
  configKey: z.string().trim().optional(),
  configExpectedValue: z.string().trim().optional()
}).superRefine((rule, ctx) => {
  switch (rule.type) {
    case 'required_software': {
      if (!rule.softwareName) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t('policyForm.validation.softwareNameRequired'),
          path: ['softwareName']
        });
      }

      const operator = rule.versionOperator ?? 'any';
      if (operator !== 'any' && !rule.softwareVersion) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t('policyForm.validation.versionRequired'),
          path: ['softwareVersion']
        });
      }
      break;
    }
    case 'prohibited_software':
      if (!rule.softwareName) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t('policyForm.validation.softwareNameRequired'),
          path: ['softwareName']
        });
      }
      break;
    case 'disk_space_minimum':
      if (typeof rule.diskSpaceGB !== 'number' || Number.isNaN(rule.diskSpaceGB) || rule.diskSpaceGB <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t('policyForm.validation.diskSpacePositive'),
          path: ['diskSpaceGB']
        });
      }
      break;
    case 'registry_check':
      if (!rule.registryPath) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t('policyForm.validation.registryPathRequired'),
          path: ['registryPath']
        });
      }
      if (!rule.registryValueName) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t('policyForm.validation.registryValueRequired'),
          path: ['registryValueName']
        });
      }
      break;
    case 'config_check':
      if (!rule.configFilePath) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t('policyForm.validation.configPathRequired'),
          path: ['configFilePath']
        });
      }
      if (!rule.configKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t('policyForm.validation.configKeyRequired'),
          path: ['configKey']
        });
      }
      break;
    case 'os_version':
      // osType and osMinVersion are intentionally optional.
      break;
    default:
      break;
  }
});

const createPolicySchema = (t: ScriptsT) => {
  const ruleSchema = createRuleSchema(t);
  return z.object({
    name: z.string().min(1, t('policyForm.validation.nameRequired')),
    description: z.string().optional(),
    targetType: z.enum(['all', 'sites', 'groups', 'tags']),
    targetIds: z.array(z.string()).optional(),
    rules: z.array(ruleSchema).min(1, t('policyForm.validation.ruleRequired')),
    enforcementLevel: z.enum(['monitor', 'warn', 'enforce']),
    remediationScriptId: z.string().optional(),
    checkIntervalMinutes: z.coerce
      .number()
      .int()
      .min(5, t('policyForm.validation.minimumInterval'))
      .max(1440, t('policyForm.validation.maximumInterval'))
  });
};

export type PolicyFormValues = z.infer<ReturnType<typeof createPolicySchema>>;
export type RuleFormValues = PolicyFormValues['rules'][number];

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

const getEnforcementLevelOptions = (t: ScriptsT): {
  value: EnforcementLevel;
  label: string;
  description: string;
  icon: typeof Eye;
  color: string;
}[] => [
  {
    value: 'monitor',
    label: t('policyForm.enforcement.monitor.label'),
    description: t('policyForm.enforcement.monitor.description'),
    icon: Eye,
    color: 'border-blue-500/40 bg-blue-500/10'
  },
  {
    value: 'warn',
    label: t('policyForm.enforcement.warn.label'),
    description: t('policyForm.enforcement.warn.description'),
    icon: AlertTriangle,
    color: 'border-yellow-500/40 bg-yellow-500/10'
  },
  {
    value: 'enforce',
    label: t('policyForm.enforcement.enforce.label'),
    description: t('policyForm.enforcement.enforce.description'),
    icon: ShieldAlert,
    color: 'border-red-500/40 bg-red-500/10'
  }
];

const getRuleTypeOptions = (t: ScriptsT) => [
  { value: 'required_software', label: t('policyForm.ruleTypes.requiredSoftware') },
  { value: 'prohibited_software', label: t('policyForm.ruleTypes.prohibitedSoftware') },
  { value: 'disk_space_minimum', label: t('policyForm.ruleTypes.minimumDiskSpace') },
  { value: 'os_version', label: t('policyForm.ruleTypes.osVersion') },
  { value: 'registry_check', label: t('policyForm.ruleTypes.registryCheck') },
  { value: 'config_check', label: t('policyForm.ruleTypes.configFileCheck') }
];

const getTargetTypeOptions = (t: ScriptsT) => [
  { value: 'all', label: t('policyForm.targetTypes.allDevices') },
  { value: 'sites', label: t('policyForm.targetTypes.specificSites') },
  { value: 'groups', label: t('policyForm.targetTypes.specificGroups') },
  { value: 'tags', label: t('policyForm.targetTypes.specificTags') }
];

const getVersionOperatorOptions = (t: ScriptsT) => [
  { value: 'any', label: t('policyForm.versionOperators.any') },
  { value: 'exact', label: t('policyForm.versionOperators.exact') },
  { value: 'minimum', label: t('policyForm.versionOperators.minimum') },
  { value: 'maximum', label: t('policyForm.versionOperators.maximum') }
];

const getOsTypeOptions = (t: ScriptsT) => [
  { value: 'any', label: t('policyForm.osTypes.any') },
  { value: 'windows', label: t('policyForm.osTypes.windows') },
  { value: 'macos', label: t('policyForm.osTypes.macos') },
  { value: 'linux', label: t('policyForm.osTypes.linux') }
];

export default function PolicyForm({
  onSubmit,
  onCancel,
  defaultValues,
  submitLabel,
  loading,
  sites = [],
  groups = [],
  tags = [],
  scripts = []
}: PolicyFormProps) {
  const { t } = useTranslation('scripts');
  const [targetSectionExpanded, setTargetSectionExpanded] = useState(true);
  const policySchema = useMemo(() => createPolicySchema(t), [t]);
  const enforcementLevelOptions = useMemo(() => getEnforcementLevelOptions(t), [t]);
  const ruleTypeOptions = useMemo(() => getRuleTypeOptions(t), [t]);
  const targetTypeOptions = useMemo(() => getTargetTypeOptions(t), [t]);
  const versionOperatorOptions = useMemo(() => getVersionOperatorOptions(t), [t]);
  const osTypeOptions = useMemo(() => getOsTypeOptions(t), [t]);
  const resolvedSubmitLabel = submitLabel ?? t('policyForm.actions.savePolicy');

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    formState: { errors, isSubmitting }
  } = useForm<PolicyFormValues>({
    resolver: zodResolver(policySchema) as never,
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
      className="space-y-6 rounded-lg border bg-card p-6 shadow-xs"
    >
      {/* Basic Information */}
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="policy-name" className="text-sm font-medium">
            {t('policyForm.fields.name')}
          </label>
          <input
            id="policy-name"
            placeholder={t('policyForm.placeholders.name')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register('name')}
          />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-2 md:col-span-2">
          <label htmlFor="policy-description" className="text-sm font-medium">
            {t('common:labels.description')}
          </label>
          <textarea
            id="policy-description"
            placeholder={t('policyForm.placeholders.description')}
            rows={2}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring resize-none"
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
            <h3 className="text-sm font-semibold">{t('policyForm.sections.targetDevices')}</h3>
            <p className="text-xs text-muted-foreground">{t('policyForm.sections.targetDevicesDescription')}</p>
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
              <label className="text-sm font-medium">{t('policyForm.fields.targetType')}</label>
              <select
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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
                  {t('policyForm.selectTargets', {
                    target: watchTargetType === 'sites'
                      ? t('policyForm.targetLabels.sites')
                      : watchTargetType === 'groups'
                        ? t('policyForm.targetLabels.groups')
                        : t('policyForm.targetLabels.tags')
                  })}
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
                        className="h-4 w-4 rounded border-border"
                      />
                      <span className="text-sm">{target.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {watchTargetType !== 'all' && targetOptions.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {t('policyForm.empty.noTargets', {
                  target: watchTargetType === 'sites'
                    ? t('policyForm.targetLabels.sitesLower')
                    : watchTargetType === 'groups'
                      ? t('policyForm.targetLabels.groupsLower')
                      : t('policyForm.targetLabels.tagsLower')
                })}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Rules Builder */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">{t('policyForm.sections.rules')}</h3>
            <p className="text-xs text-muted-foreground">{t('policyForm.sections.rulesDescription')}</p>
          </div>
          <button
            type="button"
            onClick={addRule}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <Plus className="h-4 w-4" />
            {t('policyForm.actions.addRule')}
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
                        className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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
                          <label className="text-xs font-medium text-muted-foreground">{t('policyForm.fields.softwareName')}</label>
                          <input
                            placeholder={t('policyForm.placeholders.softwareNameRequired')}
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                            {...register(`rules.${index}.softwareName`)}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">{t('policyForm.fields.versionCheck')}</label>
                          <select
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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
                          <label className="text-xs font-medium text-muted-foreground">{t('policyForm.fields.version')}</label>
                          <input
                            placeholder={t('policyForm.placeholders.version')}
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                            {...register(`rules.${index}.softwareVersion`)}
                          />
                        </div>
                      </div>
                    )}

                    {/* Prohibited Software */}
                    {watchRules?.[index]?.type === 'prohibited_software' && (
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">{t('policyForm.fields.softwareName')}</label>
                        <input
                          placeholder={t('policyForm.placeholders.softwareNameProhibited')}
                          className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                          {...register(`rules.${index}.softwareName`)}
                        />
                        <p className="text-xs text-muted-foreground">
                          {t('policyForm.hints.prohibitedSoftware')}
                        </p>
                      </div>
                    )}

                    {/* Disk Space Minimum */}
                    {watchRules?.[index]?.type === 'disk_space_minimum' && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">{t('policyForm.fields.minimumFreeSpace')}</label>
                          <input
                            type="number"
                            min={1}
                            placeholder="10"
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                            {...register(`rules.${index}.diskSpaceGB`)}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">{t('policyForm.fields.diskPath')}</label>
                          <input
                            placeholder={t('policyForm.placeholders.diskPath')}
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                            {...register(`rules.${index}.diskPath`)}
                          />
                        </div>
                      </div>
                    )}

                    {/* OS Version */}
                    {watchRules?.[index]?.type === 'os_version' && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">{t('policyForm.fields.operatingSystem')}</label>
                          <select
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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
                          <label className="text-xs font-medium text-muted-foreground">{t('policyForm.fields.minimumVersion')}</label>
                          <input
                            placeholder={t('policyForm.placeholders.minimumVersion')}
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                            {...register(`rules.${index}.osMinVersion`)}
                          />
                        </div>
                      </div>
                    )}

                    {/* Registry Check */}
                    {watchRules?.[index]?.type === 'registry_check' && (
                      <div className="space-y-3">
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">{t('policyForm.fields.registryPath')}</label>
                          <input
                            placeholder={t('policyForm.placeholders.registryPath')}
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm font-mono focus:outline-hidden focus:ring-2 focus:ring-ring"
                            {...register(`rules.${index}.registryPath`)}
                          />
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-muted-foreground">{t('policyForm.fields.valueName')}</label>
                            <input
                              placeholder="EnableFeature"
                              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                              {...register(`rules.${index}.registryValueName`)}
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-muted-foreground">{t('policyForm.fields.expectedValue')}</label>
                            <input
                              placeholder="1"
                              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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
                          <label className="text-xs font-medium text-muted-foreground">{t('policyForm.fields.configFilePath')}</label>
                          <input
                            placeholder="/etc/ssh/sshd_config"
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm font-mono focus:outline-hidden focus:ring-2 focus:ring-ring"
                            {...register(`rules.${index}.configFilePath`)}
                          />
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-muted-foreground">{t('policyForm.fields.configKey')}</label>
                            <input
                              placeholder="PermitRootLogin"
                              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                              {...register(`rules.${index}.configKey`)}
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-muted-foreground">{t('policyForm.fields.expectedValue')}</label>
                            <input
                              placeholder="no"
                              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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
              {t('policyForm.empty.noRules')}
            </p>
          </div>
        )}
      </div>

      {/* Enforcement Level */}
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold">{t('policyForm.sections.enforcement')}</h3>
          <p className="text-xs text-muted-foreground">{t('policyForm.sections.enforcementDescription')}</p>
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
              <span className="text-sm font-medium">{t('policyForm.remediation.title')}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('policyForm.remediation.description')}
            </p>
            <div className="mt-3 space-y-2">
              <label className="text-sm font-medium">{t('policyForm.fields.remediationScript')}</label>
              <select
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                {...register('remediationScriptId')}
              >
                <option value="">{t('policyForm.placeholders.remediationScript')}</option>
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
        <h3 className="text-sm font-semibold mb-4">{t('policyForm.sections.checkInterval')}</h3>
        <div className="space-y-2">
          <label htmlFor="check-interval" className="text-sm font-medium">
            {t('policyForm.fields.evaluateEvery')}
          </label>
          <input
            id="check-interval"
            type="number"
            min={5}
            max={1440}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-48"
            {...register('checkIntervalMinutes')}
          />
          {errors.checkIntervalMinutes && (
            <p className="text-sm text-destructive">{errors.checkIntervalMinutes.message}</p>
          )}
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <HelpCircle className="h-3 w-3" />
            {t('policyForm.hints.checkInterval')}
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
          {t('common:actions.cancel')}
        </button>
        <button
          type="submit"
          disabled={isLoading}
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:px-6"
        >
          {isLoading ? t('common:states.saving') : resolvedSubmitLabel}
        </button>
      </div>
    </form>
  );
}
