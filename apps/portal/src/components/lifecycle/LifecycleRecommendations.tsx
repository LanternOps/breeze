import { capNames, type HardwareLifecycleSummary } from '@breeze/shared';

/**
 * The closing sections of the Hardware Lifecycle report: the plain-language
 * recommendations, then a short reminder of the other equipment we manage
 * that does not carry a replacement date of its own (printers, switches,
 * and similar). Each half renders independently and is silent when empty.
 */
export function LifecycleRecommendations({
  summary,
}: {
  summary: Pick<HardwareLifecycleSummary, 'recommendations' | 'other'>;
}) {
  const recommendations = summary.recommendations ?? [];
  const other = summary.other ?? [];

  return (
    <>
      {recommendations.length > 0 && (
        <section data-testid="lifecycle-recommendations">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-foreground">
            {recommendations.map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ul>
        </section>
      )}
      {other.length > 0 && (
        <div data-testid="lifecycle-other-equipment" className="mt-4 text-sm text-muted-foreground">
          Other equipment we manage: {capNames(
            other.map((o) => [o.manufacturer, o.model].filter(Boolean).join(' ') || o.name),
            8,
          )}
        </div>
      )}
    </>
  );
}
