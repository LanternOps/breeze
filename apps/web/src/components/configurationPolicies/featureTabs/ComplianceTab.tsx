import { useState, useEffect, useRef } from 'react';
import { ClipboardCheck, Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import type { FeatureTabProps } from './types';
import { FEATURE_META } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';

type RuleType = 'required_software' | 'prohibited_software' | 'disk_space_minimum' | 'os_version' | 'registry_check' | 'config_check';
type EnforcementLevel = 'monitor' | 'warn' | 'enforce';

type ComplianceRule = {
  type: RuleType;
  softwareName?: string;
  softwareVersion?: string;
  versionOperator?: string;
  prohibitedName?: string;
  minGb?: number;
  diskPath?: string;
  osType?: string;
  minOsVersion?: string;
  registryPath?: string;
  registryValueName?: string;
  registryExpectedValue?: string;
  configFilePath?: string;
  configKey?: string;
  configExpectedValue?: string;
};

type ComplianceItem = {
  name: string;
  rules: ComplianceRule[];
  enforcementLevel: EnforcementLevel;
  checkIntervalMinutes: number;
  remediationScriptId: string;
};

const defaultItem: ComplianceItem = {
  name: '',
  rules: [{ type: 'required_software', softwareName: '', softwareVersion: '', versionOperator: 'gte' }],
  enforcementLevel: 'monitor',
  checkIntervalMinutes: 60,
  remediationScriptId: '',
};

const ruleTypeOptions: { value: RuleType; label: string }[] = [
  { value: 'required_software', label: 'Required Software' },
  { value: 'prohibited_software', label: 'Prohibited Software' },
  { value: 'disk_space_minimum', label: 'Disk Space Minimum' },
  { value: 'os_version', label: 'OS Version' },
  { value: 'registry_check', label: 'Registry Check' },
  { value: 'config_check', label: 'Config File Check' },
];

const enforcementOptions: { value: EnforcementLevel; label: string; description: string }[] = [
  { value: 'monitor', label: 'Monitor Only', description: 'Report violations without taking action.' },
  { value: 'warn', label: 'Warn', description: 'Notify users and log compliance warnings.' },
  { value: 'enforce', label: 'Enforce', description: 'Automatically remediate non-compliance.' },
];

const versionOperators = [
  { value: 'eq', label: '= (exact)' },
  { value: 'gte', label: '>= (minimum)' },
  { value: 'gt', label: '> (above)' },
  { value: 'lte', label: '<= (maximum)' },
];

const osTypes = ['windows', 'macos', 'linux', 'any'];

function loadItems(existingLink: FeatureTabProps['existingLink']): ComplianceItem[] {
  const raw = existingLink?.inlineSettings as Record<string, unknown> | null | undefined;
  if (!raw) return [];
  if (Array.isArray((raw as any).items)) {
    return (raw as any).items as ComplianceItem[];
  }
  // Legacy single-item format — wrap it
  if ((raw as any).rules) {
    const legacy = raw as unknown as Omit<ComplianceItem, 'name'>;
    return [{ ...legacy, name: 'Compliance Rule Set 1' }];
  }
  return [];
}

function enforcementPill(level: EnforcementLevel) {
  const colors: Record<EnforcementLevel, string> = {
    monitor: 'bg-blue-500',
    warn: 'bg-yellow-500',
    enforce: 'bg-red-500',
  };
  const opt = enforcementOptions.find((o) => o.value === level);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium">
      <span className={`h-2 w-2 rounded-full ${colors[level] ?? 'bg-gray-400'}`} />
      {opt?.label ?? level}
    </span>
  );
}

