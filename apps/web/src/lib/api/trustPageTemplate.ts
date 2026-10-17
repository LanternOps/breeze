// Typed fetch wrappers for the partner-wide Trust Center template (#8770 W02g), mounted at
// /trust-page-template. Same idiom as trustPage.ts: the fetcher is a parameter, reads unwrap `{ data }`,
// and the mutation returns the raw `Response` so the component owns the `runAction` call.

import type { TrustSettingValues, TrustTemplateSettings, TrustTemplateUpdateInput } from '@breeze/shared';
import type { TrustFrameworkOption } from './trustPage';
import { unwrapData, type Fetcher } from './serviceDeliverables';

export interface TrustTemplateState {
  /** The partner's stored template; null = none yet (every setting is the Breeze default). */
  template: TrustTemplateSettings | null;
  /** 0 = no template row yet; sent back as `expectedRevision`. */
  revision: number;
  /** The built-in Breeze defaults a blank template field falls through to. */
  defaults: TrustSettingValues;
  frameworkOptions: TrustFrameworkOption[];
  /** False for partner users without access to every organization: the form is read-only. */
  canManage: boolean;
}

const PATH = '/trust-page-template';

export async function getTrustPageTemplate(f: Fetcher): Promise<TrustTemplateState> {
  return unwrapData<TrustTemplateState>(await f(PATH));
}

export function updateTrustPageTemplate(f: Fetcher, body: TrustTemplateUpdateInput): Promise<Response> {
  return f(PATH, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
