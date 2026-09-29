import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';
import CombineDialog from './CombineDialog';
import type { CombineCandidateGroup } from './types';

/**
 * Series W04 (spec §3.8): "N groups of near-identical reports could be
 * combined." A suggestion surface only — a failed candidate fetch hides the
 * banner and never touches the list. Cross-org by definition, so the ambient
 * org injection is skipped.
 */
export default function CombineBanner({ timezone, onCombined }: { timezone: string; onCombined: () => void }) {
  const { t } = useTranslation('reports');
  const [groups, setGroups] = useState<CombineCandidateGroup[]>([]);
  const [open, setOpen] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    try {
      const response = await fetchWithAuth('/reports/series/combine-candidates', { skipOrgIdInjection: true });
      if (!response?.ok) throw new Error(`combine candidates: HTTP ${response?.status}`);
      const payload = (await response.json()) as { data?: CombineCandidateGroup[] };
      if (current === generation.current) setGroups(Array.isArray(payload.data) ? payload.data : []);
    } catch (err) {
      console.warn('Failed to load combine candidates:', err);
      if (current === generation.current) setGroups([]);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { generation.current++; };
  }, [load]);

  if (groups.length === 0) return null;

  return (
    <div data-testid="reports-combine-banner" className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
      <span>{t('reports.seriesCombine.banner', { groups: groups.length })}</span>
      <button type="button" data-testid="reports-combine-review" onClick={() => setOpen(true)} className="rounded-md border px-3 py-1.5 font-medium hover:bg-muted">
        {t('reports.seriesCombine.review')}
      </button>
      {open && (
        <CombineDialog
          open
          groups={groups}
          timezone={timezone}
          onClose={() => setOpen(false)}
          onChanged={() => {
            setOpen(false);
            onCombined();
            void load();
          }}
        />
      )}
    </div>
  );
}