export default function ComplianceTab({ policyId, existingLink, onLinkChanged, linkedPolicyId, parentLink }: FeatureTabProps) {
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const isInherited = !!parentLink && !existingLink;
  const effectiveLink = existingLink ?? parentLink;
  const [items, setItems] = useState<ComplianceItem[]>(() => loadItems(effectiveLink));
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setItems(loadItems(existingLink ?? parentLink));
  }, [existingLink, parentLink]);

  useEffect(() => {
    if (expandedIndex !== null) {
      const t = setTimeout(() => nameInputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [expandedIndex]);

  const updateItem = (index: number, patch: Partial<ComplianceItem>) => {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const updateRule = (itemIndex: number, ruleIndex: number, patch: Partial<ComplianceRule>) => {
    setItems((prev) =>
      prev.map((item, i) => {
        if (i !== itemIndex) return item;
        const rules = item.rules.map((r, ri) => (ri === ruleIndex ? { ...r, ...patch } : r));
        return { ...item, rules };
      })
    );
  };

  const addRule = (itemIndex: number) => {
    setItems((prev) =>
      prev.map((item, i) => {
        if (i !== itemIndex) return item;
        return { ...item, rules: [...item.rules, { type: 'required_software' as RuleType, softwareName: '', softwareVersion: '', versionOperator: 'gte' }] };
      })
    );
  };

  const removeRule = (itemIndex: number, ruleIndex: number) => {
    setItems((prev) =>
      prev.map((item, i) => {
        if (i !== itemIndex) return item;
        return { ...item, rules: item.rules.filter((_, ri) => ri !== ruleIndex) };
      })
    );
  };

  const addItem = () => {
    const newItem: ComplianceItem = { ...defaultItem, name: `Compliance Rule Set ${items.length + 1}`, rules: [{ ...defaultItem.rules[0] }] };
    setItems((prev) => [...prev, newItem]);
    setExpandedIndex(items.length);
  };

  const deleteItem = (index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
    if (expandedIndex === index) setExpandedIndex(null);
    else if (expandedIndex !== null && expandedIndex > index) setExpandedIndex(expandedIndex - 1);
  };

  const handleSave = async () => {
    clearError();
    const result = await save(existingLink?.id ?? null, {
      featureType: 'compliance',
      featurePolicyId: linkedPolicyId,
      inlineSettings: { items },
    });
    if (result) onLinkChanged(result, 'compliance');
  };

  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, 'compliance');
  };

  const handleOverride = async () => {
    clearError();
    const result = await save(null, {
      featureType: 'compliance',
      featurePolicyId: linkedPolicyId,
      inlineSettings: { items },
    });
    if (result) onLinkChanged(result, 'compliance');
  };

  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, 'compliance');
  };

  const meta = FEATURE_META.compliance;

  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<ClipboardCheck className="h-5 w-5" />}
      isConfigured={!!existingLink || isInherited}
      saving={saving}
      error={error}
      onSave={handleSave}
      onRemove={existingLink && !linkedPolicyId ? handleRemove : undefined}
      isInherited={isInherited}
      onOverride={isInherited ? handleOverride : undefined}
      onRevert={!isInherited && !!linkedPolicyId && !!existingLink ? handleRevert : undefined}
    >
      {/* Header with count + Add button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Compliance Rule Sets</h3>
          {items.length > 0 && (
            <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary/10 px-1.5 text-xs font-medium text-primary">
              {items.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={addItem}
          className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          <Plus className="h-4 w-4" /> Add Compliance Rule
        </button>
      </div>

      {/* Empty state */}
      {items.length === 0 && (
        <div className="mt-4 rounded-md border border-dashed p-8 text-center">
          <ClipboardCheck className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-2 text-sm text-muted-foreground">No compliance rule sets configured yet.</p>
          <button
            type="button"
            onClick={addItem}
            className="mt-3 inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> Add Compliance Rule
          </button>
        </div>
      )}

      {/* Item cards */}
      <div className="mt-3 space-y-2">
        {items.map((item, index) => {
          const isExpanded = expandedIndex === index;
          return (
            <div key={index} className="rounded-md border bg-muted/10">
              {/* Collapsed header */}
              <button
                type="button"
                onClick={() => setExpandedIndex(isExpanded ? null : index)}
                className="flex w-full items-center justify-between px-4 py-3 text-left"
              >
                <div className="flex items-center gap-3">
                  {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                  <span className="text-sm font-medium">{item.name || 'Untitled Rule Set'}</span>
                  {enforcementPill(item.enforcementLevel)}
                  <span className="text-xs text-muted-foreground">
                    {item.rules.length} rule{item.rules.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); deleteItem(index); }}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </button>

              {/* Expanded form */}
              {isExpanded && (
                <div className="border-t px-4 pb-4 pt-3 space-y-4">
                  {/* Name */}
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Rule Set Name</label>
                    <input
                      ref={nameInputRef}
                      value={item.name}
                      onChange={(e) => updateItem(index, { name: e.target.value })}
                      placeholder="e.g. Required Security Software"
                      className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>

                  {/* Rules */}
                  <div>
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-muted-foreground">Compliance Rules</label>
                      <button
                        type="button"
                        onClick={() => addRule(index)}
                        className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                      >
                        <Plus className="h-3 w-3" /> Add Rule
                      </button>
                    </div>
                    <div className="mt-2 space-y-2">
                      {item.rules.map((rule, ri) => (
                        <div key={ri} className="rounded-md border bg-muted/20 p-3">
                          <div className="flex items-start gap-2">
                            <div className="flex-1 space-y-2">
                              <div>
                                <label className="text-xs font-medium text-muted-foreground">Rule Type</label>
                                <select
                                  value={rule.type}
                                  onChange={(e) => updateRule(index, ri, { type: e.target.value as RuleType })}
                                  className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                >
                                  {ruleTypeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                              </div>

                              {rule.type === 'required_software' && (
                                <div className="grid gap-2 sm:grid-cols-3">
                                  <div>
                                    <label className="text-xs font-medium text-muted-foreground">Software Name</label>
                                    <input value={rule.softwareName ?? ''} onChange={(e) => updateRule(index, ri, { softwareName: e.target.value })} placeholder="e.g. CrowdStrike Falcon" className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" />
                                  </div>
                                  <div>
                                    <label className="text-xs font-medium text-muted-foreground">Version</label>
                                    <input value={rule.softwareVersion ?? ''} onChange={(e) => updateRule(index, ri, { softwareVersion: e.target.value })} placeholder="7.0.0" className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" />
                                  </div>
                                  <div>
                                    <label className="text-xs font-medium text-muted-foreground">Operator</label>
                                    <select value={rule.versionOperator ?? 'gte'} onChange={(e) => updateRule(index, ri, { versionOperator: e.target.value })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm">
                                      {versionOperators.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                    </select>
                                  </div>
                                </div>
                              )}

                              {rule.type === 'prohibited_software' && (
                                <div>
                                  <label className="text-xs font-medium text-muted-foreground">Software Name</label>
                                  <input value={rule.prohibitedName ?? ''} onChange={(e) => updateRule(index, ri, { prohibitedName: e.target.value })} placeholder="e.g. TeamViewer" className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" />
                                </div>
                              )}

                              {rule.type === 'disk_space_minimum' && (
                                <div className="grid gap-2 sm:grid-cols-2">
                                  <div>
                                    <label className="text-xs font-medium text-muted-foreground">Minimum GB</label>
                                    <input type="number" min={1} value={rule.minGb ?? 10} onChange={(e) => updateRule(index, ri, { minGb: Number(e.target.value) })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" />
                                  </div>
                                  <div>
                                    <label className="text-xs font-medium text-muted-foreground">Path (optional)</label>
                                    <input value={rule.diskPath ?? ''} onChange={(e) => updateRule(index, ri, { diskPath: e.target.value })} placeholder="C:\ or /" className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" />
                                  </div>
                                </div>
                              )}

                              {rule.type === 'os_version' && (
                                <div className="grid gap-2 sm:grid-cols-2">
                                  <div>
                                    <label className="text-xs font-medium text-muted-foreground">OS Type</label>
                                    <select value={rule.osType ?? 'any'} onChange={(e) => updateRule(index, ri, { osType: e.target.value })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm capitalize">
                                      {osTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                                    </select>
                                  </div>
                                  <div>
                                    <label className="text-xs font-medium text-muted-foreground">Minimum Version</label>
                                    <input value={rule.minOsVersion ?? ''} onChange={(e) => updateRule(index, ri, { minOsVersion: e.target.value })} placeholder="10.0.19045" className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" />
                                  </div>
                                </div>
                              )}

                              {rule.type === 'registry_check' && (
                                <div className="grid gap-2 sm:grid-cols-3">
                                  <div>
                                    <label className="text-xs font-medium text-muted-foreground">Registry Path</label>
                                    <input value={rule.registryPath ?? ''} onChange={(e) => updateRule(index, ri, { registryPath: e.target.value })} placeholder="HKLM\SOFTWARE\..." className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" />
                                  </div>
                                  <div>
                                    <label className="text-xs font-medium text-muted-foreground">Value Name</label>
                                    <input value={rule.registryValueName ?? ''} onChange={(e) => updateRule(index, ri, { registryValueName: e.target.value })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" />
                                  </div>
                                  <div>
                                    <label className="text-xs font-medium text-muted-foreground">Expected Value</label>
                                    <input value={rule.registryExpectedValue ?? ''} onChange={(e) => updateRule(index, ri, { registryExpectedValue: e.target.value })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" />
                                  </div>
                                </div>
                              )}

                              {rule.type === 'config_check' && (
                                <div className="grid gap-2 sm:grid-cols-3">
                                  <div>
                                    <label className="text-xs font-medium text-muted-foreground">File Path</label>
                                    <input value={rule.configFilePath ?? ''} onChange={(e) => updateRule(index, ri, { configFilePath: e.target.value })} placeholder="/etc/ssh/sshd_config" className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" />
                                  </div>
                                  <div>
                                    <label className="text-xs font-medium text-muted-foreground">Key</label>
                                    <input value={rule.configKey ?? ''} onChange={(e) => updateRule(index, ri, { configKey: e.target.value })} placeholder="PermitRootLogin" className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" />
                                  </div>
                                  <div>
                                    <label className="text-xs font-medium text-muted-foreground">Expected Value</label>
                                    <input value={rule.configExpectedValue ?? ''} onChange={(e) => updateRule(index, ri, { configExpectedValue: e.target.value })} placeholder="no" className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" />
                                  </div>
                                </div>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() => removeRule(index, ri)}
                              disabled={item.rules.length <= 1}
                              className="mt-4 flex h-8 w-8 items-center justify-center rounded-md text-destructive hover:bg-muted disabled:opacity-50"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Enforcement Level */}
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Enforcement Level</label>
                    <div className="mt-1.5 grid gap-2 sm:grid-cols-3">
                      {enforcementOptions.map((opt) => (
                        <label
                          key={opt.value}
                          className={`flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-sm transition ${
                            item.enforcementLevel === opt.value
                              ? 'border-primary/40 bg-primary/10 text-primary'
                              : 'border-muted text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          <input
                            type="radio"
                            name={`enforcement-${index}`}
                            value={opt.value}
                            checked={item.enforcementLevel === opt.value}
                            onChange={() => updateItem(index, { enforcementLevel: opt.value })}
                            className="hidden"
                          />
                          <span className="font-medium text-foreground">{opt.label}</span>
                          <span className="text-xs text-muted-foreground">{opt.description}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Check interval + remediation */}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Check Interval (minutes)</label>
                      <input
                        type="number"
                        min={5}
                        max={1440}
                        value={item.checkIntervalMinutes}
                        onChange={(e) => updateItem(index, { checkIntervalMinutes: Number(e.target.value) || 60 })}
                        className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Remediation Script ID (optional)</label>
                      <input
                        value={item.remediationScriptId}
                        onChange={(e) => updateItem(index, { remediationScriptId: e.target.value })}
                        placeholder="UUID of remediation script"
                        className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </FeatureTabShell>
  );
}
