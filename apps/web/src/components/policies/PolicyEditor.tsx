import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Filter,
  GripVertical,
  Plus,
  RefreshCw,
  Save,
  Trash2
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import type { FilterConditionGroup } from '@breeze/shared';
import { FilterBuilder, DEFAULT_FILTER_FIELDS } from '../filters/FilterBuilder';
import { FilterPreview } from '../filters/FilterPreview';
import { useFilterPreview } from '../../hooks/useFilterPreview';

export type SeverityLevel = 'low' | 'medium' | 'high' | 'critical';
export type PolicyStatus = 'draft' | 'active' | 'inactive' | 'archived';
export type ConditionType =
  | 'registry_key'
  | 'file_exists'
  | 'service_status'
  | 'process_running'
  | 'wmi_query';
export type ConditionConjunction = 'AND' | 'OR';
export type RemediationActionType =
  | 'run_script'
  | 'restart_service'
  | 'run_command'
  | 'restart_device'
  | 'notify';

export type RegistryCondition = {
  id: string;
  type: 'registry_key';
  hive: 'HKLM' | 'HKCU' | 'HKCR' | 'HKU' | 'HKCC';
  keyPath: string;
  valueName: string;
  operator: 'equals' | 'not_equals' | 'contains';
  expectedValue: string;
};

export type FileExistsCondition = {
  id: string;
  type: 'file_exists';
  path: string;
  shouldExist: boolean;
};

export type ServiceStatusCondition = {
  id: string;
  type: 'service_status';
  serviceName: string;
  status: 'running' | 'stopped' | 'paused';
};

export type ProcessRunningCondition = {
  id: string;
  type: 'process_running';
  processName: string;
  isRunning: boolean;
};

export type WmiQueryCondition = {
  id: string;
  type: 'wmi_query';
  query: string;
  comparator: 'equals' | 'contains' | 'greater_than' | 'less_than';
  expectedValue: string;
};

export type PolicyCondition =
  | RegistryCondition
  | FileExistsCondition
  | ServiceStatusCondition
  | ProcessRunningCondition
  | WmiQueryCondition;

export type PolicyConditionGroup = {
  id: string;
  conjunction: ConditionConjunction;
  conditions: PolicyCondition[];
};

export type RemediationAction = {
  id: string;
  type: RemediationActionType;
  label: string;
  scriptId?: string;
  serviceName?: string;
  command?: string;
  notifyChannel?: string;
};

export type ScheduleConfig = {
  frequency: '15m' | '1h' | '6h' | 'daily';
  windowStart: string;
  windowEnd: string;
  timezone: string;
  days: string[];
};

export type TargetScope = {
  organizations: string[];
  sites: string[];
  groups: string[];
};

export type RemediationConfig = {
  onFailure: 'stop' | 'continue';
  actions: RemediationAction[];
};

export type PolicyRuleDefinition = {
  version: number;
  severity: SeverityLevel;
  groupLogic: ConditionConjunction;
  conditionGroups: PolicyConditionGroup[];
  remediation: RemediationConfig;
  schedule: ScheduleConfig;
  complianceThreshold: number;
  targetScope: TargetScope;
};

export type PolicyEditorState = {
  id: string;
  name: string;
  description: string;
  status: PolicyStatus;
  severity: SeverityLevel;
  groupLogic: ConditionConjunction;
  conditionGroups: PolicyConditionGroup[];
  remediation: RemediationConfig;
  schedule: ScheduleConfig;
  complianceThreshold: number;
  targetScope: TargetScope;
};

type PolicyEditorProps = {
  policyId?: string;
};

type PolicyResponse = {
  id: string;
  name: string;
  description?: string;
  status?: PolicyStatus;
  rules?: unknown[];
  checkIntervalMinutes?: number;
};

type OptionItem = { id: string; name: string };

type DragPayload = { groupId: string; conditionId: string };

type RulePayload = {
  type: string;
  definition: PolicyRuleDefinition;
};

const severityOptions: Array<{ value: SeverityLevel; label: string; description: string }> = [
  { value: 'low', label: 'Low', description: 'Informational or low impact deviations.' },
  { value: 'medium', label: 'Medium', description: 'Requires attention but not urgent.' },
  { value: 'high', label: 'High', description: 'Immediate action is recommended.' },
  { value: 'critical', label: 'Critical', description: 'Blocker level risk to address fast.' }
];

const conditionTypeOptions: Array<{ value: ConditionType; label: string; description: string }> = [
  {
    value: 'registry_key',
    label: 'Registry key check',
    description: 'Validate a registry key path and expected value.'
  },
  {
    value: 'file_exists',
    label: 'File exists',
    description: 'Confirm a file path exists on disk.'
  },
  {
    value: 'service_status',
    label: 'Service status',
    description: 'Check Windows service state.'
  },
  {
    value: 'process_running',
    label: 'Process running',
    description: 'Detect whether a process is active.'
  },
  {
    value: 'wmi_query',
    label: 'WMI query',
    description: 'Run a WMI query and compare its output.'
  }
];

const remediationActionOptions: Array<{ value: RemediationActionType; label: string; description: string }> =
  [
    {
      value: 'run_script',
      label: 'Run script',
      description: 'Execute a remediation script on the device.'
    },
    {
      value: 'restart_service',
      label: 'Restart service',
      description: 'Restart a Windows service by name.'
    },
    {
      value: 'run_command',
      label: 'Run command',
      description: 'Execute a command as a remediation step.'
    },
    {
      value: 'restart_device',
      label: 'Restart device',
      description: 'Schedule a device restart.'
    },
    {
      value: 'notify',
      label: 'Notify',
      description: 'Send a notification to responders.'
    }
  ];

