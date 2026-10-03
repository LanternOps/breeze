import { forwardRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { CardSummary, TopologySection } from './cardSections';
import { glyphTileUri, type TopologyGlyph } from './topologyGlyphs';

/** The tile glyph each section's chip carries, so a summary reads in the same visual language as the tiles it replaces. */
const SECTION_GLYPH: Record<TopologySection, TopologyGlyph> = { network: 'switch', servers: 'server', computers: 'workstation', phones: 'phone', printers: 'printer', other: 'device' };

export type SummaryCard = { id: string; title: string; detail: string | null; summary: CardSummary };

/**
 * Zoomed-out card summaries (semantic zoom, 2026-10-03). HTML over the canvas, not canvas text:
 * fixed screen-pixel type stays legible at any zoom, chips and theme tokens come from the design
 * system, and each summary is a real button with an accessible name. The canvas positions each
 * `[data-card-id]` box over the on-screen part of its card every frame the viewport moves; the summary
 * is pinned to that box's top, horizontally centred, so nothing on the map moves when summaries appear.
 */
const CardSummaryOverlay = forwardRef<HTMLDivElement, { cards: SummaryCard[]; visible: boolean; onZoom: (cardId: string) => void }>(function CardSummaryOverlay({ cards, visible, onZoom }, ref) {
  const { t } = useTranslation('topology');
  return <div ref={ref} data-testid="topology-card-summaries" className="pointer-events-none absolute inset-0 overflow-hidden" hidden={!visible}>
    {cards.map((card) => {
      const { summary } = card;
      const agents = summary.agentsOnline + summary.agentsOffline;
      const presence = agents === 0 ? t('grouped.summary.noAgents')
        : [t('grouped.summary.agentsOnline', { count: summary.agentsOnline }),
          summary.agentsOffline ? t('grouped.summary.agentsOffline', { count: summary.agentsOffline }) : null].filter(Boolean).join(' · ');
      const chips = summary.sections.map(({ section, count }) => `${t(/* i18n-dynamic */ `grouped.section.${section}`)} ${count}`).join(', ');
      // The visible text is laid out for the eye; the accessible name says the same thing in reading order.
      const label = [[card.title, card.detail].filter(Boolean).join(', '), chips, presence, t('grouped.summary.zoomIn')].join('. ');
      return <div key={card.id} data-card-id={card.id} data-density="full" className="group absolute left-0 top-0 flex items-start justify-center px-2 pb-2 pt-3">
        <button type="button" data-testid="topology-card-summary" onClick={() => onZoom(card.id)} title={t('grouped.summary.zoomIn')} aria-label={label}
          className="pointer-events-auto shrink-0 origin-top rounded-xl border border-border/80 bg-card px-4 py-3 text-left group-data-[density=large]:px-5 group-data-[density=large]:py-4 shadow-[0_1px_2px_hsl(var(--foreground)/0.06),0_8px_24px_-12px_hsl(var(--foreground)/0.18)] transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary group-data-[density=compact]:px-3 group-data-[density=compact]:py-2 group-data-[density=minimal]:px-2 group-data-[density=minimal]:py-1">
          <span className="block truncate text-[15px] font-semibold leading-5 tracking-[-0.01em] text-foreground group-data-[density=large]:text-xl group-data-[density=large]:leading-7 group-data-[density=minimal]:text-xs">{card.title}</span>
          {card.detail && <span className="block truncate text-xs leading-4 text-muted-foreground group-data-[density=large]:text-sm group-data-[density=large]:leading-5 group-data-[density=minimal]:hidden">{card.detail}</span>}
          <span className="mt-2.5 flex max-w-[22rem] flex-wrap gap-1.5 group-data-[density=large]:mt-3.5 group-data-[density=large]:max-w-[30rem] group-data-[density=large]:gap-2 group-data-[density=compact]:hidden group-data-[density=minimal]:hidden">
            {summary.sections.map(({ section, count }) => <span key={section} className="inline-flex items-center gap-1.5 rounded-md bg-muted px-1.5 py-1 text-xs leading-none group-data-[density=large]:px-2 group-data-[density=large]:py-1.5 group-data-[density=large]:text-sm">
              <img src={glyphTileUri(SECTION_GLYPH[section])} alt="" className="h-3.5 w-3.5 group-data-[density=large]:h-4 group-data-[density=large]:w-4" />
              <span className="text-muted-foreground">{t(/* i18n-dynamic */ `grouped.sectionShort.${section}`)}</span>
              <span className="font-semibold tabular-nums text-foreground">{count}</span>
            </span>)}
          </span>
          <span className="mt-2 block truncate text-xs leading-4 text-muted-foreground group-data-[density=large]:mt-3 group-data-[density=large]:text-sm group-data-[density=minimal]:hidden">
            {presence}
          </span>
        </button>
      </div>;
    })}
  </div>;
});
export default CardSummaryOverlay;
