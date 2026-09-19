import { Fragment, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Cpu,
  RefreshCw,
  Plus,
  ChevronDown,
  ChevronRight,
  ShieldCheck,
  ShieldQuestion,
  Lock,
  Loader2,
  Play,
} from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';
import { runAction, ActionError } from '@/lib/runAction';
import { showToast } from '../shared/Toast';
// Initializes the shared i18next singleton — see ThirdPartyCatalog.tsx for why
// this import must run before any island renders translated text.
import '../../lib/i18n';

// Selectable models for the catalog's per-revision model map. Mirrors
// OFFERABLE_AI_MODELS in apps/api/src/services/aiCostTracker.ts — the API
// rejects any mapped model id not on that list, so keep this in sync with it.
const OFFERABLE_AI_MODELS = [
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-fable-5',
] as const;

type CatalogStatus = 'draft' | 'listed' | 'delisted';
type AuthMode = 'x-api-key' | 'bearer';

interface ModelMapEntry {
  providerModel: string;
  inputCentsPerM: number;
  outputCentsPerM: number;
  cacheReadCentsPerM: number;
  cacheWriteCentsPerM: number;
}
type ModelMap = Record<string, ModelMapEntry>;

interface VerificationSummary {
  modelId: string;
  harnessVersion: string;
  passed: boolean;
  verifiedAt: string;
}

interface CatalogRevision {
  revisionId: string;
  revision: number;
  baseUrl: string;
  authMode: AuthMode;
  modelMap: ModelMap;
  dataNote: string | null;
  createdAt: string;
  verifiedModels: string[];
  verifications: VerificationSummary[];
}

interface CatalogEntry {
  entryId: string;
  slug: string;
  name: string;
  status: CatalogStatus;
  activeRevisionId: string | null;
  notes: string | null;
  createdAt: string;
  revisions: CatalogRevision[];
}

const statusStyles: Record<CatalogStatus, string> = {
  draft: 'bg-gray-100 text-gray-700',
  listed: 'bg-green-100 text-green-800',
  delisted: 'bg-red-100 text-red-800',
};

type ModelMapDraftRow = {
  included: boolean;
  providerModel: string;
  inputCentsPerM: string;
  outputCentsPerM: string;
  cacheReadCentsPerM: string;
  cacheWriteCentsPerM: string;
};

/**
 * The activation/listing gate, evaluated client-side purely to keep a control
 * from offering an action the API will reject.
 *
 * An empty map is NOT verified: the API's `assertAllModelsVerified` asks "is
 * every mapped model verified?", which an empty map answers vacuously — the
 * same trap the server-side `assertOfferableModelMap` closes.
 */
function isFullyVerified(revision: CatalogRevision): boolean {
  const modelIds = Object.keys(revision.modelMap);
  return modelIds.length > 0
    && modelIds.every((modelId) => revision.verifiedModels.includes(modelId));
}

/**
 * The entry's active revision, or undefined when there is none (or the pointer
 * is orphaned — which the API also treats as unlistable, with a 409).
 */
function activeRevisionOf(entry: CatalogEntry): CatalogRevision | undefined {
  if (!entry.activeRevisionId) return undefined;
  return entry.revisions.find((revision) => revision.revisionId === entry.activeRevisionId);
}

function emptyModelMapDraft(): Record<string, ModelMapDraftRow> {
  return Object.fromEntries(
    OFFERABLE_AI_MODELS.map((modelId) => [
      modelId,
      {
        included: false,
        providerModel: '',
        inputCentsPerM: '0',
        outputCentsPerM: '0',
        cacheReadCentsPerM: '0',
        cacheWriteCentsPerM: '0',
      },
    ]),
  );
}

