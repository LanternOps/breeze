// A quote's agreements: its contract blocks (agreements pinned from contract
// templates) and its Terms & Conditions. They render after the price and the
// sign panel, collapsed, instead of in the body's block order, where a long
// agreement pushed the totals and the sign button to the bottom (#7040). The
// PDF and the staff Preview use the same order.
import { htmlReadMinutes } from '@breeze/shared';
import type { PublicApiPath, QuoteBlock, QuoteContractBlockContent } from '@/lib/api';
import { DocumentAgreements, TermsBody, termsMeta, type DocumentAgreement } from './documentShell';

interface ContractSummary {
  id: string;
  anchor: string;
  title: string;
  templateName: string;
  versionNumber: number;
  sourceType: 'authored' | 'uploaded';
  renderedHtml: string | null;
  fileUrl: string | null;
}

// Typed as QuoteContractBlockContent (never `authoring`) for documentation, but
// narrowed field by field: a TS type doesn't validate the JSON on the wire.
function contractSummaries(blocks: QuoteBlock[]): ContractSummary[] {
  return [...blocks]
    .filter((b) => b.blockType === 'contract')
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((b) => {
      const c = (b.content ?? {}) as unknown as Partial<QuoteContractBlockContent>;
      const label = typeof c.label === 'string' ? c.label.trim() : '';
      const templateName = typeof c.templateName === 'string' ? c.templateName.trim() : '';
      return {
        id: b.id,
        anchor: `agreement-${b.id}`,
        title: label || templateName || 'Agreement',
        templateName: templateName || label || 'Agreement',
        versionNumber: Number(c.versionNumber ?? 0),
        sourceType: c.sourceType === 'uploaded' ? 'uploaded' : 'authored',
        renderedHtml: typeof c.renderedHtml === 'string' ? c.renderedHtml : null,
        fileUrl: typeof c.fileUrl === 'string' ? c.fileUrl : null,
      };
    });
}

/** The agreements the signature checkbox names, each linking to its row. */
export function quoteAgreementLinks(blocks: QuoteBlock[], termsAndConditions?: string | null): { label: string; href: string }[] {
  const links = contractSummaries(blocks).map((c) => ({ label: c.title, href: `#${c.anchor}` }));
  if (termsAndConditions?.trim()) links.push({ label: 'Terms & Conditions', href: '#terms' });
  return links;
}

function ContractBody({ contract, buildUrl }: { contract: ContractSummary; buildUrl: (path: string) => PublicApiPath }) {
  const footer = <p className="text-xs text-muted-foreground">{contract.templateName} — v{contract.versionNumber}</p>;
  if (contract.sourceType === 'authored') {
    return (
      <div className="space-y-3">
        {contract.renderedHtml ? (
          // Server-substituted HTML from an authored contract template: the same
          // sanitizer output + HTML-escaped substitution path as rich_text blocks
          // (see quoteBlocks), safe to render as-is.
          <div
            className="quote-rich-text max-w-prose text-sm leading-relaxed text-foreground"
            dangerouslySetInnerHTML={{ __html: contract.renderedHtml }}
          />
        ) : (
          <div className="rounded-lg border bg-muted/50 p-4 text-sm text-muted-foreground">Agreement content unavailable</div>
        )}
        {footer}
      </div>
    );
  }
  if (!contract.fileUrl) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border bg-muted/50 p-4 text-sm text-muted-foreground">Agreement file unavailable</div>
        {footer}
      </div>
    );
  }
  const url = buildUrl(contract.fileUrl);
  return (
    <div className="space-y-3">
      <iframe src={url} title={contract.templateName} className="h-[32rem] w-full rounded-lg border" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          data-testid="contract-block-download"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
        >
          Download agreement
        </a>
        {footer}
      </div>
    </div>
  );
}

export function QuoteAgreements({
  blocks,
  termsAndConditions,
  buildUrl,
  testIdPrefix,
}: {
  blocks: QuoteBlock[];
  termsAndConditions?: string | null;
  /** Resolves a contract block's server-returned `fileUrl` route (see QuoteBlocks). */
  buildUrl: (path: string) => PublicApiPath;
  /** `public-quote` / `quote`: keeps the existing `*-terms-conditions` test ids. */
  testIdPrefix: string;
}) {
  const items: DocumentAgreement[] = contractSummaries(blocks).map((contract) => ({
    id: contract.anchor,
    title: contract.title,
    meta:
      contract.sourceType === 'uploaded'
        ? 'PDF document'
        : contract.renderedHtml
          ? `~${htmlReadMinutes(contract.renderedHtml)} min read`
          : 'Unavailable',
    testId: 'contract-block',
    lazy: contract.sourceType === 'uploaded',
    body: <ContractBody contract={contract} buildUrl={buildUrl} />,
  }));
  const terms = termsAndConditions?.trim() ? termsAndConditions : null;
  if (terms) {
    items.push({
      id: 'terms',
      title: 'Terms & Conditions',
      meta: termsMeta(terms),
      testId: `${testIdPrefix}-terms-conditions`,
      body: <TermsBody text={terms} />,
    });
  }
  return <DocumentAgreements items={items} testId={`${testIdPrefix}-agreements`} />;
}
