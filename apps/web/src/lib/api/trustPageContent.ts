// Typed fetch wrappers for the Trust Center subprocessor and FAQ lists (#8770 W02f), under
// /orgs/:orgId/trust-page. Same idiom as trustPage.ts: the fetcher is a parameter, reads unwrap `{ data }`,
// and MUTATION wrappers return the raw `Response` so the component owns the `runAction` call.

import type { TrustFaqItemInput, TrustSubprocessorInput } from '@breeze/shared';
import { unwrapData, type Fetcher } from './serviceDeliverables';

export type TrustSubprocessorRow = TrustSubprocessorInput;
export type TrustFaqRow = TrustFaqItemInput;

function base(orgId: string): string {
  return `/orgs/${encodeURIComponent(orgId)}/trust-page`;
}

function putInit(body: unknown): RequestInit {
  return { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export async function getTrustSubprocessors(f: Fetcher, orgId: string): Promise<{ subprocessors: TrustSubprocessorRow[]; publicationRevision: number }> {
  return unwrapData(await f(`${base(orgId)}/subprocessors`));
}

export async function getTrustSubprocessorSuggestions(f: Fetcher, orgId: string): Promise<TrustSubprocessorRow[]> {
  const data = await unwrapData<{ suggestions: TrustSubprocessorRow[] }>(await f(`${base(orgId)}/subprocessors/suggestions`));
  return data.suggestions;
}

export function putTrustSubprocessors(f: Fetcher, orgId: string, expectedRevision: number, subprocessors: TrustSubprocessorRow[]): Promise<Response> {
  return f(`${base(orgId)}/subprocessors`, putInit({ expectedRevision, subprocessors }));
}

export async function getTrustFaq(f: Fetcher, orgId: string): Promise<{ items: TrustFaqRow[]; publicationRevision: number }> {
  return unwrapData(await f(`${base(orgId)}/faq`));
}

export function putTrustFaq(f: Fetcher, orgId: string, expectedRevision: number, items: TrustFaqRow[]): Promise<Response> {
  return f(`${base(orgId)}/faq`, putInit({ expectedRevision, items }));
}