export default function LlmProviderCatalog() {
  const { t } = useTranslation('admin');
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [requiresPlatformAdmin, setRequiresPlatformAdmin] = useState(false);
  const [error, setError] = useState<string>();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [showEntryForm, setShowEntryForm] = useState(false);
  const [entrySlug, setEntrySlug] = useState('');
  const [entryName, setEntryName] = useState('');
  const [entryNotes, setEntryNotes] = useState('');
  const [savingEntry, setSavingEntry] = useState(false);

  const [revisionFormEntryId, setRevisionFormEntryId] = useState<string | null>(null);
  const [revisionBaseUrl, setRevisionBaseUrl] = useState('');
  const [revisionAuthMode, setRevisionAuthMode] = useState<AuthMode>('x-api-key');
  const [revisionDataNote, setRevisionDataNote] = useState('');
  const [modelMapDraft, setModelMapDraft] = useState<Record<string, ModelMapDraftRow>>(emptyModelMapDraft());
  const [savingRevision, setSavingRevision] = useState(false);
  const [revisionFormError, setRevisionFormError] = useState<string>();

  const [verifyTarget, setVerifyTarget] = useState<{ revisionId: string; modelId: string } | null>(null);
  const [verifyApiKey, setVerifyApiKey] = useState('');
  const [verifyRunning, setVerifyRunning] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{
    passed: boolean;
    steps: Array<{ name: string; ok: boolean; detail?: string }>;
  } | null>(null);

  const [activatingRevisionId, setActivatingRevisionId] = useState<string | null>(null);
  const [statusChangingEntryId, setStatusChangingEntryId] = useState<string | null>(null);

  const fetchCatalog = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth('/admin/llm-provider-catalog');
      if (!response.ok) {
        if (response.status === 403) {
          setRequiresPlatformAdmin(true);
          setEntries([]);
          return;
        }
        throw new Error(t('admin.llmProviderCatalog.errors.load'));
      }
      setRequiresPlatformAdmin(false);
      const data = await response.json();
      setEntries(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.llmProviderCatalog.errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchCatalog();
  }, [fetchCatalog]);

  const resetEntryForm = () => {
    setShowEntryForm(false);
    setEntrySlug('');
    setEntryName('');
    setEntryNotes('');
  };

  const handleCreateEntry = async () => {
    if (!entrySlug.trim() || !entryName.trim() || savingEntry) return;
    setSavingEntry(true);
    try {
      await runAction({
        request: () => fetchWithAuth('/admin/llm-provider-catalog', {
          method: 'POST',
          body: JSON.stringify({
            slug: entrySlug.trim(),
            name: entryName.trim(),
            notes: entryNotes.trim() ? entryNotes.trim() : undefined,
          }),
        }),
        successMessage: t('admin.llmProviderCatalog.notice.entryCreated', { name: entryName.trim() }),
        errorFallback: t('admin.llmProviderCatalog.errors.createEntry'),
      });
      resetEntryForm();
      await fetchCatalog();
    } catch (err) {
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('admin.llmProviderCatalog.errors.createEntry') });
      }
    } finally {
      setSavingEntry(false);
    }
  };

  const openRevisionForm = (entryId: string) => {
    setRevisionFormEntryId(entryId);
    setRevisionBaseUrl('');
    setRevisionAuthMode('x-api-key');
    setRevisionDataNote('');
    setModelMapDraft(emptyModelMapDraft());
    setRevisionFormError(undefined);
  };

  const closeRevisionForm = () => {
    setRevisionFormEntryId(null);
    setRevisionFormError(undefined);
  };

  const updateModelMapRow = (modelId: string, patch: Partial<ModelMapDraftRow>) => {
    setModelMapDraft((prev) => ({ ...prev, [modelId]: { ...prev[modelId], ...patch } }));
  };

  const handleCreateRevision = async (entry: CatalogEntry) => {
    if (savingRevision || !revisionFormEntryId) return;
    setRevisionFormError(undefined);

    const modelMap: ModelMap = {};
    for (const [modelId, row] of Object.entries(modelMapDraft)) {
      if (!row.included) continue;
      modelMap[modelId] = {
        providerModel: row.providerModel.trim(),
        inputCentsPerM: Number(row.inputCentsPerM) || 0,
        outputCentsPerM: Number(row.outputCentsPerM) || 0,
        cacheReadCentsPerM: Number(row.cacheReadCentsPerM) || 0,
        cacheWriteCentsPerM: Number(row.cacheWriteCentsPerM) || 0,
      };
    }
    if (Object.keys(modelMap).length === 0) {
      setRevisionFormError(t('admin.llmProviderCatalog.revisionForm.errors.noModelsMapped'));
      return;
    }

    setSavingRevision(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/admin/llm-provider-catalog/${revisionFormEntryId}/revisions`, {
          method: 'POST',
          body: JSON.stringify({
            baseUrl: revisionBaseUrl.trim(),
            authMode: revisionAuthMode,
            modelMap,
            dataNote: revisionDataNote.trim() ? revisionDataNote.trim() : undefined,
          }),
        }),
        successMessage: t('admin.llmProviderCatalog.notice.revisionCreated', { name: entry.name }),
        errorFallback: t('admin.llmProviderCatalog.errors.createRevision'),
      });
      closeRevisionForm();
      setExpandedId(entry.entryId);
      await fetchCatalog();
    } catch (err) {
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('admin.llmProviderCatalog.errors.createRevision') });
      }
    } finally {
      setSavingRevision(false);
    }
  };

  const handleActivate = async (entry: CatalogEntry, revision: CatalogRevision) => {
    if (activatingRevisionId) return;
    setActivatingRevisionId(revision.revisionId);
    try {
      await runAction({
        request: () => fetchWithAuth(`/admin/llm-provider-catalog/${entry.entryId}/activate`, {
          method: 'POST',
          body: JSON.stringify({ revisionId: revision.revisionId }),
        }),
        successMessage: t('admin.llmProviderCatalog.notice.activated'),
        errorFallback: t('admin.llmProviderCatalog.errors.activate'),
      });
      await fetchCatalog();
    } catch (err) {
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('admin.llmProviderCatalog.errors.activate') });
      }
    } finally {
      setActivatingRevisionId(null);
    }
  };

  const handleSetStatus = async (entry: CatalogEntry, status: CatalogStatus) => {
    if (statusChangingEntryId) return;
    if (status === 'delisted' && !window.confirm(t('admin.llmProviderCatalog.confirmDelist', { name: entry.name }))) {
      return;
    }
    setStatusChangingEntryId(entry.entryId);
    try {
      await runAction({
        request: () => fetchWithAuth(`/admin/llm-provider-catalog/${entry.entryId}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status }),
        }),
        successMessage: t('admin.llmProviderCatalog.notice.statusUpdated', {
          status: t(/* i18n-dynamic */ `admin.llmProviderCatalog.status.${status}`),
        }),
        errorFallback: t('admin.llmProviderCatalog.errors.setStatus'),
      });
      await fetchCatalog();
    } catch (err) {
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('admin.llmProviderCatalog.errors.setStatus') });
      }
    } finally {
      setStatusChangingEntryId(null);
    }
  };

  const openVerifyForm = (revisionId: string, modelId: string) => {
    setVerifyTarget({ revisionId, modelId });
    setVerifyApiKey('');
    setVerifyResult(null);
  };

  const closeVerifyForm = () => {
    setVerifyTarget(null);
    setVerifyApiKey('');
    setVerifyResult(null);
  };

  const handleRunVerification = async () => {
    if (!verifyTarget || !verifyApiKey.trim() || verifyRunning) return;
    setVerifyRunning(true);
    setVerifyResult(null);
    try {
      const result = await runAction<{
        passed: boolean;
        steps: Array<{ name: string; ok: boolean; detail?: string }>;
      }>({
        request: () => fetchWithAuth(`/admin/llm-provider-catalog/revisions/${verifyTarget.revisionId}/verify`, {
          method: 'POST',
          body: JSON.stringify({ modelId: verifyTarget.modelId, apiKey: verifyApiKey.trim() }),
        }),
        errorFallback: t('admin.llmProviderCatalog.errors.verify'),
      });
      setVerifyResult({ passed: result.passed, steps: result.steps });
      // Transient test key never persists beyond the request that used it.
      setVerifyApiKey('');
      await fetchCatalog();
    } catch (err) {
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('admin.llmProviderCatalog.errors.verify') });
      }
    } finally {
      setVerifyRunning(false);
    }
  };

  if (requiresPlatformAdmin) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold flex items-center gap-2 mb-6">
          <Cpu className="w-6 h-6" /> {t('admin.llmProviderCatalog.title')}
        </h1>
        <div
          data-testid="llm-catalog-requires-platform-admin"
          className="bg-blue-50 border border-blue-200 text-blue-900 px-6 py-8 rounded flex items-start gap-4"
        >
          <Lock className="w-6 h-6 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold mb-1">{t('admin.llmProviderCatalog.platformAdmin.title')}</div>
            <div className="text-sm">
              {t('admin.llmProviderCatalog.platformAdmin.prefix')}
              {' ('}
              {t('admin.llmProviderCatalog.platformAdmin.role')}
              {') '}
              {t('admin.llmProviderCatalog.platformAdmin.suffix')}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Cpu className="w-6 h-6" /> {t('admin.llmProviderCatalog.title')}
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            {t('admin.llmProviderCatalog.description')}{' '}
            {t('admin.llmProviderCatalog.totalEntries')}{' '}
            <span data-testid="llm-catalog-total">{entries.length}</span>
          </p>
        </div>
        <div className="flex gap-2">
          <button
            data-testid="llm-catalog-refresh"
            onClick={fetchCatalog}
            className="px-3 py-2 text-sm border rounded hover:bg-gray-50 flex items-center gap-1"
          >
            <RefreshCw className="w-4 h-4" /> {t('admin.llmProviderCatalog.refresh')}
          </button>
          <button
            data-testid="llm-catalog-add-entry"
            onClick={() => setShowEntryForm(true)}
            className="px-3 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 flex items-center gap-1"
          >
            <Plus className="w-4 h-4" /> {t('admin.llmProviderCatalog.addEntry')}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 text-red-800 px-4 py-3 rounded mb-4">{error}</div>
      )}

      {showEntryForm && (
        <div data-testid="llm-catalog-entry-form" className="border rounded p-4 mb-4 space-y-3 bg-gray-50">
          <h2 className="font-medium">{t('admin.llmProviderCatalog.entryForm.title')}</h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">{t('admin.llmProviderCatalog.entryForm.fields.slug')}</label>
              <input
                data-testid="llm-catalog-entry-slug"
                type="text"
                value={entrySlug}
                onChange={(e) => setEntrySlug(e.target.value)}
                placeholder={t('admin.llmProviderCatalog.entryForm.placeholders.slug')}
                className="w-full border rounded px-3 py-2 text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">{t('admin.llmProviderCatalog.entryForm.fields.name')}</label>
              <input
                data-testid="llm-catalog-entry-name"
                type="text"
                value={entryName}
                onChange={(e) => setEntryName(e.target.value)}
                placeholder={t('admin.llmProviderCatalog.entryForm.placeholders.name')}
                className="w-full border rounded px-3 py-2 text-sm"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">{t('admin.llmProviderCatalog.entryForm.fields.notes')}</label>
            <textarea
              data-testid="llm-catalog-entry-notes"
              value={entryNotes}
              onChange={(e) => setEntryNotes(e.target.value)}
              placeholder={t('admin.llmProviderCatalog.entryForm.placeholders.notes')}
              rows={2}
              className="w-full border rounded px-3 py-2 text-sm"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              data-testid="llm-catalog-entry-cancel"
              onClick={resetEntryForm}
              className="px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded"
            >
              {t('admin.llmProviderCatalog.entryForm.cancel')}
            </button>
            <button
              data-testid="llm-catalog-entry-submit"
              onClick={handleCreateEntry}
              disabled={!entrySlug.trim() || !entryName.trim() || savingEntry}
              className="px-3 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
            >
              {savingEntry && <Loader2 className="w-4 h-4 animate-spin" />}
              {t('admin.llmProviderCatalog.entryForm.submit')}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-500">{t('admin.llmProviderCatalog.loading')}</div>
      ) : entries.length === 0 ? (
        <div className="text-center py-12 text-gray-500" data-testid="llm-catalog-empty">
          {t('admin.llmProviderCatalog.empty')}
        </div>
      ) : (
        <div className="overflow-x-auto border rounded">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr className="text-left">
                <th className="px-4 py-2 font-medium" />
                <th className="px-4 py-2 font-medium">{t('admin.llmProviderCatalog.table.slug')}</th>
                <th className="px-4 py-2 font-medium">{t('admin.llmProviderCatalog.table.name')}</th>
                <th className="px-4 py-2 font-medium">{t('admin.llmProviderCatalog.table.status')}</th>
                <th className="px-4 py-2 font-medium">{t('admin.llmProviderCatalog.table.revisions')}</th>
                <th className="px-4 py-2 font-medium text-right">{t('admin.llmProviderCatalog.table.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const expanded = expandedId === entry.entryId;
                // Listing re-runs the verification gate server-side (409 on a
                // half-verified active revision), so the button must mirror the
                // Activate button's rule rather than only checking that SOME
                // revision is active.
                const activeRevision = activeRevisionOf(entry);
                const canList = activeRevision !== undefined && isFullyVerified(activeRevision);
                return (
                  <Fragment key={entry.entryId}>
                    <tr data-testid={`llm-catalog-row-${entry.entryId}`} className="border-b hover:bg-gray-50">
                      <td className="px-4 py-2">
                        <button
                          data-testid={`llm-catalog-row-${entry.entryId}-toggle`}
                          onClick={() => setExpandedId(expanded ? null : entry.entryId)}
                          aria-label={expanded
                            ? t('admin.llmProviderCatalog.actions.collapse')
                            : t('admin.llmProviderCatalog.actions.expand')}
                          className="p-1 rounded hover:bg-gray-200"
                        >
                          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </button>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-gray-600">{entry.slug}</td>
                      <td className="px-4 py-2">{entry.name}</td>
                      <td className="px-4 py-2">
                        <span
                          data-testid={`llm-catalog-row-${entry.entryId}-status`}
                          className={`inline-block px-2 py-0.5 rounded text-xs ${statusStyles[entry.status]}`}
                        >
                          {t(/* i18n-dynamic */ `admin.llmProviderCatalog.status.${entry.status}`)}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-gray-600">{entry.revisions.length}</td>
                      <td className="px-4 py-2 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            data-testid={`llm-catalog-row-${entry.entryId}-add-revision`}
                            onClick={() => openRevisionForm(entry.entryId)}
                            className="px-2 py-1 text-xs border rounded hover:bg-gray-100"
                          >
                            {t('admin.llmProviderCatalog.actions.addRevision')}
                          </button>
                          {entry.status !== 'listed' && (
                            <button
                              data-testid={`llm-catalog-row-${entry.entryId}-list`}
                              onClick={() => handleSetStatus(entry, 'listed')}
                              disabled={!canList || statusChangingEntryId === entry.entryId}
                              title={canList ? undefined : t('admin.llmProviderCatalog.revision.listBlocked')}
                              className="px-2 py-1 text-xs border rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {t('admin.llmProviderCatalog.actions.list')}
                            </button>
                          )}
                          {entry.status !== 'delisted' && (
                            <button
                              data-testid={`llm-catalog-row-${entry.entryId}-delist`}
                              onClick={() => handleSetStatus(entry, 'delisted')}
                              disabled={statusChangingEntryId === entry.entryId}
                              className="px-2 py-1 text-xs border rounded hover:bg-gray-100 disabled:opacity-50"
                            >
                              {t('admin.llmProviderCatalog.actions.delist')}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={6} className="px-4 py-3 bg-gray-50 border-b">
                          <div data-testid={`llm-catalog-revisions-${entry.entryId}`} className="space-y-3">
                            {entry.revisions.length === 0 ? (
                              <div className="text-xs text-gray-500">{t('admin.llmProviderCatalog.empty')}</div>
                            ) : (
                              entry.revisions.map((revision) => {
                                const modelIds = Object.keys(revision.modelMap);
                                const allVerified = isFullyVerified(revision);
                                const isActive = entry.activeRevisionId === revision.revisionId;
                                return (
                                  <div
                                    key={revision.revisionId}
                                    data-testid={`llm-catalog-revision-${revision.revisionId}`}
                                    className="border rounded p-3 bg-white space-y-2"
                                  >
                                    <div className="flex items-center justify-between">
                                      <div className="text-sm">
                                        <span className="font-medium">
                                          {t('admin.llmProviderCatalog.revision.baseUrl')}:
                                        </span>{' '}
                                        <span className="font-mono text-xs">{revision.baseUrl}</span>
                                        {isActive && (
                                          <span
                                            data-testid={`llm-catalog-revision-${revision.revisionId}-active-badge`}
                                            className="ml-2 inline-block px-2 py-0.5 rounded text-xs bg-blue-100 text-blue-800"
                                          >
                                            {t('admin.llmProviderCatalog.table.activeRevision')}
                                          </span>
                                        )}
                                      </div>
                                      <button
                                        data-testid={`llm-catalog-revision-${revision.revisionId}-activate`}
                                        onClick={() => handleActivate(entry, revision)}
                                        disabled={!allVerified || isActive || activatingRevisionId === revision.revisionId}
                                        title={allVerified ? undefined : t('admin.llmProviderCatalog.revision.activateBlocked')}
                                        className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                                      >
                                        {t('admin.llmProviderCatalog.actions.activate')}
                                      </button>
                                    </div>
                                    <div className="text-xs text-gray-500">
                                      {t('admin.llmProviderCatalog.revision.authMode')}: {t(/* i18n-dynamic */ `admin.llmProviderCatalog.authModeOptions.${revision.authMode}`)}
                                    </div>
                                    <table className="w-full text-xs">
                                      <tbody>
                                        {modelIds.map((modelId) => {
                                          const verified = revision.verifiedModels.includes(modelId);
                                          return (
                                            <tr key={modelId} className="border-t">
                                              <td className="py-1 pr-2 font-mono">{modelId}</td>
                                              <td className="py-1 pr-2">
                                                {verified ? (
                                                  <span
                                                    data-testid={`llm-catalog-revision-${revision.revisionId}-${modelId}-verified-badge`}
                                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-green-100 text-green-800"
                                                  >
                                                    <ShieldCheck className="w-3 h-3" /> {t('admin.llmProviderCatalog.revision.verified')}
                                                  </span>
                                                ) : (
                                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                                                    <ShieldQuestion className="w-3 h-3" /> {t('admin.llmProviderCatalog.revision.notVerified')}
                                                  </span>
                                                )}
                                              </td>
                                              <td className="py-1 text-right">
                                                <button
                                                  data-testid={`llm-catalog-revision-${revision.revisionId}-${modelId}-verify`}
                                                  onClick={() => openVerifyForm(revision.revisionId, modelId)}
                                                  className="p-1 rounded hover:bg-gray-200"
                                                  aria-label={t('admin.llmProviderCatalog.actions.verify')}
                                                >
                                                  <Play className="w-3 h-3 text-blue-600" />
                                                </button>
                                              </td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                );
                              })
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {revisionFormEntryId && (() => {
        const entry = entries.find((e) => e.entryId === revisionFormEntryId);
        if (!entry) return null;
        return (
          <div
            data-testid="llm-catalog-revision-form-modal"
            className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          >
            <div className="bg-white rounded-lg shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto">
              <div className="px-6 py-4 border-b">
                <h2 className="text-lg font-medium">
                  {t('admin.llmProviderCatalog.revisionForm.title', { name: entry.name })}
                </h2>
              </div>
              <div className="px-6 py-4 space-y-4">
                {revisionFormError && (
                  <div className="bg-red-50 text-red-800 px-3 py-2 rounded text-sm">{revisionFormError}</div>
                )}
                <div>
                  <label className="block text-sm font-medium mb-1">{t('admin.llmProviderCatalog.revisionForm.fields.baseUrl')}</label>
                  <input
                    data-testid="llm-catalog-revision-baseurl"
                    type="text"
                    value={revisionBaseUrl}
                    onChange={(e) => setRevisionBaseUrl(e.target.value)}
                    placeholder={t('admin.llmProviderCatalog.revisionForm.placeholders.baseUrl')}
                    className="w-full border rounded px-3 py-2 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">{t('admin.llmProviderCatalog.revisionForm.fields.authMode')}</label>
                  <select
                    data-testid="llm-catalog-revision-authmode"
                    value={revisionAuthMode}
                    onChange={(e) => setRevisionAuthMode(e.target.value as AuthMode)}
                    className="w-full border rounded px-3 py-2 text-sm"
                  >
                    <option value="x-api-key">{t('admin.llmProviderCatalog.authModeOptions.x-api-key')}</option>
                    <option value="bearer">{t('admin.llmProviderCatalog.authModeOptions.bearer')}</option>
                  </select>
                </div>
                <div>
                  <div className="font-medium text-sm mb-1">{t('admin.llmProviderCatalog.revisionForm.modelMap.title')}</div>
                  <p className="text-xs text-gray-500 mb-2">{t('admin.llmProviderCatalog.revisionForm.modelMap.description')}</p>
                  <div className="space-y-2">
                    {OFFERABLE_AI_MODELS.map((modelId) => {
                      const row = modelMapDraft[modelId];
                      return (
                        <div key={modelId} data-testid={`llm-catalog-modelmap-${modelId}`} className="border rounded p-2">
                          <label className="flex items-center gap-2 text-xs font-mono mb-2">
                            <input
                              data-testid={`llm-catalog-modelmap-${modelId}-included`}
                              type="checkbox"
                              checked={row.included}
                              onChange={(e) => updateModelMapRow(modelId, { included: e.target.checked })}
                            />
                            {modelId}
                          </label>
                          {row.included && (
                            <div className="grid grid-cols-6 gap-2">
                              <input
                                data-testid={`llm-catalog-modelmap-${modelId}-providermodel`}
                                type="text"
                                value={row.providerModel}
                                onChange={(e) => updateModelMapRow(modelId, { providerModel: e.target.value })}
                                placeholder={t('admin.llmProviderCatalog.revisionForm.modelMap.providerModel')}
                                className="col-span-2 border rounded px-2 py-1 text-xs font-mono"
                              />
                              <input
                                data-testid={`llm-catalog-modelmap-${modelId}-input`}
                                type="number"
                                min={0}
                                value={row.inputCentsPerM}
                                onChange={(e) => updateModelMapRow(modelId, { inputCentsPerM: e.target.value })}
                                placeholder={t('admin.llmProviderCatalog.revisionForm.modelMap.inputPrice')}
                                className="border rounded px-2 py-1 text-xs"
                              />
                              <input
                                data-testid={`llm-catalog-modelmap-${modelId}-output`}
                                type="number"
                                min={0}
                                value={row.outputCentsPerM}
                                onChange={(e) => updateModelMapRow(modelId, { outputCentsPerM: e.target.value })}
                                placeholder={t('admin.llmProviderCatalog.revisionForm.modelMap.outputPrice')}
                                className="border rounded px-2 py-1 text-xs"
                              />
                              <input
                                data-testid={`llm-catalog-modelmap-${modelId}-cacheread`}
                                type="number"
                                min={0}
                                value={row.cacheReadCentsPerM}
                                onChange={(e) => updateModelMapRow(modelId, { cacheReadCentsPerM: e.target.value })}
                                placeholder={t('admin.llmProviderCatalog.revisionForm.modelMap.cacheReadPrice')}
                                className="border rounded px-2 py-1 text-xs"
                              />
                              <input
                                data-testid={`llm-catalog-modelmap-${modelId}-cachewrite`}
                                type="number"
                                min={0}
                                value={row.cacheWriteCentsPerM}
                                onChange={(e) => updateModelMapRow(modelId, { cacheWriteCentsPerM: e.target.value })}
                                placeholder={t('admin.llmProviderCatalog.revisionForm.modelMap.cacheWritePrice')}
                                className="border rounded px-2 py-1 text-xs"
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">{t('admin.llmProviderCatalog.revisionForm.fields.dataNote')}</label>
                  <textarea
                    data-testid="llm-catalog-revision-datanote"
                    value={revisionDataNote}
                    onChange={(e) => setRevisionDataNote(e.target.value)}
                    placeholder={t('admin.llmProviderCatalog.revisionForm.placeholders.dataNote')}
                    rows={2}
                    className="w-full border rounded px-3 py-2 text-sm"
                  />
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 border-t px-6 py-3">
                <button
                  data-testid="llm-catalog-revision-cancel"
                  onClick={closeRevisionForm}
                  className="px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded"
                >
                  {t('admin.llmProviderCatalog.revisionForm.cancel')}
                </button>
                <button
                  data-testid="llm-catalog-revision-submit"
                  onClick={() => handleCreateRevision(entry)}
                  disabled={!revisionBaseUrl.trim() || savingRevision}
                  className="px-3 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
                >
                  {savingRevision && <Loader2 className="w-4 h-4 animate-spin" />}
                  {t('admin.llmProviderCatalog.revisionForm.submit')}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {verifyTarget && (
        <div
          data-testid="llm-catalog-verify-modal"
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
        >
          <div className="bg-white rounded-lg shadow-lg w-full max-w-md">
            <div className="px-6 py-4 border-b">
              <h2 className="text-lg font-medium">
                {t('admin.llmProviderCatalog.verifyForm.title', { model: verifyTarget.modelId })}
              </h2>
            </div>
            <div className="px-6 py-4 space-y-3">
              <p className="text-xs text-gray-500">{t('admin.llmProviderCatalog.verifyForm.description')}</p>
              <div>
                <label className="block text-sm font-medium mb-1">{t('admin.llmProviderCatalog.verifyForm.apiKeyLabel')}</label>
                <input
                  data-testid="llm-catalog-verify-apikey"
                  type="password"
                  value={verifyApiKey}
                  onChange={(e) => setVerifyApiKey(e.target.value)}
                  placeholder={t('admin.llmProviderCatalog.verifyForm.apiKeyPlaceholder')}
                  className="w-full border rounded px-3 py-2 text-sm font-mono"
                  autoComplete="off"
                />
              </div>
              {verifyResult && (
                <div
                  data-testid="llm-catalog-verify-result"
                  className={`text-sm px-3 py-2 rounded ${verifyResult.passed ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}
                >
                  {verifyResult.passed
                    ? t('admin.llmProviderCatalog.verifyForm.passed')
                    : t('admin.llmProviderCatalog.verifyForm.failed')}
                </div>
              )}
              {verifyResult && verifyResult.steps.length > 0 && (
                <ul data-testid="llm-catalog-verify-steps" className="border rounded divide-y">
                  {verifyResult.steps.map((step, index) => (
                    <li
                      key={`${index}-${step.name}`}
                      data-testid={`llm-catalog-verify-step-${index}`}
                      className="px-3 py-2 flex items-start gap-2 text-sm"
                    >
                      <span
                        aria-hidden="true"
                        className={`shrink-0 font-mono ${step.ok ? 'text-green-600' : 'text-red-600'}`}
                      >
                        {step.ok ? '✓' : '✗'}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{step.name}</span>
                        {step.detail && (
                          <span className="block text-xs font-mono text-gray-600 break-words">{step.detail}</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t px-6 py-3">
              <button
                data-testid="llm-catalog-verify-cancel"
                onClick={closeVerifyForm}
                className="px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded"
              >
                {t('admin.llmProviderCatalog.verifyForm.cancel')}
              </button>
              <button
                data-testid="llm-catalog-verify-submit"
                onClick={handleRunVerification}
                disabled={!verifyApiKey.trim() || verifyRunning}
                className="px-3 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
              >
                {verifyRunning && <Loader2 className="w-4 h-4 animate-spin" />}
                {verifyRunning ? t('admin.llmProviderCatalog.verifyForm.running') : t('admin.llmProviderCatalog.verifyForm.submit')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
