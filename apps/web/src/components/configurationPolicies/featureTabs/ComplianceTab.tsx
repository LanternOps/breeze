import { useState, useEffect, useRef } from 'react';
import { ClipboardCheck, Plus, Trash2, ChevronDown, ChevronRight, FileCode, Package, GripVertical } from 'lucide-react';
import type { FeatureTabProps } from './types';
import { FEATURE_META } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';
import RemediationScriptPicker, { type SelectedScript } from './RemediationScriptPicker';
import SoftwareCatalogPicker, { type SelectedSoftware } from './SoftwareCatalogPicker';

type RuleType = 'required_software' | 'prohibited_software' | 'disk_space_minimum' | 'os_version' | 'registry_check' | 'config_check';
type EnforcementLevel = 'monitor' | 'warn' | 'enforce';

type RemediationAction =
  | { type: 'script'; scriptId: string; scriptName?: string }
  | { type: 'software_deploy'; catalogId: string; versionId?: string; catalogName?: string }
  | { type: 'none' };

type ComplianceRule = {
  type: RuleType;
  description?: string;
  remediation?: RemediationAction;
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
};

const defaultItem: ComplianceItem = {
  name: '',
  rules: [{ type: 'required_software', softwareName: '', softwareVersion: '', versionOperator: 'gte' }],
  enforcementLevel: 'monitor',
  checkIntervalMinutes: 60,
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

function buildDefaultRemediation(ruleType: RuleType): RemediationAction {
  switch (ruleType) {
    case 'required_software': return { type: 'software_deploy', catalogId: '' };
    case 'prohibited_software':
    case 'registry_check':
    case 'config_check':
      return { type: 'script', scriptId: '' };
    default:
      return { type: 'none' };
  }
}

function loadItems(existingLink: FeatureTabProps['existingLink']): ComplianceItem[] {
  const raw = existingLink?.inlineSettings as Record<string, unknown> | null | undefined;
  if (!raw) return [];
  if (Array.isArray((raw as any).items)) {
    const items = (raw as any).items as (ComplianceItem & { remediationScriptId?: string })[];
    return items.map((item) => {
      if (item.remediationScriptId && item.rules.length > 0) {
        const hasAnyRemediation = item.rules.some((r) => r.remediation && r.remediation.type !== 'none');
        if (!hasAnyRemediation) {
          const rules = [...item.rules];
          rules[0] = {
            ...rules[0],
            remediation: { type: 'script', scriptId: item.remediationScriptId },
          };
          const { remediationScriptId: _, ...rest } = item;
          return { ...rest, rules };
        }
      }
      const { remediationScriptId: _, ...rest } = item;
      return rest;
    });
  }
  if ((raw as any).rules) {
    const legacy = raw as unknown as Omit<ComplianceItem, 'name'> & { remediationScriptId?: string };
    const { remediationScriptId: _, ...rest } = legacy;
    return [{ ...rest, name: 'Compliance Rule Set 1' }];
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

  const [scriptPickerRule, setScriptPickerRule] = useState<{ itemIndex: number; ruleIndex: number } | null>(null);
  const [softwarePickerRule, setSoftwarePickerRule] = useState<{ itemIndex: number; ruleIndex: number } | null>(null);

  const [dragIndex, setDragIndex] = useState<{ item: number; rule: number } | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<{ item: number; rule: number } | null>(null);

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
        const ruleType: RuleType = 'required_software';
        return {
          ...item,
          rules: [
            ...item.rules,
            { type: ruleType, softwareName: '', softwareVersion: '', versionOperator: 'gte', remediation: buildDefaultRemediation(ruleType) },
          ],
        };
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

  const updateRemediation = (itemIndex: number, ruleIndex: number, remediation: RemediationAction) => {
    updateRule(itemIndex, ruleIndex, { remediation });
  };

  const handleScriptSelected = (script: SelectedScript) => {
    if (!scriptPickerRule) return;
    updateRemediation(scriptPickerRule.itemIndex, scriptPickerRule.ruleIndex, {
      type: 'script',
      scriptId: script.id,
      scriptName: script.name,
    });
    setScriptPickerRule(null);
  };

  const handleSoftwareSelected = (software: SelectedSoftware) => {
    if (!softwarePickerRule) return;
    updateRemediation(softwarePickerRule.itemIndex, softwarePickerRule.ruleIndex, {
      type: 'software_deploy',
      catalogId: software.catalogId,
      catalogName: software.catalogName,
      versionId: software.versionId,
    });
    setSoftwarePickerRule(null);
  };

  const handleDragStart = (itemIndex: number, ruleIndex: number) => {
    setDragIndex({ item: itemIndex, rule: ruleIndex });
  };

  const handleDragOver = (e: React.DragEvent, itemIndex: number, ruleIndex: number) => {
    e.preventDefault();
    if (dragIndex && dragIndex.item === itemIndex) {
      setDragOverIndex({ item: itemIndex, rule: ruleIndex });
    }
  };

  const handleDrop = (itemIndex: number, ruleIndex: number) => {
    if (!dragIndex || dragIndex.item !== itemIndex) return;
    if (dragIndex.rule === ruleIndex) return;
    setItems((prev) =>
      prev.map((item, i) => {
        if (i !== itemIndex) return item;
        const rules = [...item.rules];
        const [moved] = rules.splice(dragIndex.rule, 1);
        rules.splice(ruleIndex, 0, moved);
        return { ...item, rules };
      })
    );
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const addItem = () => {
    const ruleType: RuleType = 'required_software';
    const newItem: ComplianceItem = {
      ...defaultItem,
      name: `Compliance Rule Set ${items.length + 1}`,
      rules: [{ ...defaultItem.rules[0], remediation: buildDefaultRemediation(ruleType) }],
    };
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
                      {item.rules.map((rule, ri) => {
                        const isDragOver = dragOverIndex?.item === index && dragOverIndex?.rule === ri && dragIndex?.item === index && dragIndex?.rule !== ri;
                        return (
                        <div
                          key={ri}
                          draggable
                          onDragStart={() => handleDragStart(index, ri)}
                          onDragOver={(e) => handleDragOver(e, index, ri)}
                          onDrop={() => handleDrop(index, ri)}
                          onDragEnd={handleDragEnd}
                          className={`rounded-md border bg-muted/20 p-3 ${isDragOver ? 'border-primary/40' : ''}`}
                        >
                          <div className="flex items-start gap-2">
                            <div className="mt-4 flex cursor-grab items-center text-muted-foreground hover:text-foreground">
                              <GripVertical className="h-4 w-4" />
                            </div>
                            <div className="flex-1 space-y-2">
                              <div>
                                <label className="text-xs font-medium text-muted-foreground">Rule Type</label>
                                <select
                                  value={rule.type}
                                  onChange={(e) => {
                                    const newType = e.target.value as RuleType;
                                    const patch: Partial<ComplianceRule> = { type: newType };
                                    const cur = rule.remediation;
                                    const hasConcreteSelection =
                                      (cur?.type === 'script' && 'scriptId' in cur && cur.scriptId) ||
                                      (cur?.type === 'software_deploy' && 'catalogId' in cur && cur.catalogId);
                                    if (!hasConcreteSelection) {
                                      patch.remediation = buildDefaultRemediation(newType);
                                    }
                                    updateRule(index, ri, patch);
                                  }}
                                  className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                >
                                  {ruleTypeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                              </div>

                              {/* Description (optional) */}
                              <div>
                                <label className="text-xs font-medium text-muted-foreground">Description (optional)</label>
                                <input
                                  value={rule.description ?? ''}
                                  onChange={(e) => updateRule(index, ri, { description: e.target.value })}
                                  placeholder="e.g. SOC2 requirement 3.1.a"
                                  className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                />
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

                              {/* Per-rule Remediation */}
                              <div className="mt-2 space-y-2">
                                <label className="text-xs font-medium text-muted-foreground">Remediation Action</label>
                                <div className="flex flex-wrap gap-2">
                                  <label
                                    className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                                      (!rule.remediation || rule.remediation.type === 'none')
                                        ? 'border-primary/40 bg-primary/10 text-primary'
                                        : 'border-muted text-muted-foreground hover:text-foreground'
                                    }`}
                                  >
                                    <input
                                      type="radio"
                                      name={`remediation-${index}-${ri}`}
                                      checked={!rule.remediation || rule.remediation.type === 'none'}
                                      onChange={() => updateRemediation(index, ri, { type: 'none' })}
                                      className="hidden"
                                    />
                                    None
                                  </label>
                                  <label
                                    className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                                      rule.remediation?.type === 'script'
                                        ? 'border-primary/40 bg-primary/10 text-primary'
                                        : 'border-muted text-muted-foreground hover:text-foreground'
                                    }`}
                                  >
                                    <input
                                      type="radio"
                                      name={`remediation-${index}-${ri}`}
                                      checked={rule.remediation?.type === 'script'}
                                      onChange={() => updateRemediation(index, ri, { type: 'script', scriptId: '' })}
                                      className="hidden"
                                    />
                                    <FileCode className="h-3.5 w-3.5" />
                                    Run Script
                                  </label>
                                  <label
                                    className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                                      rule.remediation?.type === 'software_deploy'
                                        ? 'border-primary/40 bg-primary/10 text-primary'
                                        : 'border-muted text-muted-foreground hover:text-foreground'
                                    }`}
                                  >
                                    <input
                                      type="radio"
                                      name={`remediation-${index}-${ri}`}
                                      checked={rule.remediation?.type === 'software_deploy'}
                                      onChange={() => updateRemediation(index, ri, { type: 'software_deploy', catalogId: '' })}
                                      className="hidden"
                                    />
                                    <Package className="h-3.5 w-3.5" />
                                    Deploy Software
                                  </label>
                                </div>

                                {/* Script picker display */}
                                {rule.remediation?.type === 'script' && (
                                  <div>
                                    {rule.remediation.scriptName ? (
                                      <div className="flex items-center gap-2">
                                        <span className="inline-flex items-center gap-1.5 rounded-full border bg-muted/30 px-3 py-1 text-xs font-medium">
                                          <FileCode className="h-3 w-3" />
                                          {rule.remediation.scriptName}
                                        </span>
                                        <button
                                          type="button"
                                          onClick={() => setScriptPickerRule({ itemIndex: index, ruleIndex: ri })}
                                          className="text-xs text-primary hover:underline"
                                        >
                                          Change
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => updateRemediation(index, ri, { type: 'script', scriptId: '' })}
                                          className="text-xs text-destructive hover:underline"
                                        >
                                          <Trash2 className="h-3 w-3" />
                                        </button>
                                      </div>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => setScriptPickerRule({ itemIndex: index, ruleIndex: ri })}
                                        className="w-full rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground hover:border-primary/40 hover:text-primary"
                                      >
                                        Select a remediation script...
                                      </button>
                                    )}
                                  </div>
                                )}

                                {/* Software picker display */}
                                {rule.remediation?.type === 'software_deploy' && (
                                  <div>
                                    {rule.remediation.catalogName ? (
                                      <div className="flex items-center gap-2">
                                        <span className="inline-flex items-center gap-1.5 rounded-full border bg-muted/30 px-3 py-1 text-xs font-medium">
                                          <Package className="h-3 w-3" />
                                          {rule.remediation.catalogName}
                                        </span>
                                        <button
                                          type="button"
                                          onClick={() => setSoftwarePickerRule({ itemIndex: index, ruleIndex: ri })}
                                          className="text-xs text-primary hover:underline"
                                        >
                                          Change
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => updateRemediation(index, ri, { type: 'software_deploy', catalogId: '' })}
                                          className="text-xs text-destructive hover:underline"
                                        >
                                          <Trash2 className="h-3 w-3" />
                                        </button>
                                      </div>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => setSoftwarePickerRule({ itemIndex: index, ruleIndex: ri })}
                                        className="w-full rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground hover:border-primary/40 hover:text-primary"
                                      >
                                        Select software to deploy...
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
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
                        );
                      })}
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

                  {/* Check interval */}
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
                </div>
              )}
            </div>
          );
        })}
      </div>

      <RemediationScriptPicker
        isOpen={!!scriptPickerRule}
        onClose={() => setScriptPickerRule(null)}
        onSelect={handleScriptSelected}
      />
      <SoftwareCatalogPicker
        isOpen={!!softwarePickerRule}
        onClose={() => setSoftwarePickerRule(null)}
        onSelect={handleSoftwareSelected}
      />
    </FeatureTabShell>
  );
}
