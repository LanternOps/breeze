import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { parseTermsSections, textReadMinutes as readMinutes } from '@breeze/shared';
import type { InvoiceDocumentModel } from '@breeze/shared/documents';
import { DocumentNotes } from './DocumentNotes';

/**
 * Open state for a collapsible legal section, keyed by its anchor id. `#<id>`
 * opens it (on load, on hashchange, and on a re-click of a link to a hash that
 * is already set, which fires no hashchange), and it is force-expanded while
 * printing, then restored. Open state is only touched after mount so SSR and
 * first client paint agree.
 */
export function useDeepLinkedDisclosure(id: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  const wasOpenRef = useRef(false);
  const printingRef = useRef(false);
  const openRef = useRef(false);
  openRef.current = open;

  useEffect(() => {
    const syncHash = () => {
      if (window.location.hash === `#${id}`) setOpen(true);
    };
    // flushSync: the browser snapshots the page for print as soon as
    // beforeprint returns, and React would otherwise commit this update on a
    // later task — printing every agreement collapsed.
    const beforePrint = () => {
      if (printingRef.current) return; // duplicate beforeprint must not overwrite the saved state
      printingRef.current = true;
      wasOpenRef.current = openRef.current;
      flushSync(() => setOpen(true));
    };
    const afterPrint = () => {
      printingRef.current = false;
      flushSync(() => setOpen(wasOpenRef.current));
    };
    const onLinkClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.(`a[href="#${id}"]`);
      if (a) setOpen(true);
    };
    syncHash();
    window.addEventListener('hashchange', syncHash);
    window.addEventListener('beforeprint', beforePrint);
    window.addEventListener('afterprint', afterPrint);
    document.addEventListener('click', onLinkClick);
    return () => {
      document.removeEventListener('click', onLinkClick);
      window.removeEventListener('hashchange', syncHash);
      window.removeEventListener('beforeprint', beforePrint);
      window.removeEventListener('afterprint', afterPrint);
    };
  }, [id]);

  return [open, setOpen];
}

/** "N sections · ~M min read" (or just the read time) for free-text terms. */
export function termsMeta(text: string): string {
  const { sectionCount } = parseTermsSections(text);
  const minutes = readMinutes(text);
  return sectionCount > 0
    ? `${sectionCount} section${sectionCount === 1 ? '' : 's'} · ~${minutes} min read`
    : `~${minutes} min read`;
}

/** Free-text terms as readable sections: detected headings become <h4>s (with
 *  a contents list at 4+ sections); text with no headings stays pre-wrapped. */
export function TermsBody({ text, label = 'Terms & Conditions' }: { text: string; label?: string }): ReactElement {
  const { blocks, sectionCount } = useMemo(() => parseTermsSections(text), [text]);
  if (sectionCount === 0) {
    return <p className="max-w-prose whitespace-pre-wrap text-pretty text-xs leading-relaxed text-muted-foreground">{text}</p>;
  }
  return (
    <div className="max-w-prose space-y-2 text-xs leading-relaxed text-muted-foreground">
      {sectionCount >= 4 && (
        <nav aria-label={`${label} contents`} className="space-y-1 pb-2">
          {blocks.map((b) =>
            b.kind === 'heading' ? (
              <a key={b.id} href={`#${b.id}`} className="block underline underline-offset-2">
                {b.text}
              </a>
            ) : null,
          )}
        </nav>
      )}
      {blocks.map((b, i) =>
        b.kind === 'heading' ? (
          <h4 key={b.id} id={b.id} className="pt-2 text-xs font-semibold text-foreground">
            {b.text}
          </h4>
        ) : (
          <p key={i} className="text-pretty">{b.text}</p>
        ),
      )}
    </div>
  );
}

/**
 * Long-form legal text (Terms & Conditions), collapsed by default so it never
 * sits between the price and the pay/sign action. Native <details> that opens
 * on `#terms` and expands while printing (useDeepLinkedDisclosure). Invoices
 * use this standalone; a quote groups its T&C with its contract blocks in
 * DocumentAgreements instead.
 */
export function DocumentTermsCollapsible({
  label = 'Terms & Conditions',
  text,
  meta,
  testId,
  id = 'terms',
}: {
  label?: string;
  text: string;
  /** Pre-localised summary; falls back to the English read-time line. */
  meta?: string;
  testId?: string;
  id?: string;
}): ReactElement {
  const [open, setOpen] = useDeepLinkedDisclosure(id);
  return (
    <details
      id={id}
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="scroll-mt-4 border-t pt-6"
      data-testid={testId}
    >
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {`${label} · ${meta ?? termsMeta(text)}`}
      </summary>
      <div className="mt-3">
        <TermsBody text={text} label={label} />
      </div>
    </details>
  );
}

/** The invoice's terms: the short line (when set) and the collapsed full terms. */
export function DocumentTerms({ terms, shortLabel }: { terms: InvoiceDocumentModel['terms']; shortLabel: string }): ReactElement | null {
  if (!terms.short && !terms.full) return null;
  return (
    <>
      {terms.short && <DocumentNotes label={shortLabel} text={terms.short} testId="document-terms-short" />}
      {terms.full && (
        <DocumentTermsCollapsible label={terms.full.label} text={terms.full.text} meta={terms.full.meta || undefined} testId="document-terms" />
      )}
    </>
  );
}
