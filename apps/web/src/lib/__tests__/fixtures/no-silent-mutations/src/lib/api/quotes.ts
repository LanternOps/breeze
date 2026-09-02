import { fetchWithAuth } from '../../stores/auth';

export function getQuote(id: string): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}`);
}

export function sendQuote(id: string): Promise<Response> {
  return fetchWithAuth(`/quotes/${id}/send`, { method: 'POST' });
}
