/**
 * Test-only helpers shared by this package's snapshot test and the host apps'
 * DOM-parity tests (`@breeze/document-ui/testing`). Never imported by product code.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReactElement } from 'react';
import type { InvoiceFixtureName, QuoteFixtureName } from '@breeze/shared/documents';
import type { DocumentHostComponents } from '../hostComponents';

/** Stand-in host components: the asset identity is the whole output, so hosts
 *  with different fetch strategies still produce identical normalized markup. */
export const STAND_IN_COMPONENTS: DocumentHostComponents = {
  Image: ({ asset, alt, className, width }): ReactElement => (
    <img data-asset={`${asset.kind}:${asset.id}`} alt={alt} className={className} width={width} />
  ),
  AgreementFile: ({ asset, title }): ReactElement => (
    <a data-asset={`${asset.kind}:${asset.id}`}>{title}</a>
  ),
};

export function quoteSnapshotPath(name: QuoteFixtureName): string {
  return join(dirname(fileURLToPath(import.meta.url)), `quote-${name}.snap.html`);
}

export function invoiceSnapshotPath(name: InvoiceFixtureName): string {
  return join(dirname(fileURLToPath(import.meta.url)), `invoice-${name}.snap.html`);
}

// React `useId` output (`:r1:` in 18, `_r_1_` / `«r1»` in 19.x): never stable across hosts.
const USE_ID = /^(:r[0-9a-z]+:|_r_[0-9a-z]+_|«r[0-9a-z]+»)$/;

function serialize(node: Node, depth: number, out: string[]): void {
  const pad = '  '.repeat(depth);
  if (node.nodeType === 3) {
    const text = node.textContent ?? '';
    if (text.trim() === '') return;
    out.push(`${pad}${JSON.stringify(text)}`);
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as Element;
  const attrs = Array.from(el.attributes)
    .filter((a) => !((a.name === 'id' || a.name === 'for' || a.name.startsWith('aria-')) && USE_ID.test(a.value)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => `${a.name}="${a.value}"`);
  out.push(`${pad}<${el.tagName.toLowerCase()}${attrs.length ? ' ' + attrs.join(' ') : ''}>`);
  if (!el.hasAttribute('data-slot')) {
    for (const child of Array.from(el.childNodes)) serialize(child, depth + 1, out);
  }
  out.push(`${pad}</${el.tagName.toLowerCase()}>`);
}

/** `[data-document-root]` as stable, diff-friendly text: one node per line,
 *  attributes sorted, `[data-slot]` contents dropped (host chrome), `useId` values stripped. */
export function normalizeDocumentRoot(container: ParentNode): string {
  const root = container.querySelector('[data-document-root]');
  if (!root) throw new Error('normalizeDocumentRoot: no [data-document-root] in container');
  const out: string[] = [];
  serialize(root, 0, out);
  return out.join('\n') + '\n';
}
