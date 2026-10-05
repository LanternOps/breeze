import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { AiConnectionDto, AiModelsSnapshotDto } from '@breeze/shared';
import ConnectionDrawer from './ConnectionDrawer';
import ResidencySwitch from './ResidencySwitch';
import { ADDABLE_CONNECTION_KINDS, ADD_KIND_LABEL_KEYS, ADD_KIND_TEST_IDS, type AddableConnectionKind } from './connectionForms/connectionKinds';
import { resolvedFormattingLocale } from '../../../lib/i18n/format';

/** Exhaustive over AiConnectionKind: W06/W07 add an arm when they add a kind. */
function kindLabel(connection: AiConnectionDto, t: TFunction<'settings'>): string {
  const kind = connection.kind;
  switch (kind) {
    case 'platform': return t('aiModels.connections.kind.platform');
    case 'anthropic_byok': return t('aiModels.connections.kind.anthropic_byok');
    case 'catalog': return t('aiModels.connections.kind.catalog');
    case 'openai_compatible': return t('aiModels.connections.kind.openai_compatible');
    default: {
      const unreachable: never = kind;
      return String(unreachable);
    }
  }
}

function statusLabel(status: AiConnectionDto['status'], t: TFunction<'settings'>): string {
  switch (status) {
    case 'active': return t('aiModels.connections.status.active');
    case 'error': return t('aiModels.connections.status.error');
    case 'platform': return t('aiModels.connections.status.platform');
    default: {
      const unreachable: never = status;
      return String(unreachable);
    }
  }
}

function geoSourceLabel(source: AiConnectionDto['inferenceGeoSource'], t: TFunction<'settings'>): string {
  switch (source) {
    case 'connection': return t('aiModels.connections.geoSource.connection');
    case 'platform': return t('aiModels.connections.geoSource.platform');
    case 'provider_default': return t('aiModels.connections.geoSource.provider_default');
    default: {
      const unreachable: never = source;
      return String(unreachable);
    }
  }
}

const STATUS_CLASS: Record<AiConnectionDto['status'], string> = {
  active: 'bg-success/10 text-success',
  error: 'bg-destructive/10 text-destructive',
  platform: 'bg-muted text-muted-foreground',
};

type DrawerState = { mode: 'closed' } | { mode: 'create'; kind: AddableConnectionKind } | { mode: 'edit'; id: string };

const hostOf = (baseUrl: string | null): string => {
  if (!baseUrl) return '';
  try { return new URL(baseUrl).host; } catch { return baseUrl; }
};

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(resolvedFormattingLocale(), { numeric: 'auto' });
  if (Math.abs(minutes) < 60) return rtf.format(-Math.max(minutes, 0), 'minute');
  if (Math.abs(minutes) < 60 * 24) return rtf.format(-Math.round(minutes / 60), 'hour');
  return rtf.format(-Math.round(minutes / (60 * 24)), 'day');
}

