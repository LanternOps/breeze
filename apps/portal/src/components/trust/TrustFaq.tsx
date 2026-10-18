// Owner: W02f (FAQ). Answers are sanitized server-side on save and again on every build, so
// rendering them as HTML carries the same contract as `introHtml`. Copy via defineTrustCopy; no inline style=.
import { CONTENT_COPY } from './contentCopy';
import { pickTrustCopy, useTrustLocale, type TrustSectionViewProps } from './trustCopy';

export default function TrustFaq({ payload }: TrustSectionViewProps) {
  const copy = pickTrustCopy(CONTENT_COPY, useTrustLocale());
  if (payload.faq.length === 0) return null;
  return (
    <section data-testid="trust-faq">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{copy.faqHeading}</h2>
      <div className="divide-y rounded-lg border bg-card">
        {payload.faq.map((item, i) => (
          <details key={`${item.question}-${i}`} className="px-4 py-3 text-sm" data-testid="trust-faq-item">
            <summary className="cursor-pointer font-medium">{item.question}</summary>
            <div className="quote-rich-text prose prose-sm mt-2 max-w-none" dangerouslySetInnerHTML={{ __html: item.answerHtml }} />
          </details>
        ))}
      </div>
    </section>
  );
}
