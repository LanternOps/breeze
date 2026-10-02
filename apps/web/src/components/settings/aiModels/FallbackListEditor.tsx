import { useTranslation } from 'react-i18next';
import { MAX_FALLBACK_OFFERINGS, type AiOfferingDto } from '@breeze/shared';

export interface FallbackListEditorProps {
  /** Test-id suffix: `${surface}` or `${surface}-${role}`. */
  rowKey: string;
  /** Test-id prefix: 'ai-defaults' (partner card) or 'org-model-defaults' (org card). */
  idPrefix?: string;
  value: string[];
  /** Eligible enabled offerings for this row (tool-filtered, permitted-filtered, never the row's own default). */
  options: Array<Pick<AiOfferingDto, 'id' | 'displayName' | 'funding'>>;
  /** The funding of the row's default; null when the row inherits a default it cannot see. */
  referenceFunding: 'platform' | 'partner_key' | null;
  crossFunding: boolean;
  onChange: (next: string[]) => void;
  disabled?: boolean;
}

/** Ordered list of backup models: reorder, remove, add (same-funding only unless crossing is allowed). */
export function FallbackListEditor(props: FallbackListEditorProps) {
  const { t } = useTranslation('settings');
  const prefix = props.idPrefix ?? 'ai-defaults';
  const byId = new Map(props.options.filter((o) => o.id).map((o) => [o.id as string, o]));
  const crosses = (funding: string | undefined) =>
    funding !== undefined && props.referenceFunding !== null && funding !== props.referenceFunding;
  const addable = props.options.filter((o) => o.id && !props.value.includes(o.id) && (props.crossFunding || !crosses(o.funding)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= props.value.length) return;
    const next = [...props.value];
    [next[i], next[j]] = [next[j]!, next[i]!];
    props.onChange(next);
  };
  const btn = 'rounded px-1.5 text-sm hover:bg-muted disabled:opacity-40';

  return (
    <div data-testid={`${prefix}-fallbacks-${props.rowKey}`} className="space-y-1">
      <ol className="space-y-1">
        {props.value.map((id, i) => {
          const o = byId.get(id);
          return (
            <li key={id} data-testid={`${prefix}-fallback-${props.rowKey}-${i}`} className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">{i + 1}.</span>
              <span>{o?.displayName ?? t('aiModels.defaults.fallbackUnavailable')}</span>
              {o && crosses(o.funding) && (
                <span
                  data-testid={`${prefix}-fallback-crosses-${props.rowKey}-${i}`}
                  className="rounded bg-amber-100 px-1.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-100"
                >
                  {o.funding === 'platform' ? t('aiModels.defaults.fundingPlatform') : t('aiModels.defaults.fundingOwnKey')}
                </span>
              )}
              <button type="button" className={`${btn} ml-auto`} aria-label={t('aiModels.defaults.moveUp')} disabled={props.disabled || i === 0}
                onClick={() => move(i, -1)} data-testid={`${prefix}-fallback-up-${props.rowKey}-${i}`}>↑</button>
              <button type="button" className={btn} aria-label={t('aiModels.defaults.moveDown')} disabled={props.disabled || i === props.value.length - 1}
                onClick={() => move(i, 1)} data-testid={`${prefix}-fallback-down-${props.rowKey}-${i}`}>↓</button>
              <button type="button" className={btn} aria-label={t('aiModels.defaults.removeFallback')} disabled={props.disabled}
                onClick={() => props.onChange(props.value.filter((x) => x !== id))}
                data-testid={`${prefix}-fallback-remove-${props.rowKey}-${i}`}>×</button>
            </li>
          );
        })}
      </ol>
      {props.value.length < MAX_FALLBACK_OFFERINGS && (
        <select
          value=""
          aria-label={t('aiModels.defaults.addFallback')}
          disabled={props.disabled || addable.length === 0}
          onChange={(e) => { if (e.target.value) props.onChange([...props.value, e.target.value]); }}
          data-testid={`${prefix}-fallback-add-${props.rowKey}`}
          className="h-9 rounded-md border bg-background px-2 text-sm disabled:opacity-60"
        >
          <option value="">{t('aiModels.defaults.addFallback')}</option>
          {addable.map((o) => <option key={o.id as string} value={o.id as string}>{o.displayName}</option>)}
        </select>
      )}
    </div>
  );
}
