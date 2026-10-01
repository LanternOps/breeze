import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AiOrgModelDefaultsDto, AiSurface } from '@breeze/shared';
import { fetchWithAuth } from '../../../stores/auth';

/**
 * Pointer that replaces a legacy per-page model field: shows the effective model
 * for the feature (org context only) and links to where it is now edited.
 * Read-only.
 */
export default function ModelDefaultsLink({ surface, orgId, level }: {
  surface: AiSurface;
  orgId?: string | null;
  level: 'partner' | 'org';
}) {
  const { t } = useTranslation('settings');
  // undefined = not resolved (static text), null = resolved to "no default".
  const [model, setModel] = useState<string | null | undefined>(undefined);
  const showOrg = level === 'org' && !!orgId;

  useEffect(() => {
    if (!orgId) { setModel(undefined); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth(`/ai/models/orgs/${orgId}/assignments`);
        if (!res.ok) return;
        const dto = (await res.json()) as AiOrgModelDefaultsDto;
        const id = dto.surfaces.find((s) => s.surface === surface)?.effective.defaultOfferingId ?? null;
        if (!cancelled) setModel(id ? (dto.offerings.find((o) => o.id === id)?.displayName ?? null) : null);
      } catch {
        // Static text stays; the links below still work.
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, surface]);

  const modelText = model === undefined ? t('aiModels.link.setPerFeature') : (model ?? t('aiModels.link.noDefault'));
  return (
    <div className="text-sm" data-testid={`model-defaults-link-${surface}`}>
      <p>{t('aiModels.link.summary', { model: modelText })}</p>
      <p className="mt-1 flex flex-wrap gap-3 text-xs">
        <a data-testid="model-defaults-link-partner" href="/settings/partner#ai-provider" className="text-primary hover:underline">
          {t('aiModels.link.partner')}
        </a>
        {showOrg && (
          <a data-testid="model-defaults-link-org" href={`/settings/organizations/${orgId}#ai`} className="text-primary hover:underline">
            {t('aiModels.link.org')}
          </a>
        )}
      </p>
    </div>
  );
}
