import { useMemo, useState } from 'react';
import { ChevronRight, ListFilter, Plus, Save, Settings2, Sliders } from 'lucide-react';
import { cn } from '@/lib/utils';

export type PolicyType = 'security' | 'compliance' | 'network' | 'device' | 'maintenance';

export type PolicyDraft = {
  id: string;
  name: string;
  description: string;
  type: PolicyType;
  priority: number;
  settings: Record<string, string>;
};

export type PolicyCondition = {
  id: string;
  field: string;
  operator: string;
  value: string;
};

export type PolicyConditionGroup = {
  id: string;
  conjunction: 'AND' | 'OR';
  conditions: PolicyCondition[];
};

type PolicyEditorProps = {
  initialPolicy?: PolicyDraft;
  onSaveDraft?: (policy: PolicyDraft, groups: PolicyConditionGroup[]) => void;
  onSaveActive?: (policy: PolicyDraft, groups: PolicyConditionGroup[]) => void;
};

const policyTypes: Array<{ value: PolicyType; label: string }> = [
  { value: 'security', label: 'Security' },
  { value: 'compliance', label: 'Compliance' },
  { value: 'network', label: 'Network' },
  { value: 'device', label: 'Device' },
  { value: 'maintenance', label: 'Maintenance' }
];

const conditionFields = ['OS Version', 'Device Type', 'Site', 'Tag', 'Last Seen', 'Owner'];
const conditionOperators = ['equals', 'contains', 'starts with', 'in', 'greater than', 'less than'];

const settingsBlueprints: Record<
  PolicyType,
  Array<{ title: string; description: string; fields: Array<{ label: string; placeholder: string }> }>
> = {
  security: [
    {
      title: 'Threat Protection',
      description: 'Configure real-time scanning and blocking behavior.',
      fields: [
        { label: 'Realtime scanning', placeholder: 'Enabled' },
        { label: 'Malware response', placeholder: 'Quarantine' },
        { label: 'Cloud lookup', placeholder: 'On' }
      ]
    },
    {
      title: 'Firewall Rules',
      description: 'Control inbound and outbound access.',
      fields: [
        { label: 'Default inbound', placeholder: 'Block' },
        { label: 'Default outbound', placeholder: 'Allow' }
      ]
    }
  ],
  compliance: [
    {
      title: 'Baseline Standard',
      description: 'Select the compliance standard to validate against.',
      fields: [
        { label: 'Framework', placeholder: 'CIS Level 1' },
        { label: 'Reporting cadence', placeholder: 'Weekly' }
      ]
    },
    {
      title: 'Exception Handling',
      description: 'Define how exceptions are tracked.',
      fields: [
        { label: 'Approval workflow', placeholder: 'Manager review' },
        { label: 'Auto-expire', placeholder: '30 days' }
      ]
    }
  ],
  network: [
    {
      title: 'Network Access',
      description: 'Define Wi-Fi and VPN access expectations.',
      fields: [
        { label: 'Required SSID', placeholder: 'CorpNet' },
        { label: 'VPN enforcement', placeholder: 'Always on' }
      ]
    },
    {
      title: 'DNS Controls',
      description: 'Apply DNS filtering to endpoints.',
      fields: [
        { label: 'Primary resolver', placeholder: '1.1.1.1' },
        { label: 'Block categories', placeholder: 'Malware, Phishing' }
      ]
    }
  ],
  device: [
    {
      title: 'Device Experience',
      description: 'Lock down device capabilities.',
      fields: [
        { label: 'Kiosk mode', placeholder: 'Enabled' },
        { label: 'USB access', placeholder: 'Read-only' }
      ]
    },
    {
      title: 'Account Controls',
      description: 'Define login and screen policies.',
      fields: [
        { label: 'Screen lock', placeholder: '5 minutes' },
        { label: 'Local admin', placeholder: 'Restricted' }
      ]
    }
  ],
  maintenance: [
    {
      title: 'Patch Window',
      description: 'Schedule patching behavior.',
      fields: [
        { label: 'Install window', placeholder: 'Sundays 2-4 AM' },
        { label: 'Reboot policy', placeholder: 'Prompt after 2 hours' }
      ]
    },
    {
      title: 'Update Rings',
      description: 'Stage deployments across device groups.',
      fields: [
        { label: 'Ring 1', placeholder: 'IT Pilot' },
        { label: 'Ring 2', placeholder: 'All devices' }
      ]
    }
  ]
};

const mockPolicy: PolicyDraft = {
  id: 'pol-201',
  name: 'Endpoint Baseline',
  description: 'Ensure all corporate endpoints adhere to baseline security standards.',
  type: 'security',
  priority: 85,
  settings: {
    realtimeScanning: 'enabled',
    firewallDefault: 'block',
    vpnRequired: 'true'
  }
};