const scheduleOptions: Array<{ value: ScheduleConfig['frequency']; label: string; minutes: number }> =
  [
    { value: '15m', label: 'Every 15 minutes', minutes: 15 },
    { value: '1h', label: 'Every hour', minutes: 60 },
    { value: '6h', label: 'Every 6 hours', minutes: 360 },
    { value: 'daily', label: 'Daily', minutes: 1440 }
  ];

const weekDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const timezones = ['Local', 'UTC', 'America/New_York', 'Europe/London', 'Asia/Singapore'];

let idCounter = 0;
const createId = (prefix: string = 'id') => {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
};

const createCondition = (type: ConditionType, id = createId()): PolicyCondition => {
  switch (type) {
    case 'registry_key':
      return {
        id,
        type,
        hive: 'HKLM',
        keyPath: '',
        valueName: '',
        operator: 'equals',
        expectedValue: ''
      };
    case 'file_exists':
      return {
        id,
        type,
        path: '',
        shouldExist: true
      };
    case 'service_status':
      return {
        id,
        type,
        serviceName: '',
        status: 'running'
      };
    case 'process_running':
      return {
        id,
        type,
        processName: '',
        isRunning: true
      };
    case 'wmi_query':
      return {
        id,
        type,
        query: '',
        comparator: 'equals',
        expectedValue: ''
      };
    default:
      return {
        id,
        type: 'file_exists',
        path: '',
        shouldExist: true
      };
  }
};

const createConditionGroup = (): PolicyConditionGroup => ({
  id: createId(),
  conjunction: 'AND',
  conditions: [createCondition('registry_key')]
});

const createRemediationAction = (type: RemediationActionType, id = createId()): RemediationAction => {
  switch (type) {
    case 'restart_service':
      return { id, type, label: 'Restart service', serviceName: '' };
    case 'run_command':
      return { id, type, label: 'Run command', command: '' };
    case 'restart_device':
      return { id, type, label: 'Restart device' };
    case 'notify':
      return { id, type, label: 'Notify', notifyChannel: '' };
    case 'run_script':
    default:
      return { id, type: 'run_script', label: 'Run script', scriptId: '' };
  }
};

const createDefaultState = (policyId?: string): PolicyEditorState => ({
  id: policyId ?? createId(),
  name: '',
  description: '',
  status: 'draft',
  severity: 'medium',
  groupLogic: 'AND',
  conditionGroups: [createConditionGroup()],
  remediation: {
    onFailure: 'stop',
    actions: []
  },
  schedule: {
    frequency: 'daily',
    windowStart: '08:00',
    windowEnd: '18:00',
    timezone: 'Local',
    days: [...weekDays]
  },
  complianceThreshold: 90,
  targetScope: {
    organizations: [],
    sites: [],
    groups: []
  }
});

const extractRuleDefinition = (rules?: unknown[]): PolicyRuleDefinition | undefined => {
  if (!Array.isArray(rules)) return undefined;

  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    if ('definition' in rule) {
      const definition = (rule as RulePayload).definition;
      if (definition && typeof definition === 'object') {
        return definition as PolicyRuleDefinition;
      }
    }

    if ('conditionGroups' in rule) {
      return rule as PolicyRuleDefinition;
    }
  }

  return undefined;
};

const getFrequencyFromMinutes = (minutes?: number): ScheduleConfig['frequency'] => {
  if (!minutes) return 'daily';
  if (minutes <= 15) return '15m';
  if (minutes <= 60) return '1h';
  if (minutes <= 360) return '6h';
  return 'daily';
};

const buildRulePayload = (state: PolicyEditorState): RulePayload[] => [
  {
    type: 'policy_definition',
    definition: {
      version: 1,
      severity: state.severity,
      groupLogic: state.groupLogic,
      conditionGroups: state.conditionGroups,
      remediation: state.remediation,
      schedule: state.schedule,
      complianceThreshold: state.complianceThreshold,
      targetScope: state.targetScope
    }
  }
];

