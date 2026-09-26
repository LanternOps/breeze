import DeliveryPreview from '../alerts/delivery/DeliveryPreview';
import { useDeliveryResource } from '../alerts/delivery/useDeliveryResource';
import type { EscalationPolicy } from '../alerts/delivery/deliveryActions';
import { useJwtClaims } from '../../lib/authScope';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHashState } from '@/lib/useHashState';
import { useForm, FormProvider, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { Trash2, ArrowLeft } from 'lucide-react';
import {
  monitorKindSchema,
  monitorSeveritySchema,
  monitorDeliveryModeSchema,
  monitorConditionSchemas,
  monitorResponsesSchema,
  MONITOR_KINDS,
  type MonitorKind,
  type MonitorDeliveryMode,
} from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { navigateTo } from '@/lib/navigation';
import { extractApiError } from '@/lib/apiError';
import { asList } from '@/lib/asList';
import { runAction, handleActionError, ActionError } from '@/lib/runAction';
import { useDefaultOwnerScope } from '@/hooks/useDefaultOwnerScope';
import { useHydrated } from '@/hooks/useHydrated';
import { BuiltInBadge } from './BuiltInBadge';
import { ScopeBadge } from '../shared/ScopeBadge';
import ActionsEditor, {
  type Script,
  type NotificationChannel,
  type SoftwareCatalogItem,
} from '../automations/ActionsEditor';
import MonitorConditionFields from './MonitorConditionFields';
import NetworkCheckAssetBinding, { bindNetworkAsset, type NetworkAsset } from './NetworkCheckAssetBinding';
import { RestartResponseFields } from './MonitorAuthoringFields';
import DeployMonitorDialog from './DeployMonitorDialog';
import MonitorDevicesTable from './MonitorDevicesTable';
import MonitorActivityTab from './MonitorActivityTab';
import { defaultConditionFor } from './monitorKindFields';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import Breadcrumbs from '../layout/Breadcrumbs';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import { i18n } from '../../lib/i18n';
import { useStableT } from '@/lib/i18n/useStableT';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

type KindMeta = {
  kind: MonitorKind;
  overridableKeys: string[];
  defaultSeverity: string;
  agentDelivered: boolean;
};

type AiAgent = { id: string; name: string };
type Attachment = {
  id: string;
  configPolicyId: string;
  policyName: string;
  enabled: boolean;
  overrides: Record<string, unknown> | null;
};

export interface MonitorFormValues {
  name: string;
  description?: string;
  kind: MonitorKind;
  enabled: boolean;
  condition: Record<string, unknown>;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  cooldownMinutes: number;
  autoResolve: boolean;
  responses: Array<Record<string, unknown>>;
  deliveryMode: MonitorDeliveryMode;
  deliveryChannelIds: string[];
  escalationPolicyId?: string | null;
  recurrenceThreshold?: number | null;
  // Form-only: the API stores hours. Kept as days here because a technician
  // thinks in days, not hours, when setting an escalation window.
  recurrenceWindowDays?: number | null;
  recurrenceActions: Array<Record<string, unknown>>;
  pauseResponsesOnEscalation: boolean;
  aiAgentId?: string | null;
  ownerScope?: 'organization' | 'partner';
}

// A LOCAL form schema, deliberately not the shared `createMonitorDefinitionSchema`
// / `updateMonitorDefinitionSchema` (#5289) — same reasoning as AutomationForm's
// own local `actionSchema`/`createAutomationSchema`: the form's field shape
// (e.g. `recurrenceWindowDays`, converted to the wire's `recurrenceWindowHours`
// only in `onSubmit`) doesn't match the wire payload one-for-one, so validating
// raw form values against the wire schema's cross-field `.refine()`s (which
// check `recurrenceWindowHours`, a field this form never registers) would
// reject every submission that sets a recurrence threshold. The server still
// runs the full shared schema on the built payload and is the source of truth
// for the business rules (delivery channels required, ai_triage needs an
// agent, recurrence threshold/window set together); this schema only catches
// shape errors early.
// Marks the specific "restart service needs a name" zod issue so the error
// rendering (below) can show it instead of the generic invalidResponses copy.
const RESTART_SERVICE_NAME_ISSUE = 'restartServiceRequiresName';

const monitorFormSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    kind: monitorKindSchema,
    enabled: z.boolean(),
    condition: z.record(z.string(), z.unknown()),
    severity: monitorSeveritySchema,
    cooldownMinutes: z.number().int().min(0).max(1440),
    autoResolve: z.boolean(),
    responses: z.array(z.record(z.string(), z.unknown())),
    deliveryMode: monitorDeliveryModeSchema,
    deliveryChannelIds: z.array(z.string()),
    escalationPolicyId: z.string().nullable().optional(),
    recurrenceThreshold: z.number().int().min(2).max(100).nullable().optional(),
    recurrenceWindowDays: z.number().int().min(1).max(365).nullable().optional(),
    recurrenceActions: z.array(z.record(z.string(), z.unknown())),
    pauseResponsesOnEscalation: z.boolean(),
    aiAgentId: z.string().nullable().optional(),
    ownerScope: z.enum(['organization', 'partner']).optional(),
  })
  // Shape-only above; these two rules pull in the REAL shared per-kind
  // condition schema and the shared responses schema (composite children,
  // restart-service bounds) so a bad composite child or an out-of-range
  // restart limit surfaces on the field, not only after the server 400s.
  .superRefine((value, ctx) => {
    const condition = monitorConditionSchemas[value.kind].safeParse(value.condition);
    if (!condition.success) ctx.addIssue({ code: 'custom', path: ['condition'], message: 'Invalid condition' });
    const responses = monitorResponsesSchema.safeParse(value.responses);
    if (!responses.success) ctx.addIssue({ code: 'custom', path: ['responses'], message: 'Invalid responses' });
    // D1: a `restart_service` response carries no service name of its own — it
    // compiles to `auto_restart: true` on the delivered watch, which only ever
    // targets the service named on the monitor's own `service`-kind condition
    // (see automationActions.ts). Without this check the editor happily saves a
    // restart response on a monitor with no service name at all (any non-service
    // kind, or a service monitor whose name is still blank mid-edit), and at
    // runtime automationRuntime.executeCommandAction reports it "succeeded" while
    // doing nothing (~L1615). Block Save instead of shipping an inert action.
    const hasRestartServiceResponse = value.responses.some(
      (response) => (response as { kind?: unknown }).kind === 'restart_service',
    );
    const conditionServiceName = (value.condition as { serviceName?: unknown })?.serviceName;
    const hasServiceName =
      typeof conditionServiceName === 'string' && conditionServiceName.trim().length > 0;
    if (hasRestartServiceResponse && !hasServiceName) {
      // Sentinel picked up by the error rendering below (sweep F2) so the
      // specific reason reaches the user instead of the generic fallback.
      ctx.addIssue({ code: 'custom', path: ['responses'], message: RESTART_SERVICE_NAME_ISSUE });
    }
  });

