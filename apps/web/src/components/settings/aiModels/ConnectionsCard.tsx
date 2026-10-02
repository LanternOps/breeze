import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { AiConnectionDto, AiModelsSnapshotDto } from '@breeze/shared';
import ConnectionDrawer from './ConnectionDrawer';
import ResidencySwitch from './ResidencySwitch';

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

type DrawerState = { mode: 'closed' } | { mode: 'create' } | { mode: 'edit'; id: string };

export default function ConnectionsCard({
  snapshot,
  onChanged,
}: {
  snapshot: AiModelsSnapshotDto;
  onChanged: () => void | Promise<void>;
}) {
  const { t } = useTranslation('settings');
  const [drawer, setDrawer] = useState<DrawerState>({ mode: 'closed' });
  const hasOwnConnection = snapshot.connections.some((c) => c.id !== null);
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
          {!hasOwnConnection && (
            <button
              type="button"
              data-testid="ai-connection-add"
              onClick={() => setDrawer({ mode: 'create' })}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
            >
              {t('aiModels.connections.add')}
            </button>
          )}
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
                </td>
                <td className="py-2 pr-3">
                  <span data-testid={`ai-connection-status-${c.id ?? 'platform'}`} className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[c.status]}`}>
                    {statusLabel(c.status, t)}
                  </span>
                  {c.status === 'error' && c.lastError && <div className="mt-1 text-xs text-destructive">{c.lastError}</div>}
                </td>
                <td className="py-2 pr-3">{c.keyLast4 ? `••••${c.keyLast4}` : '—'}</td>
                <td className="py-2 pr-3">
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
        <ConnectionDrawer connection={null} catalog={snapshot.catalog} catalogEnabled={snapshot.catalogEnabled}
          onClose={() => setDrawer({ mode: 'closed' })} onSaved={onChanged} />
      )}
      {drawer.mode === 'edit' && editing && (
        <ConnectionDrawer key={editing.id} connection={editing} catalog={snapshot.catalog} catalogEnabled={snapshot.catalogEnabled}
          onClose={() => setDrawer({ mode: 'closed' })} onSaved={onChanged} />
      )}
    </section>
  );
}
