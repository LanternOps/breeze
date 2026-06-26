import { fetchWithAuth } from '../stores/auth';
import { runAction } from './runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from './authScope';

export interface CannedResponse {
  id: string;
  name: string;
  body: string;
  category: string | null;
  sortOrder: number;
  isActive: boolean;
}

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

/** List the partner's active canned responses (ordered server-side). Read path —
 *  no runAction (no mutation), caller handles the thrown error. */
export async function listCannedResponses(): Promise<CannedResponse[]> {
  const res = await fetchWithAuth('/ticket-response-templates');
  if (!res.ok) throw new Error('Failed to load canned responses');
  const body = (await res.json()) as { data?: CannedResponse[] };
  return body.data ?? []; // tolerate a malformed payload — never hand back undefined

}

export function createCannedResponse(input: {
  name: string;
  body: string;
  category?: string | null;
}): Promise<CannedResponse> {
  return runAction<CannedResponse>({
    request: () => fetchWithAuth('/ticket-response-templates', { method: 'POST', body: JSON.stringify(input) }),
    successMessage: 'Canned response created',
    errorFallback: 'Failed to create canned response',
    parseSuccess: (d) => (d as { data: CannedResponse }).data,
    onUnauthorized: UNAUTHORIZED,
  });
}

export function updateCannedResponse(
  id: string,
  patch: Partial<Pick<CannedResponse, 'name' | 'body' | 'category' | 'sortOrder' | 'isActive'>>,
): Promise<CannedResponse> {
  return runAction<CannedResponse>({
    request: () => fetchWithAuth(`/ticket-response-templates/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    successMessage: 'Canned response saved',
    errorFallback: 'Failed to save canned response',
    parseSuccess: (d) => (d as { data: CannedResponse }).data,
    onUnauthorized: UNAUTHORIZED,
  });
}

export function deleteCannedResponse(id: string): Promise<void> {
  return runAction<void>({
    request: () => fetchWithAuth(`/ticket-response-templates/${id}`, { method: 'DELETE' }),
    successMessage: 'Canned response deleted',
    errorFallback: 'Failed to delete canned response',
    parseSuccess: () => undefined,
    onUnauthorized: UNAUTHORIZED,
  });
}