const DEFAULT_VALUES: MonitorFormValues = {
  name: '',
  description: '',
  kind: 'cpu',
  enabled: true,
  condition: defaultConditionFor('cpu'),
  severity: 'high',
  cooldownMinutes: 5,
  autoResolve: false,
  responses: [],
  deliveryMode: 'inherit',
  deliveryChannelIds: [],
  escalationPolicyId: null,
  recurrenceThreshold: null,
  recurrenceWindowDays: null,
  recurrenceActions: [],
  pauseResponsesOnEscalation: true,
  aiAgentId: null,
};

export interface MonitorEditorProps {
  monitorId?: string;
}

type EditorTab = 'settings' | 'activity';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function editorHashParams(hash: string): URLSearchParams {
  const raw = hash.replace(/^#/, '');
  const first = raw.split('/')[0];
  if (!raw.includes('=') && (first === 'settings' || first === 'activity')) {
    return new URLSearchParams({ tab: first });
  }
  return new URLSearchParams(raw);
}
export function tabFromHash(hash: string): EditorTab | undefined {
  const params = editorHashParams(hash);
  const tab = params.get('tab');
  if (tab === 'settings' || tab === 'activity') return tab;
  return params.has('policy') ? 'settings' : undefined;
}
export function editorHashForTab(hash: string, tab: EditorTab): string {
  const params = editorHashParams(hash);
  if (!['policy', 'kind', 'assetId', 'checkType', 'target'].some(key => params.has(key))) return `#${tab}`;
  params.set('tab', tab);
  return `#${params.toString()}`;
}
export async function attachAfterCreate(
  monitorId: string,
  hash: string,
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetchWithAuth,
): Promise<string> {
  const policyId = editorHashParams(hash).get('policy');
  if (!policyId || !UUID_RE.test(policyId)) return `/alerts/monitors/${monitorId}`;
  const attachFailure = `${i18n.t('monitoring:editor.saved')}. ${i18n.t('monitoring:deploy.errors.attach')}`;
  await runAction({
    request: () => fetcher(`/monitor-definitions/${monitorId}/attachments`, {
      method: 'POST', body: JSON.stringify({ configPolicyId: policyId }),
    }),
    errorFallback: attachFailure,
    friendly: () => attachFailure,
    successMessage: i18n.t('monitoring:editor.attachedToPolicy'),
    onUnauthorized: UNAUTHORIZED,
  });
  return `/configuration-policies/${policyId}#monitors`;
}

export default function MonitorEditor({ monitorId }: MonitorEditorProps) {
  const { t } = useTranslation(['monitoring', 'common']);
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const isNew = !monitorId;
  const jwt = useJwtClaims();
  const currentPartnerId = jwt.status === 'resolved' ? jwt.claims.partnerId : null;
  const createdEditorUrl = useRef<string | undefined>(undefined);
  const { isPartnerScope, defaultOwnerScope } = useDefaultOwnerScope();
  // `isPartnerScope` decodes the access token, which the server never has, so
  // the owner-scope block would otherwise appear only on the client and make
  // the hydration pass structurally disagree with the SSR markup (#6391).
  // Markup only — the submit path keeps reading `isPartnerScope` directly.
  const hydrated = useHydrated();
  const currentOrgId = useOrgStore((s) => s.currentOrgId);

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testDevices, setTestDevices] = useState<{ id: string; name: string }[]>([]);
  const [testDeviceId, setTestDeviceId] = useState('');
  const [testSubmitting, setTestSubmitting] = useState(false);
  const [testResult, setTestResult] = useState<
    { status: 'result'; triggered: boolean; deviceName: string } | { status: 'error'; message: string } | null
  >(null);

  const [kindsMeta, setKindsMeta] = useState<KindMeta[]>([]);
  const [scripts, setScripts] = useState<Script[]>([]);
  const [softwareCatalog, setSoftwareCatalog] = useState<SoftwareCatalogItem[]>([]);
  const [aiAgents, setAiAgents] = useState<AiAgent[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [builtinKey, setBuiltinKey] = useState<string | null>(null);
  // Null for a partner-wide monitor — DeployMonitorDialog falls back to the
  // currently selected org from the org store in that case.
  const [monitorOrgId, setMonitorOrgId] = useState<string | null>(null);
  const [prefillOrgId, setPrefillOrgId] = useState<string | null>(null);
  const [assetPrefillError, setAssetPrefillError] = useState(false);
  const [assetPrefillAttempt, setAssetPrefillAttempt] = useState(0);
  const [monitorPartnerId, setMonitorPartnerId] = useState<string | null>(null);

  const [hashTab, setHashTab] = useHashState<EditorTab>('settings', tabFromHash);
  // The Activity tab needs a saved monitor id (#5290); an unsaved monitor
  // simply never shows it, so a stale `#activity` hash (e.g. a bookmark from
  // an old monitor that was deleted and re-created as `isNew`) falls back to
  // Settings rather than rendering a blank tab — same posture as
  // DeviceDetails' `#linked-profiles` fallback.
  const activeTab: EditorTab = isNew ? 'settings' : hashTab;

  const methods = useForm<MonitorFormValues>({
    resolver: zodResolver(monitorFormSchema),
    defaultValues: { ...DEFAULT_VALUES, ownerScope: defaultOwnerScope },
  });
  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    getValues,
    reset,
    formState: { errors, isSubmitting },
  } = methods;

  const watchKind = watch('kind');
  const watchSeverity = watch('severity');
  const watchDeliveryChannelIds = watch('deliveryChannelIds');
  const watchAiAgentId = watch('aiAgentId');
  const watchDeliveryMode = watch('deliveryMode');
  const watchOwnerScope = watch('ownerScope');
  const watchEscalationPolicyId = watch('escalationPolicyId');
  const isLoading = saving || isSubmitting;
  const isPartnerOwned = isNew ? watchOwnerScope === 'partner' : monitorPartnerId !== null;
  const ownerOrgId = isNew ? prefillOrgId ?? currentOrgId : monitorOrgId;
  const deliveryChoiceOrgId = ownerOrgId ?? currentOrgId;
  const deliveryChoiceSuffix = deliveryChoiceOrgId ? `&orgId=${encodeURIComponent(deliveryChoiceOrgId)}` : '';
  const channelRail = useDeliveryResource<NotificationChannel>(`/alerts/delivery/rails?rail=channels${deliveryChoiceSuffix}`);
  const escalationRail = useDeliveryResource<EscalationPolicy>(`/alerts/delivery/rails?rail=escalation${deliveryChoiceSuffix}`);
  const notificationChannels = useMemo(() => [...new Map([
    ...channelRail.data.map(({ id, name, type }) => ({ id, name, type })),
    ...channelRail.inherited,
  ].map(channel => [channel.id, channel] as const)).values()], [channelRail.data, channelRail.inherited]);
  const escalationPolicies = escalationRail.data;

  const compatibleEscalationPolicies = useMemo(() => escalationPolicies.filter(policy => {
    if (policy.inherited === true) {
      return !isPartnerOwned || isNew || monitorPartnerId === currentPartnerId;
    }
    if (policy.orgId === null && policy.partnerId !== null) {
      return !isPartnerOwned || isNew || policy.partnerId === monitorPartnerId;
    }
    return !isPartnerOwned && policy.orgId === ownerOrgId;
  }), [escalationPolicies, isPartnerOwned, isNew, monitorPartnerId, currentPartnerId, ownerOrgId]);

  useEffect(() => {
    // Changing create ownership must not submit a now-hidden org policy.
    if (isNew && watchEscalationPolicyId
      && escalationPolicies.some((policy) => policy.id === watchEscalationPolicyId)
      && !compatibleEscalationPolicies.some((policy) => policy.id === watchEscalationPolicyId)) {
      setValue('escalationPolicyId', null, { shouldDirty: true });
    }
  }, [isNew, watchEscalationPolicyId, escalationPolicies, compatibleEscalationPolicies, setValue]);

  const fetchKinds = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/monitor-definitions/kinds');
      if (response.ok) {
        const data = await response.json();
        setKindsMeta(Array.isArray(data?.data) ? data.data : []);
      }
    } catch {
      // Silently fail — kind metadata only powers hints, not validation.
    }
  }, []);

  const fetchScripts = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/scripts');
      if (response.ok) {
        const data = await response.json();
        setScripts(data.data ?? data.scripts ?? []);
      }
    } catch {
      // Silently fail
    }
  }, []);

  const fetchSoftwareCatalog = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/software/catalog');
      if (response.ok) {
        const data = await response.json();
        setSoftwareCatalog(data.data ?? data.catalog ?? []);
      }
    } catch {
      // Silently fail
    }
  }, []);

  const fetchAiAgents = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/ai/agents');
      if (response.ok) {
        const data = await response.json();
        setAiAgents(Array.isArray(data?.data) ? data.data : []);
      }
    } catch {
      // Silently fail
    }
  }, []);

  const fetchMonitor = useCallback(async () => {
    if (isNew || !monitorId) return;
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth(`/monitor-definitions/${monitorId}`);
      if (!response.ok) throw new Error(stableT('monitoring:editor.errors.load'));
      const data = await response.json();
      const monitor = data?.data ?? data;
      setAttachments(Array.isArray(monitor.attachments) ? monitor.attachments : []);
      setBuiltinKey(typeof monitor.builtinKey === 'string' ? monitor.builtinKey : null);
      setMonitorOrgId(typeof monitor.orgId === 'string' ? monitor.orgId : null);
      setMonitorPartnerId(typeof monitor.partnerId === 'string' ? monitor.partnerId : null);
      reset({
        name: monitor.name ?? '',
        description: monitor.description ?? '',
        kind: monitor.kind,
        enabled: monitor.enabled ?? true,
        condition: monitor.condition ?? defaultConditionFor(monitor.kind),
        severity: monitor.severity ?? 'high',
        cooldownMinutes: monitor.cooldownMinutes ?? 5,
        autoResolve: monitor.autoResolve ?? false,
        responses: monitor.responses ?? [],
        deliveryMode: monitor.deliveryMode ?? 'inherit',
        deliveryChannelIds: monitor.deliveryChannelIds ?? [],
        escalationPolicyId: monitor.escalationPolicyId ?? null,
        recurrenceThreshold: monitor.recurrenceThreshold ?? null,
        recurrenceWindowDays:
          typeof monitor.recurrenceWindowHours === 'number' ? Math.round(monitor.recurrenceWindowHours / 24) : null,
        recurrenceActions: monitor.recurrenceActions ?? [],
        pauseResponsesOnEscalation: monitor.pauseResponsesOnEscalation ?? true,
        aiAgentId: monitor.aiAgentId ?? null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : stableT('monitoring:editor.errors.load'));
    } finally {
      setLoading(false);
    }
  }, [isNew, monitorId, reset, stableT]);

  useEffect(() => {
    void fetchKinds();
    void fetchScripts();
    void fetchSoftwareCatalog();
    void fetchAiAgents();
    void fetchMonitor();
  }, [fetchKinds, fetchScripts, fetchSoftwareCatalog, fetchAiAgents, fetchMonitor]);

  const handleKindChange = (kind: MonitorKind) => {
    setValue('kind', kind, { shouldDirty: true });
    setValue('condition', defaultConditionFor(kind), { shouldDirty: true });
  };

  useEffect(() => {
    if (!isNew) return;
    const params = editorHashParams(window.location.hash);
    const kind = params.get('kind');
    if (!kind || !(MONITOR_KINDS as readonly string[]).includes(kind)) return;
    setValue('kind', kind as MonitorKind);
    const condition = defaultConditionFor(kind as MonitorKind);
    const checkType = params.get('checkType');
    if (kind === 'network_check') {
      if (['icmp_ping', 'tcp_port', 'http_check', 'dns_check'].includes(checkType ?? '')) condition.checkType = checkType;
      if (params.get('target')) condition.target = params.get('target');
    }
    setValue('condition', condition);
  }, [isNew, setValue]);

  useEffect(() => {
    if (!isNew) return;
    const params = editorHashParams(window.location.hash);
    const assetId = params.get('assetId');
    if (params.get('kind') !== 'network_check' || !assetId
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assetId)) return;
    let cancelled = false;
    setAssetPrefillError(false);
    setValue('ownerScope', 'organization');
    const initialCondition = getValues('condition');
    const initialBinding = [initialCondition.checkType, initialCondition.target, initialCondition.assetId];
    void (async () => {
      try {
        const res = await fetchWithAuth(`/discovery/assets/${encodeURIComponent(assetId)}`, { skipOrgIdInjection: true });
        if (!res.ok) throw new Error('asset_read_failed');
        const body = await res.json();
        const asset = body.data as NetworkAsset & { orgId: string };
        if (!asset || asset.id !== assetId || !asset.orgId) throw new Error('asset_response_invalid');
        if (cancelled || getValues('kind') !== 'network_check' || getValues('ownerScope') !== 'organization'
          || ['checkType', 'target', 'assetId'].some((key, index) => getValues('condition')[key] !== initialBinding[index])) return;
        setPrefillOrgId(asset.orgId);
        // A new asset handoff without a target should use the asset, not the
        // condition's sample target. The guard above preserves any user edits.
        const bound = bindNetworkAsset({ ...getValues('condition'), target: params.get('target') ?? '' }, asset);
        setValue('condition', bound, { shouldDirty: true });
        if (!getValues('name')) {
          const label = asset.label ?? asset.hostname ?? asset.ipAddress ?? asset.id;
          setValue('name', bound.checkType === 'icmp_ping'
            ? stableT('monitoring:editor.networkCheckAsset.pingName', { label })
            : `${stableT('monitoring:kinds.network_check')} ${label}`, { shouldDirty: true });
        }
      } catch {
        if (!cancelled) setAssetPrefillError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [isNew, assetPrefillAttempt, getValues, setValue, stableT]);

  useEffect(() => {
    if (!isPartnerOwned || watchKind !== 'network_check') return;
    const condition = getValues('condition');
    if (condition.assetId) setValue('condition', bindNetworkAsset(condition, null), { shouldDirty: true });
  }, [isPartnerOwned, watchKind, getValues, setValue]);

  const switchTab = (tab: EditorTab) => {
    window.location.hash = editorHashForTab(window.location.hash, tab);
    setHashTab(tab);
  };

  const onSubmit = async (values: MonitorFormValues) => {
    // Navigation can lag behind a successful create; never POST a second monitor.
    if (createdEditorUrl.current) {
      void navigateTo(createdEditorUrl.current);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const payload: Record<string, unknown> = {
        name: values.name,
        description: values.description || undefined,
        kind: values.kind,
        enabled: values.enabled,
        condition: values.condition,
        severity: values.severity,
        cooldownMinutes: values.cooldownMinutes,
        autoResolve: values.autoResolve,
        responses: values.responses,
        deliveryMode: values.deliveryMode,
        deliveryChannelIds: values.deliveryMode === 'channels' ? values.deliveryChannelIds : [],
        escalationPolicyId: values.escalationPolicyId || null,
        recurrenceThreshold: values.recurrenceThreshold || null,
        recurrenceWindowHours:
          values.recurrenceThreshold && values.recurrenceWindowDays ? values.recurrenceWindowDays * 24 : null,
        recurrenceActions: values.recurrenceActions,
        pauseResponsesOnEscalation: values.pauseResponsesOnEscalation,
        aiAgentId: values.aiAgentId || null,
      };
      if (isNew && isPartnerScope && values.ownerScope) {
        payload.ownerScope = values.ownerScope;
      }

      if (isNew && !isPartnerOwned && prefillOrgId) payload.orgId = prefillOrgId;

      const url = isNew ? '/monitor-definitions' : `/monitor-definitions/${monitorId}`;
      const method = isNew ? 'POST' : 'PATCH';
      const data = await runAction<{ data?: { id?: string } }>({
        request: () => fetchWithAuth(url, { method, body: JSON.stringify(payload) }),
        errorFallback: t('monitoring:editor.errors.save'),
        successMessage: t('monitoring:editor.saved'),
        friendly: (_code, message) => message.replace(/^INVALID_MONITOR:\s*/, ''),
        onUnauthorized: UNAUTHORIZED,
      });
      const savedId = data?.data?.id ?? monitorId;
      if (isNew && savedId) {
        const hash = window.location.hash;
        createdEditorUrl.current = `/alerts/monitors/${savedId}${hash}`;
        try {
          void navigateTo(await attachAfterCreate(savedId, hash));
        } catch (err) {
          if (err instanceof ActionError && err.status === 401) return;
          handleActionError(err, `${t('monitoring:editor.saved')}. ${t('monitoring:deploy.errors.attach')}`);
          void navigateTo(createdEditorUrl.current);
        }
      } else {
        void fetchMonitor();
      }
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      handleActionError(err, t('monitoring:editor.errors.save'));
      setError(err instanceof Error ? err.message : t('monitoring:editor.errors.save'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!monitorId) return;
    setDeleting(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/monitor-definitions/${monitorId}`, { method: 'DELETE' }),
        errorFallback: t('monitoring:editor.errors.delete'),
        successMessage: t('monitoring:editor.deleted'),
        onUnauthorized: UNAUTHORIZED,
      });
      void navigateTo('/alerts/monitors');
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      handleActionError(err, t('monitoring:editor.errors.delete'));
      setError(err instanceof Error ? err.message : t('monitoring:editor.errors.delete'));
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  const handleDetach = async (attachmentId: string) => {
    if (!monitorId) return;
    setError(undefined);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/monitor-definitions/${monitorId}/attachments/${attachmentId}`, {
            method: 'DELETE',
          }),
        errorFallback: t('monitoring:deploy.errors.detach'),
        successMessage: t('monitoring:editor.detached'),
        onUnauthorized: UNAUTHORIZED,
      });
      setAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      handleActionError(err, t('monitoring:deploy.errors.detach'));
      setError(err instanceof Error ? err.message : t('monitoring:deploy.errors.detach'));
    }
  };

  const handleOpenTest = () => {
    setTestOpen(true);
    setTestResult(null);
    if (testDevices.length > 0) return;
    void fetchWithAuth('/devices')
      .then((res) => (res.ok ? res.json() : { devices: [] }))
      .then((data) =>
        setTestDevices(
          asList(data, 'devices').map((d: { id: string; hostname?: string; displayName?: string }) => ({
            id: d.id,
            name: d.displayName || d.hostname || d.id,
          })),
        ),
      )
      .catch(() => setTestDevices([]));
  };

  const handleRunTest = async () => {
    if (!monitorId || !testDeviceId) return;
    setTestSubmitting(true);
    setTestResult(null);
    try {
      // runaction-exempt: the test result panel below IS the outcome surface —
      // both the failure and the triggered/not-triggered verdict render inline,
      // and a toast would report "done" for a test whose whole payload is the
      // answer.
      const response = await fetchWithAuth(`/monitor-definitions/${monitorId}/test`, {
        method: 'POST',
        body: JSON.stringify({ deviceId: testDeviceId }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(extractApiError(data, t('monitoring:editor.errors.test')));
      }
      const data = await response.json();
      const deviceName = testDevices.find((d) => d.id === testDeviceId)?.name ?? testDeviceId;
      setTestResult({ status: 'result', triggered: !!data?.data?.triggered, deviceName });
    } catch (err) {
      setTestResult({ status: 'error', message: err instanceof Error ? err.message : t('monitoring:editor.errors.test') });
    } finally {
      setTestSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <FormProvider {...methods}>
      <div className="space-y-6" data-testid="monitor-editor">
        <Breadcrumbs
          items={[
            { label: t('monitoring:editor.breadcrumb.monitors'), href: '/alerts/monitors' },
            { label: isNew ? t('monitoring:editor.breadcrumb.new') : watch('name') || t('monitoring:editor.titleEdit') },
          ]}
        />
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <a href="/alerts/monitors" className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted">
              <ArrowLeft className="h-5 w-5" />
            </a>
            <h1 className="text-xl font-semibold tracking-tight">
              {isNew ? t('monitoring:editor.titleNew') : t('monitoring:editor.titleEdit')}
            </h1>
            {!isNew && <ScopeBadge orgId={monitorOrgId} partnerId={monitorPartnerId} isSystem={false} />}
            {builtinKey && <BuiltInBadge label={t('monitoring:list.builtIn')} hint={t('monitoring:list.builtInHint')} />}
          </div>
          {!isNew && (
            <button
              type="button"
              data-testid="monitor-editor-test-open"
              onClick={handleOpenTest}
              className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              {t('monitoring:editor.actions.test')}
            </button>
          )}
        </div>

        {!isNew && (
          <div className="flex gap-2 border-b" role="tablist" data-testid="monitor-editor-tabs">
            {(['settings', 'activity'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                data-testid={`monitor-editor-tab-${tab}`}
                onClick={() => switchTab(tab)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                  activeTab === tab
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {t(/* i18n-dynamic */ `monitoring:editor.tabs.${tab}`)}
              </button>
            ))}
          </div>
        )}

        {activeTab === 'activity' && !isNew && monitorId ? (
          <MonitorActivityTab monitorId={monitorId} recurrenceThreshold={watch('recurrenceThreshold')} />
        ) : null}

        {activeTab === 'settings' && (
        <>
        {!isNew && testOpen && (
          <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="monitor-editor-test-panel">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex-1 space-y-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="monitor-editor-test-device">
                  {t('monitoring:editor.testDialog.selectDevice')}
                </label>
                <select
                  id="monitor-editor-test-device"
                  data-testid="monitor-editor-test-device"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  value={testDeviceId}
                  onChange={(e) => {
                    setTestResult(null);
                    setTestDeviceId(e.target.value);
                  }}
                >
                  <option value="">—</option>
                  {testDevices.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.name}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                data-testid="monitor-editor-test-run"
                disabled={!testDeviceId || testSubmitting}
                onClick={() => void handleRunTest()}
                className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t('monitoring:editor.testDialog.run')}
              </button>
              <button
                type="button"
                onClick={() => setTestOpen(false)}
                className="h-9 rounded-md border px-4 text-sm font-medium hover:bg-muted"
              >
                {t('common:actions.close')}
              </button>
            </div>
            {testResult && (
              <p
                data-testid="monitor-editor-test-result"
                className={`mt-3 text-sm ${testResult.status === 'error' ? 'text-destructive' : testResult.triggered ? 'text-emerald-700' : 'text-muted-foreground'}`}
              >
                {testResult.status === 'error'
                  ? testResult.message
                  : t(
                      /* i18n-dynamic */ testResult.triggered
                        ? 'monitoring:editor.testResult.triggered'
                        : 'monitoring:editor.testResult.notTriggered',
                      { device: testResult.deviceName },
                    )}
              </p>
            )}
          </div>
        )}

        {error && (
          <div data-testid="monitor-editor-error" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
          {isNew && hydrated && isPartnerScope && (
            <fieldset className="space-y-2 rounded-md border p-4" data-testid="monitor-editor-owner-scope">
              <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
                {t('monitoring:editor.ownerScope.legend')}
              </legend>
              <label className="flex items-center gap-2 text-sm">
                <input data-testid="monitor-editor-owner-partner" type="radio" value="partner" {...register('ownerScope')} />
                {t('monitoring:editor.ownerScope.partner')}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" value="organization" {...register('ownerScope')} />
                {t('monitoring:editor.ownerScope.organization')}
              </label>
            </fieldset>
          )}

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">{t('monitoring:editor.sections.watch')}</h2>
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="monitor-editor-name">
                {t('monitoring:editor.fields.name')}
              </label>
              <input
                id="monitor-editor-name"
                data-testid="monitor-editor-name"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                {...register('name')}
              />
              {errors.name && <p className="text-sm text-destructive">{String(errors.name.message)}</p>}
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="monitor-editor-description">
                {t('monitoring:editor.fields.description')}
              </label>
              <textarea
                id="monitor-editor-description"
                data-testid="monitor-editor-description"
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                {...register('description')}
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="monitor-editor-kind">
                {t('monitoring:editor.fields.kind')}
              </label>
              <select
                id="monitor-editor-kind"
                data-testid="monitor-editor-kind"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                value={watchKind}
                onChange={(e) => handleKindChange(e.target.value as MonitorKind)}
                disabled={!isNew}
              >
                {MONITOR_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(/* i18n-dynamic */ `monitoring:kinds.${kind}`)}
                  </option>
                ))}
              </select>
            </div>
            <MonitorConditionFields kind={watchKind} name="condition" />
            {watchKind === 'network_check' && <>
              <NetworkCheckAssetBinding
                orgId={isPartnerOwned ? null : ownerOrgId}
                assetId={(watch('condition').assetId as string | undefined) ?? null}
                onSelect={asset => setValue('condition', bindNetworkAsset(getValues('condition'), asset), { shouldDirty: true })}
              />
              {assetPrefillError && <p role="alert" className="text-sm text-destructive">
                {t('monitoring:editor.networkCheckAsset.failed')}{' '}
                <button type="button" className="underline" onClick={() => setAssetPrefillAttempt(value => value + 1)}>{t('common:actions.retry')}</button>
              </p>}
            </>}
            {errors.condition && (
              <p role="alert" data-testid="monitor-editor-condition-error" className="text-sm text-destructive">
                {t('monitoring:editor.errors.invalidCondition')}
              </p>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">{t('monitoring:editor.sections.noise')}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="monitor-editor-severity">
                  {t('monitoring:editor.fields.severity')}
                </label>
                <select
                  id="monitor-editor-severity"
                  data-testid="monitor-editor-severity"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  {...register('severity')}
                >
                  {['critical', 'high', 'medium', 'low', 'info'].map((sev) => (
                    <option key={sev} value={sev}>
                      {t(/* i18n-dynamic */ `monitoring:severities.${sev}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="monitor-editor-cooldown">
                  {t('monitoring:editor.fields.cooldownMinutes')}
                </label>
                <input
                  id="monitor-editor-cooldown"
                  data-testid="monitor-editor-cooldown"
                  type="number"
                  min={0}
                  max={1440}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  {...register('cooldownMinutes', { valueAsNumber: true })}
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" data-testid="monitor-editor-auto-resolve" {...register('autoResolve')} />
              {t('monitoring:editor.fields.autoResolve')}
            </label>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">{t('monitoring:editor.sections.respond')}</h2>
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="monitor-editor-ai-agent">
                {t('monitoring:editor.fields.aiAgent')}
              </label>
              <select
                id="monitor-editor-ai-agent"
                data-testid="monitor-editor-ai-agent"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                {...register('aiAgentId')}
              >
                <option value="">—</option>
                {aiAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-xs text-muted-foreground">{t('monitoring:editor.responsesHint')}</p>
            <ActionsEditor
              name="responses"
              compact
              allowAiTriage={!!watchAiAgentId}
              scripts={scripts}
              notificationChannels={notificationChannels}
              softwareCatalog={softwareCatalog}
            />
            <RestartResponseFields />
            {errors.responses && (
              <p role="alert" data-testid="monitor-editor-responses-error" className="text-sm text-destructive">
                {(errors.responses.root?.message ?? errors.responses.message) === RESTART_SERVICE_NAME_ISSUE
                  ? t('monitoring:editor.errors.restartServiceRequiresName')
                  : t('monitoring:editor.errors.invalidResponses')}
              </p>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">{t('monitoring:editor.sections.notify')}</h2>
            <Controller
              name="deliveryMode"
              control={control}
              render={({ field }) => (
                <div className="grid gap-2 sm:grid-cols-3">
                  {(['inherit', 'channels', 'none'] as const).map((mode) => (
                    <label key={mode} className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        value={mode}
                        checked={field.value === mode}
                        onChange={() => field.onChange(mode)}
                        data-testid={`monitor-editor-delivery-${mode}`}
                      />
                      {t(/* i18n-dynamic */ `monitoring:editor.deliveryModes.${mode}`)}
                    </label>
                  ))}
                </div>
              )}
            />
            {[channelRail, escalationRail].map((rail, index) => rail.status === 'error'
              ? <div key={index} role="alert">{t('alerts:deliveryPage.loadFailed')}
                  <button type="button" data-testid={`monitor-editor-delivery-rail-${index}-retry`} onClick={rail.reload}>{t('common:actions.retry')}</button></div>
              : rail.status === 'loading' ? <p key={index} role="status">{t('alerts:deliveryPage.loading')}</p> : null)}

            {watchDeliveryMode === 'channels' && (
              <div className="space-y-2">
                <label htmlFor="monitor-editor-channels" className="text-xs font-medium text-muted-foreground">{t('monitoring:editor.fields.channels')}</label>
                <select
                  multiple
                  id="monitor-editor-channels"
                  data-testid="monitor-editor-channels"
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  {...register('deliveryChannelIds')}
                  value={watchDeliveryChannelIds}
                  disabled={channelRail.status !== 'success'}
                >
                  {notificationChannels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.name} ({channel.type})
                    </option>
                  ))}
                </select>
              </div>
            )}
            {watchDeliveryMode === 'inherit' && <p className="text-xs text-muted-foreground">{t('monitoring:editor.deliveryPreview.draft')}</p>}
            {watchDeliveryMode === 'inherit' && (
              <DeliveryPreview
                orgId={monitorOrgId ?? currentOrgId}
                severity={watchSeverity}
                kind={watchKind}
                escalationOverride={compatibleEscalationPolicies.find(p => p.id === watchEscalationPolicyId) ?? null}
              />
            )}
            {watchDeliveryMode !== 'none' && (
              <div className="space-y-2">
                <label htmlFor="monitor-editor-escalation-policy" className="text-xs font-medium text-muted-foreground">
                  {t('monitoring:editor.fields.escalationPolicy')}
                </label>
                <select id="monitor-editor-escalation-policy" data-testid="monitor-editor-escalation-policy"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring" {...register('escalationPolicyId')}
                  value={watchEscalationPolicyId ?? ''} disabled={escalationRail.status !== 'success'}>
                  <option value="">{t('monitoring:editor.deliveryModes.inherit')}</option>
                  {compatibleEscalationPolicies.map(policy => <option key={policy.id} value={policy.id}>{policy.name}</option>)}
                </select>
              </div>
            )}
            <a href="/alerts/delivery" data-testid="monitor-editor-delivery-home" className="text-sm text-primary underline">
              {t('monitoring:editor.deliveryPreview.manage')}
            </a>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">{t('monitoring:editor.sections.escalate')}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="monitor-editor-recurrence-threshold">
                  {t('monitoring:editor.fields.recurrenceThreshold')}
                </label>
                <input
                  id="monitor-editor-recurrence-threshold"
                  data-testid="monitor-editor-recurrence-threshold"
                  type="number"
                  min={2}
                  max={100}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  {...register('recurrenceThreshold', {
                    // `valueAsNumber` turns an emptied field into NaN, which
                    // this field's `.nullable().optional()` schema rejects —
                    // blocking the save an operator uses to turn escalation
                    // back OFF, with no field-level message pointing at why.
                    // react-hook-form also runs `setValueAs` over the
                    // registered DEFAULT value (not only live DOM events), so
                    // this must tolerate `null`/`undefined` too — `Number(null)`
                    // is 0, which silently passed `.min(2)` as a false "too
                    // small" error instead of staying null.
                    setValueAs: (v: string | number | null) => (v === '' || v == null ? null : Number(v)),
                  })}
                />
                {errors.recurrenceThreshold && (
                  <p className="text-xs text-destructive">{String(errors.recurrenceThreshold.message)}</p>
                )}
              </div>
              <div className="space-y-2">
                <label
                  className="text-xs font-medium text-muted-foreground"
                  htmlFor="monitor-editor-recurrence-window-days"
                >
                  {t('monitoring:editor.fields.recurrenceWindowDays')}
                </label>
                <input
                  id="monitor-editor-recurrence-window-days"
                  data-testid="monitor-editor-recurrence-window-days"
                  type="number"
                  min={1}
                  max={365}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  {...register('recurrenceWindowDays', {
                    setValueAs: (v: string | number | null) => (v === '' || v == null ? null : Number(v)),
                  })}
                />
                {errors.recurrenceWindowDays && (
                  <p className="text-xs text-destructive">{String(errors.recurrenceWindowDays.message)}</p>
                )}
              </div>
            </div>

            <ActionsEditor
              name="recurrenceActions"
              compact
              allowAiTriage={!!watchAiAgentId}
              scripts={scripts}
              notificationChannels={notificationChannels}
              softwareCatalog={softwareCatalog}
            />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" data-testid="monitor-editor-pause-responses" {...register('pauseResponsesOnEscalation')} />
              {t('monitoring:editor.fields.pauseResponses')}
            </label>
            <p className="text-xs text-muted-foreground">{t('monitoring:editor.recurrenceHint')}</p>
          </section>

          {!isNew && (
            <section className="space-y-3" data-testid="monitor-editor-deployed-card">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">{t('monitoring:editor.sections.deployed')}</h2>
                <button
                  type="button"
                  data-testid="monitor-editor-deploy"
                  onClick={() => setDeployOpen(true)}
                  className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
                >
                  {t('monitoring:editor.actions.deploy')}
                </button>
              </div>
              {attachments.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('monitoring:editor.noAttachments')}</p>
              ) : (
                <ul className="space-y-2">
                  {attachments.map((attachment) => (
                    <li
                      key={attachment.id}
                      data-testid={`monitor-editor-attachment-${attachment.id}`}
                      className="flex items-center justify-between rounded-md border bg-background px-4 py-2 text-sm"
                    >
                      <a href={`/configuration-policies/${attachment.configPolicyId}`} className="text-primary hover:underline">
                        {attachment.policyName}
                      </a>
                      <button
                        type="button"
                        data-testid={`monitor-editor-detach-${attachment.id}`}
                        onClick={() => void handleDetach(attachment.id)}
                        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <MonitorDevicesTable monitorId={monitorId!} />
            </section>
          )}

          <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
            {!isNew ? (
              <button
                type="button"
                data-testid="monitor-editor-delete"
                onClick={() => setConfirmingDelete(true)}
                className="h-11 rounded-md border border-destructive/40 px-6 text-sm font-medium text-destructive hover:bg-destructive/10"
              >
                {t('monitoring:editor.actions.delete')}
              </button>
            ) : (
              <span />
            )}
            <button
              type="submit"
              data-testid="monitor-editor-save"
              disabled={isLoading}
              className="flex h-11 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isLoading ? t('monitoring:editor.actions.saving') : t('monitoring:editor.actions.save')}
            </button>
          </div>
        </form>
        </>
        )}

        {!isNew && monitorId && (
          <DeployMonitorDialog
            monitorId={monitorId}
            orgId={monitorOrgId}
            open={deployOpen}
            onClose={() => setDeployOpen(false)}
            onDeployed={() => {
              setDeployOpen(false);
              void fetchMonitor();
            }}
          />
        )}

        <ConfirmDialog
          open={confirmingDelete}
          onClose={() => setConfirmingDelete(false)}
          onConfirm={() => void handleDelete()}
          title={t('monitoring:editor.actions.delete')}
          message={t('monitoring:list.deleteConfirm', { name: watch('name') })}
          confirmLabel={t('monitoring:editor.actions.delete')}
          isLoading={deleting}
          confirmTestId="monitor-editor-delete-confirm"
        />
      </div>
    </FormProvider>
  );
}