export default function PolicyEditor({ policyId }: PolicyEditorProps) {
  const [policyState, setPolicyState] = useState<PolicyEditorState>(() =>
    createDefaultState(policyId)
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [targetsError, setTargetsError] = useState<string>();
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [organizations, setOrganizations] = useState<OptionItem[]>([]);
  const [sites, setSites] = useState<OptionItem[]>([]);
  const [groups, setGroups] = useState<OptionItem[]>([]);
  const [scripts, setScripts] = useState<OptionItem[]>([]);
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [dragOver, setDragOver] = useState<DragPayload | null>(null);
  const [targetMode, setTargetMode] = useState<'hierarchy' | 'filter'>('hierarchy');
  const [filterConditions, setFilterConditions] = useState<FilterConditionGroup>({
    operator: 'AND',
    conditions: []
  });
  const { preview: filterPreview, loading: filterPreviewLoading } = useFilterPreview(filterConditions, {
    enabled: targetMode === 'filter' && filterConditions.conditions.length > 0
  });

  const enabled = policyState.status === 'active';

  const resolveFrequencyMinutes = useMemo(() => {
    const selected = scheduleOptions.find(option => option.value === policyState.schedule.frequency);
    return selected?.minutes ?? 1440;
  }, [policyState.schedule.frequency]);

  const updatePolicyState = useCallback(
    (patch: Partial<PolicyEditorState>) => {
      setPolicyState(prev => ({ ...prev, ...patch }));
    },
    [setPolicyState]
  );

  const updateSchedule = (patch: Partial<ScheduleConfig>) => {
    setPolicyState(prev => ({
      ...prev,
      schedule: {
        ...prev.schedule,
        ...patch
      }
    }));
  };

  const updateTargetScope = (scope: keyof TargetScope, id: string) => {
    setPolicyState(prev => {
      const selected = prev.targetScope[scope];
      const next = selected.includes(id)
        ? selected.filter(item => item !== id)
        : [...selected, id];
      return {
        ...prev,
        targetScope: {
          ...prev.targetScope,
          [scope]: next
        }
      };
    });
  };

  const updateRemediationAction = (actionId: string, patch: Partial<RemediationAction>) => {
    setPolicyState(prev => ({
      ...prev,
      remediation: {
        ...prev.remediation,
        actions: prev.remediation.actions.map(action =>
          action.id === actionId ? { ...action, ...patch } : action
        )
      }
    }));
  };

  const replaceRemediationAction = (actionId: string, type: RemediationActionType) => {
    setPolicyState(prev => ({
      ...prev,
      remediation: {
        ...prev.remediation,
        actions: prev.remediation.actions.map(action =>
          action.id === actionId ? createRemediationAction(type, actionId) : action
        )
      }
    }));
  };

  const updateCondition = (
    groupId: string,
    conditionId: string,
    patch: Partial<PolicyCondition>
  ) => {
    setPolicyState(prev => ({
      ...prev,
      conditionGroups: prev.conditionGroups.map(group => {
        if (group.id !== groupId) return group;
        return {
          ...group,
          conditions: group.conditions.map(condition =>
            condition.id === conditionId ? { ...condition, ...patch } : condition
          )
        };
      })
    }));
  };

  const handleConditionTypeChange = (groupId: string, conditionId: string, type: ConditionType) => {
    setPolicyState(prev => ({
      ...prev,
      conditionGroups: prev.conditionGroups.map(group => {
        if (group.id !== groupId) return group;
        return {
          ...group,
          conditions: group.conditions.map(condition =>
            condition.id === conditionId ? { ...createCondition(type, conditionId) } : condition
          )
        };
      })
    }));
  };

  const moveCondition = (
    fromGroupId: string,
    conditionId: string,
    toGroupId: string,
    targetConditionId?: string
  ) => {
    setPolicyState(prev => {
      let moved: PolicyCondition | undefined;

      const withoutSource = prev.conditionGroups.map(group => {
        if (group.id !== fromGroupId) return group;
        const conditionIndex = group.conditions.findIndex(condition => condition.id === conditionId);
        if (conditionIndex === -1) return group;
        moved = group.conditions[conditionIndex];
        return {
          ...group,
          conditions: group.conditions.filter(condition => condition.id !== conditionId)
        };
      });

      if (!moved) return prev;

      const nextGroups = withoutSource.map(group => {
        if (group.id !== toGroupId) return group;
        const insertIndex = targetConditionId
          ? group.conditions.findIndex(condition => condition.id === targetConditionId)
          : group.conditions.length;
        const safeIndex = insertIndex === -1 ? group.conditions.length : insertIndex;
        const nextConditions = [...group.conditions];
        nextConditions.splice(safeIndex, 0, moved as PolicyCondition);
        return {
          ...group,
          conditions: nextConditions
        };
      });

      return {
        ...prev,
        conditionGroups: nextGroups
      };
    });
  };

  const handleDragStart = (payload: DragPayload) => (event: DragEvent<HTMLDivElement>) => {
    setDragging(payload);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', JSON.stringify(payload));
  };

  const handleDragOver = (payload: DragPayload) => (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(payload);
    event.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (payload: DragPayload) => (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const data = event.dataTransfer.getData('text/plain');
    try {
      const parsed = JSON.parse(data) as DragPayload;
      moveCondition(parsed.groupId, parsed.conditionId, payload.groupId, payload.conditionId);
    } catch {
      // Ignore invalid drop payloads.
    } finally {
      setDragging(null);
      setDragOver(null);
    }
  };

  const handleDropToGroupEnd = (groupId: string) => (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const data = event.dataTransfer.getData('text/plain');
    try {
      const parsed = JSON.parse(data) as DragPayload;
      moveCondition(parsed.groupId, parsed.conditionId, groupId);
    } catch {
      // Ignore invalid drop payloads.
    } finally {
      setDragging(null);
      setDragOver(null);
    }
  };

  const fetchPolicy = useCallback(async () => {
    if (!policyId) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth(`/policies/${policyId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch policy');
      }
      const data = (await response.json()) as PolicyResponse | { policy?: PolicyResponse };
      const policy = 'policy' in data && data.policy ? data.policy : (data as PolicyResponse);
      const defaultState = createDefaultState(policy.id);
      const definition = extractRuleDefinition(policy.rules ?? []);

      setPolicyState({
        ...defaultState,
        id: policy.id,
        name: policy.name ?? '',
        description: policy.description ?? '',
        status: policy.status ?? 'draft',
        severity: definition?.severity ?? defaultState.severity,
        groupLogic: definition?.groupLogic ?? defaultState.groupLogic,
        conditionGroups:
          definition?.conditionGroups?.length && definition.conditionGroups.length > 0
            ? definition.conditionGroups
            : defaultState.conditionGroups,
        remediation: definition?.remediation ?? defaultState.remediation,
        schedule: {
          ...defaultState.schedule,
          ...definition?.schedule,
          frequency: definition?.schedule?.frequency ?? getFrequencyFromMinutes(policy.checkIntervalMinutes)
        },
        complianceThreshold: definition?.complianceThreshold ?? defaultState.complianceThreshold,
        targetScope: definition?.targetScope ?? defaultState.targetScope
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [policyId]);

  const fetchTargets = useCallback(async () => {
    try {
      setTargetsLoading(true);
      setTargetsError(undefined);
      const [orgRes, siteRes, groupRes] = await Promise.all([
        fetchWithAuth('/orgs/organizations'),
        fetchWithAuth('/orgs/sites'),
        fetchWithAuth('/groups')
      ]);

      if (orgRes.ok) {
        const data = await orgRes.json();
        setOrganizations(data.data ?? data.organizations ?? data ?? []);
      }
      if (siteRes.ok) {
        const data = await siteRes.json();
        setSites(data.data ?? data.sites ?? data ?? []);
      }
      if (groupRes.ok) {
        const data = await groupRes.json();
        setGroups(data.data ?? data.groups ?? data ?? []);
      }
    } catch (err) {
      setTargetsError(err instanceof Error ? err.message : 'Failed to load targets');
    } finally {
      setTargetsLoading(false);
    }
  }, []);

  const fetchScripts = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/scripts');
      if (!response.ok) return;
      const data = await response.json();
      setScripts(data.data ?? data.scripts ?? data ?? []);
    } catch {
      // ignore script loading errors
    }
  }, []);

  const handleSave = async () => {
    if (!policyId) return;

    try {
      setSaving(true);
      setSaveError(undefined);
      const payload = {
        name: policyState.name,
        description: policyState.description,
        rules: buildRulePayload(policyState),
        checkIntervalMinutes: resolveFrequencyMinutes
      };
      const response = await fetchWithAuth(`/policies/${policyId}`,
        {
          method: 'PATCH',
          body: JSON.stringify(payload)
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save policy');
      }

      const updated = (await response.json()) as PolicyResponse;
      const definition = extractRuleDefinition(updated.rules ?? []);
      setPolicyState(prev => ({
        ...prev,
        status: updated.status ?? prev.status,
        schedule: {
          ...prev.schedule,
          frequency: definition?.schedule?.frequency ?? prev.schedule.frequency
        }
      }));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save policy');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!policyId) return;
    const confirmed = window.confirm('Archive this policy?');
    if (!confirmed) return;

    try {
      setDeleting(true);
      setSaveError(undefined);
      const response = await fetchWithAuth(`/policies/${policyId}`,
        {
          method: 'DELETE'
        }
      );
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to delete policy');
      }
      window.location.href = '/policies';
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to delete policy');
    } finally {
      setDeleting(false);
    }
  };

  const handleToggleEnabled = async () => {
    if (!policyId) return;

    try {
      setUpdatingStatus(true);
      setSaveError(undefined);
      const endpoint = enabled ? 'deactivate' : 'activate';
      const response = await fetchWithAuth(`/policies/${policyId}/${endpoint}`,
        {
          method: 'POST'
        }
      );
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update status');
      }
      const updated = (await response.json()) as PolicyResponse;
      setPolicyState(prev => ({
        ...prev,
        status: updated.status ?? prev.status
      }));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to update status');
    } finally {
      setUpdatingStatus(false);
    }
  };

  const addCondition = (groupId: string) => {
    setPolicyState(prev => ({
      ...prev,
      conditionGroups: prev.conditionGroups.map(group =>
        group.id === groupId
          ? { ...group, conditions: [...group.conditions, createCondition('file_exists')] }
          : group
      )
    }));
  };

  const removeCondition = (groupId: string, conditionId: string) => {
    setPolicyState(prev => ({
      ...prev,
      conditionGroups: prev.conditionGroups.map(group =>
        group.id === groupId
          ? {
              ...group,
              conditions: group.conditions.filter(condition => condition.id !== conditionId)
            }
          : group
      )
    }));
  };

  const addGroup = () => {
    setPolicyState(prev => ({
      ...prev,
      conditionGroups: [...prev.conditionGroups, createConditionGroup()]
    }));
  };

  const removeGroup = (groupId: string) => {
    setPolicyState(prev => ({
      ...prev,
      conditionGroups: prev.conditionGroups.filter(group => group.id !== groupId)
    }));
  };

  const addRemediationAction = (type: RemediationActionType) => {
    setPolicyState(prev => ({
      ...prev,
      remediation: {
        ...prev.remediation,
        actions: [...prev.remediation.actions, createRemediationAction(type)]
      }
    }));
  };

  const removeRemediationAction = (actionId: string) => {
    setPolicyState(prev => ({
      ...prev,
      remediation: {
        ...prev.remediation,
        actions: prev.remediation.actions.filter(action => action.id !== actionId)
      }
    }));
  };

  const toggleDay = (day: string) => {
    setPolicyState(prev => {
      const days = prev.schedule.days.includes(day)
        ? prev.schedule.days.filter(item => item !== day)
        : [...prev.schedule.days, day];
      return {
        ...prev,
        schedule: {
          ...prev.schedule,
          days
        }
      };
    });
  };

  const handleInitialize = useCallback(() => {
    fetchPolicy();
    fetchTargets();
    fetchScripts();
  }, [fetchPolicy, fetchTargets, fetchScripts]);

  useEffect(() => {
    handleInitialize();
  }, [handleInitialize]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading policy...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={handleInitialize}
          className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <RefreshCw className="h-4 w-4" />
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <a
            href="/policies"
            className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted"
          >
            <ArrowLeft className="h-5 w-5" />
          </a>
          <div>
            <h1 className="text-2xl font-bold">Policy Editor</h1>
            <p className="text-sm text-muted-foreground">
              Manage policy rules, remediation, and deployment scope.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4 rounded-lg border bg-muted/40 px-4 py-3">
          <div>
            <p className="text-xs uppercase text-muted-foreground">Status</p>
            <div className="mt-1 flex items-center gap-2 text-sm font-medium">
              <span
                className={cn(
                  'inline-flex h-2.5 w-2.5 rounded-full',
                  policyState.status === 'active' && 'bg-emerald-500',
                  policyState.status === 'inactive' && 'bg-amber-500',
                  policyState.status === 'draft' && 'bg-blue-500',
                  policyState.status === 'archived' && 'bg-muted-foreground'
                )}
              />
              {policyState.status}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Enabled</span>
            <button
              type="button"
              onClick={handleToggleEnabled}
              disabled={updatingStatus || policyState.status === 'archived'}
              className={cn(
                'relative inline-flex h-6 w-11 items-center rounded-full transition',
                enabled ? 'bg-primary' : 'bg-muted-foreground/30',
                (updatingStatus || policyState.status === 'archived') && 'opacity-70'
              )}
              aria-pressed={enabled}
            >
              <span
                className={cn(
                  'inline-block h-4 w-4 transform rounded-full bg-background transition',
                  enabled ? 'translate-x-6' : 'translate-x-1'
                )}
              />
            </button>
          </div>
        </div>
      </div>

      {saveError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {saveError}
        </div>
      )}

      <div className="rounded-lg border bg-card p-6 shadow-sm space-y-8">
        <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium" htmlFor="policy-name">
                Policy name
              </label>
              <input
                id="policy-name"
                type="text"
                value={policyState.name}
                onChange={event => updatePolicyState({ name: event.target.value })}
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="policy-description">
                Description
              </label>
              <textarea
                id="policy-description"
                value={policyState.description}
                onChange={event => updatePolicyState({ description: event.target.value })}
                className="mt-2 min-h-[120px] w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          <div className="space-y-4 rounded-lg border bg-muted/30 p-4">
            <div>
              <label className="text-sm font-medium" htmlFor="policy-severity">
                Severity level
              </label>
              <select
                id="policy-severity"
                value={policyState.severity}
                onChange={event =>
                  updatePolicyState({ severity: event.target.value as SeverityLevel })
                }
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {severityOptions.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="mt-2 text-xs text-muted-foreground">
                {severityOptions.find(option => option.value === policyState.severity)?.description}
              </p>
            </div>
            <div>
              <label className="text-sm font-medium">Compliance threshold</label>
              <div className="mt-2 flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={policyState.complianceThreshold}
                  onChange={event =>
                    updatePolicyState({
                      complianceThreshold: Number(event.target.value)
                    })
                  }
                  className="w-full accent-primary"
                />
                <span className="w-12 text-right text-sm font-medium">
                  {policyState.complianceThreshold}%
                </span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Minimum percentage of conditions required for compliance.
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">Rule builder</h2>
              <p className="text-xs text-muted-foreground">
                Drag and drop conditions to reorder or move between groups.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Group logic</span>
              <select
                value={policyState.groupLogic}
                onChange={event =>
                  updatePolicyState({ groupLogic: event.target.value as ConditionConjunction })
                }
                className="h-9 rounded-md border bg-background px-3 text-xs font-medium"
              >
                <option value="AND">Match all groups (AND)</option>
                <option value="OR">Match any group (OR)</option>
              </select>
            </div>
          </div>

          <div className="space-y-4">
            {policyState.conditionGroups.map((group, groupIndex) => (
              <div key={group.id} className="rounded-lg border bg-muted/30 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    Group {groupIndex + 1}
                    <select
                      value={group.conjunction}
                      onChange={event =>
                        setPolicyState(prev => ({
                          ...prev,
                          conditionGroups: prev.conditionGroups.map(item =>
                            item.id === group.id
                              ? {
                                  ...item,
                                  conjunction: event.target.value as ConditionConjunction
                                }
                              : item
                          )
                        }))
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
                      onClick={() => addCondition(group.id)}
                      className="inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-muted"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add condition
                    </button>
                    <button
                      type="button"
                      onClick={() => removeGroup(group.id)}
                      className="inline-flex h-8 items-center gap-1 rounded-md border border-destructive/40 px-2 text-xs font-medium text-destructive hover:bg-destructive/10"
                    >
                      Remove group
                    </button>
                  </div>
                </div>

                <div className="mt-4 space-y-3">
                  {group.conditions.map(condition => {
                    const isDragOver =
                      dragOver?.groupId === group.id && dragOver?.conditionId === condition.id;
                    const isDragging =
                      dragging?.groupId === group.id && dragging?.conditionId === condition.id;

                    return (
                      <div
                        key={condition.id}
                        draggable
                        onDragStart={handleDragStart({
                          groupId: group.id,
                          conditionId: condition.id
                        })}
                        onDragEnd={() => {
                          setDragging(null);
                          setDragOver(null);
                        }}
                        onDragOver={handleDragOver({
                          groupId: group.id,
                          conditionId: condition.id
                        })}
                        onDrop={handleDrop({
                          groupId: group.id,
                          conditionId: condition.id
                        })}
                        className={cn(
                          'grid gap-3 rounded-md border bg-background p-3 md:grid-cols-[auto_1.4fr_1fr_1fr_auto]',
                          isDragOver && 'ring-2 ring-primary/40',
                          isDragging && 'opacity-70'
                        )}
                      >
                        <div className="flex items-center justify-center text-muted-foreground">
                          <GripVertical className="h-4 w-4" />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-muted-foreground">
                            Condition type
                          </label>
                          <select
                            value={condition.type}
                            onChange={event =>
                              handleConditionTypeChange(
                                group.id,
                                condition.id,
                                event.target.value as ConditionType
                              )
                            }
                            className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                          >
                            {conditionTypeOptions.map(option => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {
                              conditionTypeOptions.find(option => option.value === condition.type)
                                ?.description
                            }
                          </p>
                        </div>

                        {condition.type === 'registry_key' && (
                          <>
                            <div>
                              <label className="text-xs font-medium text-muted-foreground">Hive</label>
                              <select
                                value={condition.hive}
                                onChange={event =>
                                  updateCondition(group.id, condition.id, {
                                    hive: event.target.value as RegistryCondition['hive']
                                  })
                                }
                                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                              >
                                <option value="HKLM">HKLM</option>
                                <option value="HKCU">HKCU</option>
                                <option value="HKCR">HKCR</option>
                                <option value="HKU">HKU</option>
                                <option value="HKCC">HKCC</option>
                              </select>
                            </div>
                            <div className="space-y-2">
                              <div>
                                <label className="text-xs font-medium text-muted-foreground">
                                  Key path
                                </label>
                                <input
                                  type="text"
                                  value={condition.keyPath}
                                  onChange={event =>
                                    updateCondition(group.id, condition.id, {
                                      keyPath: event.target.value
                                    })
                                  }
                                  className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                                  placeholder="Software\\Company\\App"
                                />
                              </div>
                              <div>
                                <label className="text-xs font-medium text-muted-foreground">
                                  Value name
                                </label>
                                <input
                                  type="text"
                                  value={condition.valueName}
                                  onChange={event =>
                                    updateCondition(group.id, condition.id, {
                                      valueName: event.target.value
                                    })
                                  }
                                  className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                                  placeholder="Enabled"
                                />
                              </div>
                              <div className="grid gap-2 md:grid-cols-2">
                                <div>
                                  <label className="text-xs font-medium text-muted-foreground">
                                    Operator
                                  </label>
                                  <select
                                    value={condition.operator}
                                    onChange={event =>
                                      updateCondition(group.id, condition.id, {
                                        operator: event.target.value as RegistryCondition['operator']
                                      })
                                    }
                                    className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                                  >
                                    <option value="equals">Equals</option>
                                    <option value="not_equals">Not equals</option>
                                    <option value="contains">Contains</option>
                                  </select>
                                </div>
                                <div>
                                  <label className="text-xs font-medium text-muted-foreground">
                                    Expected value
                                  </label>
                                  <input
                                    type="text"
                                    value={condition.expectedValue}
                                    onChange={event =>
                                      updateCondition(group.id, condition.id, {
                                        expectedValue: event.target.value
                                      })
                                    }
                                    className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                                    placeholder="1"
                                  />
                                </div>
                              </div>
                            </div>
                          </>
                        )}

                        {condition.type === 'file_exists' && (
                          <>
                            <div>
                              <label className="text-xs font-medium text-muted-foreground">Path</label>
                              <input
                                type="text"
                                value={condition.path}
                                onChange={event =>
                                  updateCondition(group.id, condition.id, { path: event.target.value })
                                }
                                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                                placeholder="C:\\Program Files\\App\\app.exe"
                              />
                            </div>
                            <div>
                              <label className="text-xs font-medium text-muted-foreground">
                                Condition
                              </label>
                              <select
                                value={condition.shouldExist ? 'exists' : 'missing'}
                                onChange={event =>
                                  updateCondition(group.id, condition.id, {
                                    shouldExist: event.target.value === 'exists'
                                  })
                                }
                                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                              >
                                <option value="exists">File exists</option>
                                <option value="missing">File missing</option>
                              </select>
                            </div>
                          </>
                        )}

                        {condition.type === 'service_status' && (
                          <>
                            <div>
                              <label className="text-xs font-medium text-muted-foreground">
                                Service name
                              </label>
                              <input
                                type="text"
                                value={condition.serviceName}
                                onChange={event =>
                                  updateCondition(group.id, condition.id, {
                                    serviceName: event.target.value
                                  })
                                }
                                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                                placeholder="WinDefend"
                              />
                            </div>
                            <div>
                              <label className="text-xs font-medium text-muted-foreground">Status</label>
                              <select
                                value={condition.status}
                                onChange={event =>
                                  updateCondition(group.id, condition.id, {
                                    status: event.target.value as ServiceStatusCondition['status']
                                  })
                                }
                                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                              >
                                <option value="running">Running</option>
                                <option value="stopped">Stopped</option>
                                <option value="paused">Paused</option>
                              </select>
                            </div>
                          </>
                        )}

                        {condition.type === 'process_running' && (
                          <>
                            <div>
                              <label className="text-xs font-medium text-muted-foreground">
                                Process name
                              </label>
                              <input
                                type="text"
                                value={condition.processName}
                                onChange={event =>
                                  updateCondition(group.id, condition.id, {
                                    processName: event.target.value
                                  })
                                }
                                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                                placeholder="example.exe"
                              />
                            </div>
                            <div>
                              <label className="text-xs font-medium text-muted-foreground">State</label>
                              <select
                                value={condition.isRunning ? 'running' : 'stopped'}
                                onChange={event =>
                                  updateCondition(group.id, condition.id, {
                                    isRunning: event.target.value === 'running'
                                  })
                                }
                                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                              >
                                <option value="running">Running</option>
                                <option value="stopped">Not running</option>
                              </select>
                            </div>
                          </>
                        )}

                        {condition.type === 'wmi_query' && (
                          <>
                            <div className="md:col-span-2">
                              <label className="text-xs font-medium text-muted-foreground">WMI query</label>
                              <input
                                type="text"
                                value={condition.query}
                                onChange={event =>
                                  updateCondition(group.id, condition.id, { query: event.target.value })
                                }
                                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                                placeholder="SELECT * FROM Win32_OperatingSystem"
                              />
                            </div>
                            <div>
                              <label className="text-xs font-medium text-muted-foreground">Comparator</label>
                              <select
                                value={condition.comparator}
                                onChange={event =>
                                  updateCondition(group.id, condition.id, {
                                    comparator: event.target.value as WmiQueryCondition['comparator']
                                  })
                                }
                                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                              >
                                <option value="equals">Equals</option>
                                <option value="contains">Contains</option>
                                <option value="greater_than">Greater than</option>
                                <option value="less_than">Less than</option>
                              </select>
                            </div>
                            <div>
                              <label className="text-xs font-medium text-muted-foreground">Expected value</label>
                              <input
                                type="text"
                                value={condition.expectedValue}
                                onChange={event =>
                                  updateCondition(group.id, condition.id, {
                                    expectedValue: event.target.value
                                  })
                                }
                                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                                placeholder="Windows 11"
                              />
                            </div>
                          </>
                        )}

                        <button
                          type="button"
                          onClick={() => removeCondition(group.id, condition.id)}
                          className="h-9 rounded-md border border-destructive/40 px-2 text-xs font-medium text-destructive hover:bg-destructive/10"
                        >
                          Remove
                        </button>
                      </div>
                    );
                  })}
                </div>

                <div
                  className={cn(
                    'mt-4 rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground',
                    dragOver?.groupId === group.id && !dragOver.conditionId && 'border-primary'
                  )}
                  onDragOver={event => {
                    event.preventDefault();
                    setDragOver({ groupId: group.id, conditionId: '' });
                  }}
                  onDrop={handleDropToGroupEnd(group.id)}
                >
                  Drop conditions here to move into this group
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={addGroup}
            className="inline-flex h-10 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted"
          >
            <Plus className="h-4 w-4" />
            Add group
          </button>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
          <div className="rounded-lg border bg-muted/30 p-4">
            <h3 className="text-sm font-semibold">Remediation actions</h3>
            <p className="text-xs text-muted-foreground">
              Configure actions to run when devices fail compliance.
            </p>
            <div className="mt-4 space-y-4">
              {policyState.remediation.actions.length === 0 && (
                <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                  Add remediation actions to respond automatically.
                </div>
              )}
              {policyState.remediation.actions.map(action => (
                <div key={action.id} className="rounded-md border bg-background p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">
                        Action type
                      </label>
                      <select
                        value={action.type}
                        onChange={event =>
                          replaceRemediationAction(
                            action.id,
                            event.target.value as RemediationActionType
                          )
                        }
                        className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                      >
                        {remediationActionOptions.map(option => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <p className="text-[11px] text-muted-foreground">
                        {
                          remediationActionOptions.find(option => option.value === action.type)
                            ?.description
                        }
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeRemediationAction(action.id)}
                      className="text-xs font-medium text-destructive hover:underline"
                    >
                      Remove
                    </button>
                  </div>

                  {action.type === 'run_script' && (
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Script</label>
                      <select
                        value={action.scriptId ?? ''}
                        onChange={event =>
                          updateRemediationAction(action.id, { scriptId: event.target.value })
                        }
                        className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                      >
                        <option value="">Select a script</option>
                        {scripts.map(script => (
                          <option key={script.id} value={script.id}>
                            {script.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {action.type === 'restart_service' && (
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Service name</label>
                      <input
                        type="text"
                        value={action.serviceName ?? ''}
                        onChange={event =>
                          updateRemediationAction(action.id, { serviceName: event.target.value })
                        }
                        className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                        placeholder="WinDefend"
                      />
                    </div>
                  )}

                  {action.type === 'run_command' && (
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Command</label>
                      <input
                        type="text"
                        value={action.command ?? ''}
                        onChange={event =>
                          updateRemediationAction(action.id, { command: event.target.value })
                        }
                        className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                        placeholder="powershell.exe -Command ..."
                      />
                    </div>
                  )}

                  {action.type === 'notify' && (
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Notify channel</label>
                      <input
                        type="text"
                        value={action.notifyChannel ?? ''}
                        onChange={event =>
                          updateRemediationAction(action.id, { notifyChannel: event.target.value })
                        }
                        className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                        placeholder="security-oncall"
                      />
                    </div>
                  )}
                </div>
              ))}

              <div className="flex flex-wrap gap-2">
                {remediationActionOptions.map(option => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => addRemediationAction(option.value)}
                    className="inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-muted"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {option.label}
                  </button>
                ))}
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground">On failure</label>
                <select
                  value={policyState.remediation.onFailure}
                  onChange={event =>
                    setPolicyState(prev => ({
                      ...prev,
                      remediation: {
                        ...prev.remediation,
                        onFailure: event.target.value as RemediationConfig['onFailure']
                      }
                    }))
                  }
                  className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                >
                  <option value="stop">Stop after first failure</option>
                  <option value="continue">Continue with next action</option>
                </select>
              </div>
            </div>
          </div>

          <div className="rounded-lg border bg-muted/30 p-4">
            <h3 className="text-sm font-semibold">Schedule</h3>
            <p className="text-xs text-muted-foreground">
              Define when policy evaluations run.
            </p>
            <div className="mt-4 space-y-4">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Frequency</label>
                <select
                  value={policyState.schedule.frequency}
                  onChange={event =>
                    updateSchedule({ frequency: event.target.value as ScheduleConfig['frequency'] })
                  }
                  className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                >
                  {scheduleOptions.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Start time</label>
                  <input
                    type="time"
                    value={policyState.schedule.windowStart}
                    onChange={event => updateSchedule({ windowStart: event.target.value })}
                    className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">End time</label>
                  <input
                    type="time"
                    value={policyState.schedule.windowEnd}
                    onChange={event => updateSchedule({ windowEnd: event.target.value })}
                    className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Timezone</label>
                <select
                  value={policyState.schedule.timezone}
                  onChange={event => updateSchedule({ timezone: event.target.value })}
                  className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                >
                  {timezones.map(zone => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Days</label>
                <div className="mt-2 flex flex-wrap gap-2">
                  {weekDays.map(day => {
                    const isSelected = policyState.schedule.days.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        onClick={() => toggleDay(day)}
                        className={cn(
                          'flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium',
                          isSelected
                            ? 'border-primary/40 bg-primary/10 text-primary'
                            : 'border-muted bg-background text-muted-foreground'
                        )}
                      >
                        {isSelected && <Check className="h-3 w-3" />}
                        {day}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-lg border bg-muted/30 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Target scope</h3>
              <p className="text-xs text-muted-foreground">
                Select organizations, sites, and device groups.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex rounded-md border">
                <button
                  type="button"
                  onClick={() => setTargetMode('hierarchy')}
                  className={cn(
                    'px-3 py-1.5 text-xs font-medium rounded-l-md transition',
                    targetMode === 'hierarchy' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                  )}
                >
                  Hierarchy
                </button>
                <button
                  type="button"
                  onClick={() => setTargetMode('filter')}
                  className={cn(
                    'px-3 py-1.5 text-xs font-medium rounded-r-md transition',
                    targetMode === 'filter' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                  )}
                >
                  <Filter className="h-3 w-3 inline mr-1" />
                  Advanced Filter
                </button>
              </div>
              {targetsLoading ? (
                <div className="text-xs text-muted-foreground">Loading targets...</div>
              ) : null}
            </div>
          </div>

          {targetsError && (
            <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {targetsError}
            </div>
          )}

          {targetMode === 'hierarchy' ? (
            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">Organizations</div>
                <div className="space-y-2">
                  {organizations.length === 0 && (
                    <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                      No organizations available.
                    </div>
                  )}
                  {organizations.map(org => (
                    <label
                      key={org.id}
                      className={cn(
                        'flex items-center justify-between rounded-md border px-3 py-2 text-xs',
                        policyState.targetScope.organizations.includes(org.id)
                          ? 'border-primary/40 bg-primary/5'
                          : 'border-muted bg-background'
                      )}
                    >
                      <span className="font-medium text-foreground">{org.name}</span>
                      <input
                        type="checkbox"
                        checked={policyState.targetScope.organizations.includes(org.id)}
                        onChange={() => updateTargetScope('organizations', org.id)}
                        className="h-4 w-4"
                      />
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">Sites</div>
                <div className="space-y-2">
                  {sites.length === 0 && (
                    <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                      No sites available.
                    </div>
                  )}
                  {sites.map(site => (
                    <label
                      key={site.id}
                      className={cn(
                        'flex items-center justify-between rounded-md border px-3 py-2 text-xs',
                        policyState.targetScope.sites.includes(site.id)
                          ? 'border-primary/40 bg-primary/5'
                          : 'border-muted bg-background'
                      )}
                    >
                      <span className="font-medium text-foreground">{site.name}</span>
                      <input
                        type="checkbox"
                        checked={policyState.targetScope.sites.includes(site.id)}
                        onChange={() => updateTargetScope('sites', site.id)}
                        className="h-4 w-4"
                      />
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">Device groups</div>
                <div className="space-y-2">
                  {groups.length === 0 && (
                    <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                      No groups available.
                    </div>
                  )}
                  {groups.map(group => (
                    <label
                      key={group.id}
                      className={cn(
                        'flex items-center justify-between rounded-md border px-3 py-2 text-xs',
                        policyState.targetScope.groups.includes(group.id)
                          ? 'border-primary/40 bg-primary/5'
                          : 'border-muted bg-background'
                      )}
                    >
                      <span className="font-medium text-foreground">{group.name}</span>
                      <input
                        type="checkbox"
                        checked={policyState.targetScope.groups.includes(group.id)}
                        onChange={() => updateTargetScope('groups', group.id)}
                        className="h-4 w-4"
                      />
                    </label>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-4 space-y-4">
              <FilterBuilder
                value={filterConditions}
                onChange={setFilterConditions}
                filterFields={DEFAULT_FILTER_FIELDS}
              />
              {filterConditions.conditions.length > 0 && (
                <FilterPreview
                  preview={filterPreview}
                  loading={filterPreviewLoading}
                  error={null}
                  onRefresh={() => setFilterConditions({ ...filterConditions })}
                />
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <div className="text-xs text-muted-foreground">
            Evaluation interval: {resolveFrequencyMinutes} minutes
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting || policyState.status === 'archived'}
              className="inline-flex h-10 items-center gap-2 rounded-md border border-destructive/40 px-4 text-sm font-medium text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="h-4 w-4" />
              {deleting ? 'Archiving...' : policyState.status === 'archived' ? 'Archived' : 'Archive policy'}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || policyState.status === 'archived'}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
            >
              <Save className={cn('h-4 w-4', saving && 'animate-spin')} />
              {saving ? 'Saving...' : policyState.status === 'archived' ? 'Archived' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-dashed bg-muted/30 p-4 text-xs text-muted-foreground">
        <AlertTriangle className="mr-2 inline h-4 w-4" />
        Changes are saved to the policy definition and can be activated when ready.
      </div>
    </div>
  );
}