const mockGroups: PolicyConditionGroup[] = [
  {
    id: 'group-1',
    conjunction: 'AND',
    conditions: [
      { id: 'cond-1', field: 'Device Type', operator: 'equals', value: 'Laptop' },
      { id: 'cond-2', field: 'Site', operator: 'in', value: 'NYC, Austin' }
    ]
  },
  {
    id: 'group-2',
    conjunction: 'OR',
    conditions: [
      { id: 'cond-3', field: 'Tag', operator: 'contains', value: 'vip' },
      { id: 'cond-4', field: 'OS Version', operator: 'greater than', value: '13.0' }
    ]
  }
];

const mockAssignments = [
  { id: 'asg-1', name: 'Global HQ', type: 'Site', priority: 90 },
  { id: 'asg-2', name: 'Remote Workforce', type: 'Group', priority: 70 },
  { id: 'asg-3', name: 'Tier 1 Support', type: 'Group', priority: 80 }
];

export default function PolicyEditor({
  initialPolicy,
  onSaveDraft,
  onSaveActive
}: PolicyEditorProps) {
  const [activeTab, setActiveTab] = useState<'general' | 'settings' | 'conditions' | 'assignments'>(
    'general'
  );
  const [draft, setDraft] = useState<PolicyDraft>(initialPolicy ?? mockPolicy);
  const [groups, setGroups] = useState<PolicyConditionGroup[]>(mockGroups);

  const settingsSections = useMemo(() => settingsBlueprints[draft.type], [draft.type]);

  const handleDraftChange = (field: keyof PolicyDraft, value: string | number) => {
    setDraft(prev => ({ ...prev, [field]: value }));
  };

  const handleConditionChange = (
    groupId: string,
    conditionId: string,
    field: keyof PolicyCondition,
    value: string
  ) => {
    setGroups(prev =>
      prev.map(group => {
        if (group.id !== groupId) return group;
        return {
          ...group,
          conditions: group.conditions.map(condition =>
            condition.id === conditionId ? { ...condition, [field]: value } : condition
          )
        };
      })
    );
  };

  const handleAddCondition = (groupId: string) => {
    setGroups(prev =>
      prev.map(group => {
        if (group.id !== groupId) return group;
        return {
          ...group,
          conditions: [
            ...group.conditions,
            {
              id: `cond-${Date.now()}`,
              field: 'Device Type',
              operator: 'equals',
              value: ''
            }
          ]
        };
      })
    );
  };

  const handleRemoveCondition = (groupId: string, conditionId: string) => {
    setGroups(prev =>
      prev.map(group => {
        if (group.id !== groupId) return group;
        return {
          ...group,
          conditions: group.conditions.filter(condition => condition.id !== conditionId)
        };
      })
    );
  };

  const handleAddGroup = () => {
    setGroups(prev => [
      ...prev,
      {
        id: `group-${Date.now()}`,
        conjunction: 'AND',
        conditions: [
          { id: `cond-${Date.now()}-1`, field: 'Site', operator: 'equals', value: '' }
        ]
      }
    ]);
  };

  const handleRemoveGroup = (groupId: string) => {
    setGroups(prev => prev.filter(group => group.id !== groupId));
  };

  const handleSaveDraft = () => onSaveDraft?.(draft, groups);
  const handleSaveActive = () => onSaveActive?.(draft, groups);

  return (
    <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Policy Editor</h2>
          <p className="text-sm text-muted-foreground">
            Define policy scope, settings, and assignment conditions.
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Sliders className="h-4 w-4" />
          Priority {draft.priority}
        </div>
      </div>

      <div className="border-b">
        <div className="flex flex-wrap gap-4">
          {[
            { key: 'general', label: 'General', icon: Sliders },
            { key: 'settings', label: 'Settings', icon: Settings2 },
            { key: 'conditions', label: 'Conditions', icon: ListFilter },
            { key: 'assignments', label: 'Assignments', icon: ChevronRight }
          ].map(tab => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key as typeof activeTab)}
                className={cn(
                  'flex items-center gap-2 pb-3 text-sm font-medium transition-colors',
                  isActive
                    ? 'border-b-2 border-primary text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {activeTab === 'general' && (
        <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium" htmlFor="policy-name">
                Policy name
              </label>
              <input
                id="policy-name"
                type="text"
                value={draft.name}
                onChange={event => handleDraftChange('name', event.target.value)}
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="policy-description">
                Description
              </label>
              <textarea
                id="policy-description"
                value={draft.description}
                onChange={event => handleDraftChange('description', event.target.value)}
                className="mt-2 min-h-[120px] w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          <div className="space-y-4 rounded-lg border bg-muted/30 p-4">
            <div>
              <label className="text-sm font-medium" htmlFor="policy-type">
                Policy type
              </label>
              <select
                id="policy-type"
                value={draft.type}
                onChange={event => handleDraftChange('type', event.target.value as PolicyType)}
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {policyTypes.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="policy-priority">
                Priority
              </label>
              <div className="mt-2 flex items-center gap-3">
                <input
                  id="policy-priority"
                  type="range"
                  min={0}
                  max={100}
                  value={draft.priority}
                  onChange={event => handleDraftChange('priority', Number(event.target.value))}
                  className="w-full accent-primary"
                />
                <span className="w-10 text-right text-sm font-medium">{draft.priority}</span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Higher priority policies override lower ones.
              </p>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'settings' && (
        <div className="space-y-6">
          {settingsSections.map(section => (
            <div key={section.title} className="rounded-lg border bg-muted/30 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold">{section.title}</h3>
                  <p className="text-xs text-muted-foreground">{section.description}</p>
                </div>
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-muted"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add rule
                </button>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {section.fields.map(field => (
                  <div key={field.label}>
                    <label className="text-xs font-medium text-muted-foreground">
                      {field.label}
                    </label>
                    <input
                      type="text"
                      placeholder={field.placeholder}
                      className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'conditions' && (
        <div className="space-y-6">
          {groups.map((group, index) => (
            <div key={group.id} className="rounded-lg border bg-muted/30 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  Group {index + 1}
                  <select
                    value={group.conjunction}
                    onChange={event =>
                      setGroups(prev =>
                        prev.map(item =>
                          item.id === group.id
                            ? { ...item, conjunction: event.target.value as 'AND' | 'OR' }
                            : item
                        )
                      )
                    }
                    className="h-8 rounded-md border bg-background px-2 text-xs"
                  >
                    <option value="AND">AND</option>
                    <option value="OR">OR</option>
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleAddCondition(group.id)}
                    className="inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-muted"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add condition
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemoveGroup(group.id)}
                    className="inline-flex h-8 items-center gap-1 rounded-md border border-destructive/40 px-2 text-xs font-medium text-destructive hover:bg-destructive/10"
                  >
                    Remove group
                  </button>
                </div>
              </div>
              <div className="mt-4 space-y-3">
                {group.conditions.map(condition => (
                  <div
                    key={condition.id}
                    className="grid gap-3 rounded-md border bg-background p-3 md:grid-cols-[1.2fr_1fr_1fr_auto]"
                  >
                    <select
                      value={condition.field}
                      onChange={event =>
                        handleConditionChange(group.id, condition.id, 'field', event.target.value)
                      }
                      className="h-9 rounded-md border bg-background px-2 text-sm"
                    >
                      {conditionFields.map(field => (
                        <option key={field} value={field}>
                          {field}
                        </option>
                      ))}
                    </select>
                    <select
                      value={condition.operator}
                      onChange={event =>
                        handleConditionChange(group.id, condition.id, 'operator', event.target.value)
                      }
                      className="h-9 rounded-md border bg-background px-2 text-sm"
                    >
                      {conditionOperators.map(operator => (
                        <option key={operator} value={operator}>
                          {operator}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      placeholder="Value"
                      value={condition.value}
                      onChange={event =>
                        handleConditionChange(group.id, condition.id, 'value', event.target.value)
                      }
                      className="h-9 rounded-md border bg-background px-2 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => handleRemoveCondition(group.id, condition.id)}
                      className="h-9 rounded-md border border-destructive/40 px-2 text-xs font-medium text-destructive hover:bg-destructive/10"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={handleAddGroup}
            className="inline-flex h-10 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted"
          >
            <Plus className="h-4 w-4" />
            Add group
          </button>
        </div>
      )}

      {activeTab === 'assignments' && (
        <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
          <div className="rounded-lg border bg-muted/30 p-4">
            <h3 className="text-sm font-semibold">Assigned targets</h3>
            <p className="text-xs text-muted-foreground">
              Preview assignments and priority overrides before saving.
            </p>
            <div className="mt-4 space-y-3">
              {mockAssignments.map(assignment => (
                <div
                  key={assignment.id}
                  className="flex items-center justify-between rounded-md border bg-background px-3 py-2 text-sm"
                >
                  <div>
                    <div className="font-medium">{assignment.name}</div>
                    <div className="text-xs text-muted-foreground">{assignment.type}</div>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-primary">
                      Priority {assignment.priority}
                    </span>
                    <button type="button" className="text-xs text-primary hover:underline">
                      Edit
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-xs font-medium hover:bg-muted"
              >
                Manage assignments
              </button>
            </div>
          </div>

          <div className="rounded-lg border bg-muted/30 p-4">
            <h3 className="text-sm font-semibold">Assignment summary</h3>
            <div className="mt-4 space-y-3 text-sm text-muted-foreground">
              <div className="flex items-center justify-between">
                <span>Total targets</span>
                <span className="font-medium text-foreground">{mockAssignments.length}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Highest priority override</span>
                <span className="font-medium text-foreground">90</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Effective scope</span>
                <span className="font-medium text-foreground">164 devices</span>
              </div>
              <div className="rounded-md border bg-background p-3 text-xs">
                Target-specific overrides apply on top of the base policy priority.
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
        <button
          type="button"
          onClick={handleSaveDraft}
          className="inline-flex h-10 items-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-muted"
        >
          <Save className="h-4 w-4" />
          Save as draft
        </button>
        <button
          type="button"
          onClick={handleSaveActive}
          className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Save className="h-4 w-4" />
          Save and activate
        </button>
      </div>
    </div>
  );
}