export default function ConnectionsCard({
  snapshot,
  onChanged,
}: {
  snapshot: AiModelsSnapshotDto;
  onChanged: () => void | Promise<void>;
}) {
  const { t } = useTranslation('settings');
  const [drawer, setDrawer] = useState<DrawerState>({ mode: 'closed' });
  const [chooserOpen, setChooserOpen] = useState(false);
  // compat_uq: one Anthropic-dialect (BYOK or catalog) connection per partner.
  const hasCompatConnection = snapshot.connections.some((c) => c.id !== null && (c.kind === 'anthropic_byok' || c.kind === 'catalog'));
  const modelCount = (id: string | null) => snapshot.offerings.filter((o) => o.connectionId === id).length;
  const editing = drawer.mode === 'edit' ? snapshot.connections.find((c) => c.id === drawer.id) ?? null : null;

  return (
    <section data-testid="ai-connections-card" className="space-y-3 rounded-md border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{t('aiModels.connections.title')}</h3>
          <p className="text-xs text-muted-foreground">{t('aiModels.connections.subtitle')}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <ResidencySwitch required={snapshot.partner.residencyRequired} onSaved={onChanged} />
          <div className="relative">
            <button
              type="button"
              data-testid="ai-connection-add"
              aria-expanded={chooserOpen}
              onClick={() => setChooserOpen((open) => !open)}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
            >
              {t('aiModels.connections.add')}
            </button>
            {chooserOpen && (
              <div data-testid="ai-connection-add-chooser" className="absolute right-0 z-10 mt-1 w-64 space-y-1 rounded-md border bg-background p-2 shadow-md">
                {ADDABLE_CONNECTION_KINDS.map((k) => {
                  const unavailable = k === 'anthropic_byok' && hasCompatConnection;
                  return (
                    <button
                      key={k}
                      type="button"
                      data-testid={ADD_KIND_TEST_IDS[k]}
                      disabled={unavailable}
                      onClick={() => { setChooserOpen(false); setDrawer({ mode: 'create', kind: k }); }}
                      className="block w-full rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <span className="block font-medium">{t(/* i18n-dynamic */ ADD_KIND_LABEL_KEYS[k])}</span>
                      {unavailable && <span className="block text-xs text-muted-foreground">{t('aiModels.connections.alreadyConnected')}</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-medium">{t('aiModels.connections.columns.name')}</th>
              <th className="py-1 pr-3 font-medium">{t('aiModels.connections.columns.status')}</th>
              <th className="py-1 pr-3 font-medium">{t('aiModels.connections.columns.key')}</th>
              <th className="py-1 pr-3 font-medium">{t('aiModels.connections.columns.geo')}</th>
              <th className="py-1 pr-3 font-medium">{t('aiModels.connections.columns.funding')}</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {snapshot.connections.map((c) => (
              <tr key={c.id ?? 'platform'} data-testid={`ai-connection-row-${c.id ?? 'platform'}`} className="border-t align-top">
                <td className="py-2 pr-3">
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-muted-foreground">{kindLabel(c, t)}</div>
                  {c.kind === 'openai_compatible' && (
                    <div className="mt-0.5 flex flex-wrap items-center gap-2">
                      <span data-testid={`ai-connection-row-host-${c.id}`} className="text-xs text-muted-foreground">{hostOf(c.baseUrl)}</span>
                      {c.managedBy === 'env' && (
                        <span data-testid={`ai-connection-env-managed-${c.id}`} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          {t('aiModels.connections.openai.envManagedBadge')}
                        </span>
                      )}
                    </div>
                  )}
                </td>
                <td className="py-2 pr-3">
                  <span data-testid={`ai-connection-status-${c.id ?? 'platform'}`} className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[c.status]}`}>
                    {statusLabel(c.status, t)}
                  </span>
                  {c.status === 'error' && c.lastError && <div className="mt-1 text-xs text-destructive">{c.lastError}</div>}
                  {c.kind === 'openai_compatible' && (c.discoveryError || c.lastDiscoveredAt) && (
                    <div data-testid={`ai-connection-discovery-${c.id}`} className={`mt-1 text-xs ${c.discoveryError ? 'text-destructive' : 'text-muted-foreground'}`}>
                      {c.discoveryError
                        ?? t('aiModels.connections.openai.discovered', { count: modelCount(c.id), when: relativeTime(c.lastDiscoveredAt as string) })}
                    </div>
                  )}
                </td>
                <td data-testid={`ai-connection-key-${c.id ?? 'platform'}`} className="py-2 pr-3">
                  {c.keyLast4 ? `••••${c.keyLast4}` : c.kind === 'openai_compatible' ? t('aiModels.connections.openai.noKey') : '—'}
                </td>
                <td className="py-2 pr-3">
                  {c.kind === 'openai_compatible' ? <span className="text-muted-foreground">—</span> : (<>
                  <div>
                    {c.effectiveInferenceGeo === null ? t('aiModels.connections.geoProviderDefault') : c.effectiveInferenceGeo}
                    {c.effectiveInferenceGeo !== null && (
                      <span className="text-xs text-muted-foreground"> ({geoSourceLabel(c.inferenceGeoSource, t)})</span>
                    )}
                  </div>
                  {c.supportedInferenceGeos.length > 0 && (
                    <div className="text-xs text-muted-foreground">
                      {t('aiModels.connections.supportedGeos', { geos: c.supportedInferenceGeos.join(', ') })}
                    </div>
                  )}
                  </>)}
                </td>
                <td className="py-2 pr-3">
                  {c.funding === 'platform' ? t('aiModels.connections.funding.platform') : t('aiModels.connections.funding.partner_key')}
                </td>
                <td className="py-2 text-right">
                  {c.id !== null && (
                    <button
                      type="button"
                      data-testid={`ai-connection-edit-${c.id}`}
                      onClick={() => setDrawer({ mode: 'edit', id: c.id as string })}
                      className="rounded-md border px-3 py-1 text-xs font-medium transition-colors hover:bg-muted"
                    >
                      {t('aiModels.connections.edit')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {drawer.mode === 'create' && (
        <ConnectionDrawer connection={null} initialKind={drawer.kind} catalog={snapshot.catalog} catalogEnabled={snapshot.catalogEnabled}
          onClose={() => setDrawer({ mode: 'closed' })} onSaved={onChanged} />
      )}
      {drawer.mode === 'edit' && editing && (
        <ConnectionDrawer key={editing.id} connection={editing} catalog={snapshot.catalog} catalogEnabled={snapshot.catalogEnabled}
          onClose={() => setDrawer({ mode: 'closed' })} onSaved={onChanged} />
      )}
    </section>
  );
}
