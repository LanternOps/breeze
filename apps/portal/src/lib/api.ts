/**
 * Portal API Client
 * Handles all API requests for the customer portal
 */

const API_BASE = import.meta.env.PUBLIC_API_URL || 'http://localhost:3001';
const CSRF_HEADER_NAME = 'x-breeze-csrf';
const CSRF_COOKIE_NAME = 'breeze_portal_csrf_token';

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const target = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(target)) {
      const value = trimmed.slice(target.length);
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }

  return null;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

function resolveApiBase(): string {
  if (!API_BASE) {
    return '';
  }

  if (typeof window === 'undefined') {
    return API_BASE;
  }

  try {
    const parsed = new URL(API_BASE, window.location.origin);
    const windowHostname = window.location.hostname;

    // Keep localhost development same-site by default, even if PUBLIC_API_URL
    // was set to a different hostname/IP.
    if (isLoopbackHostname(windowHostname) && parsed.hostname !== windowHostname) {
      parsed.hostname = windowHostname;
      return parsed.origin;
    }

    if (isLoopbackHostname(parsed.hostname) && parsed.hostname !== window.location.hostname) {
      parsed.hostname = window.location.hostname;
    }
    return parsed.origin;
  } catch {
    return API_BASE;
  }
}

export function buildPortalApiUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const cleanPath = normalizedPath === '/api'
    ? ''
    : normalizedPath.startsWith('/api/')
      ? normalizedPath.slice(4)
      : normalizedPath;

  const apiBase = resolveApiBase();
  return `${apiBase}/api/v1${cleanPath}`;
}

export interface ApiError {
  error: string;
  statusCode: number;
}

export interface ApiResponse<T> {
  data?: T;
  error?: string;
}

/**
 * Clear auth from storage (logout)
 */
function clearAuth(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('portal-auth');
}

/**
 * Make an authenticated API request with automatic token refresh
 */
export async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const url = buildPortalApiUrl(endpoint);
  const method = (options.method ?? 'GET').toUpperCase();

  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrfToken = readCookie(CSRF_COOKIE_NAME);
    if (csrfToken) {
      headers.set(CSRF_HEADER_NAME, csrfToken);
    }
  }

  try {
    const response = await fetch(url, { ...options, headers, credentials: 'include' });

    // Portal auth uses in-memory sessions; 401 means session expired/invalid.
    if (response.status === 401) {
      clearAuth();
      window.location.href = '/login';
      return { error: 'Session expired' };
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return { error: data.error || 'Request failed' };
    }

    return { data };
  } catch (error) {
    return { error: 'Network error' };
  }
}

/**
 * GET request helper
 */
export async function apiGet<T>(endpoint: string): Promise<ApiResponse<T>> {
  return apiRequest<T>(endpoint, { method: 'GET' });
}

/**
 * POST request helper
 */
export async function apiPost<T>(
  endpoint: string,
  body?: unknown
): Promise<ApiResponse<T>> {
  return apiRequest<T>(endpoint, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined
  });
}

/**
 * PUT request helper
 */
export async function apiPut<T>(
  endpoint: string,
  body?: unknown
): Promise<ApiResponse<T>> {
  return apiRequest<T>(endpoint, {
    method: 'PUT',
    body: body ? JSON.stringify(body) : undefined
  });
}

/**
 * DELETE request helper
 */
export async function apiDelete<T>(endpoint: string): Promise<ApiResponse<T>> {
  return apiRequest<T>(endpoint, { method: 'DELETE' });
}

// Portal-specific API endpoints

export interface Device {
  id: string;
  name: string;
  hostname: string;
  status: 'online' | 'offline' | 'warning';
  lastSeen: string;
  osType: string;
  osVersion: string;
}

export interface Ticket {
  id: string;
  title: string;
  description: string;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  priority: 'low' | 'medium' | 'high' | 'critical';
  createdAt: string;
  updatedAt: string;
}

export interface Asset {
  id: string;
  name: string;
  type: string;
  serialNumber?: string;
  assignedTo?: string;
  location?: string;
}

export const portalApi = {
  // Devices
  getDevices: () => apiGet<Device[]>('/portal/devices'),

  // Tickets
  getTickets: () => apiGet<Ticket[]>('/portal/tickets'),
  getTicket: (id: string) => apiGet<Ticket>(`/portal/tickets/${id}`),
  createTicket: (data: Omit<Ticket, 'id' | 'createdAt' | 'updatedAt'>) =>
    apiPost<Ticket>('/portal/tickets', data),

  // Assets
  getAssets: () => apiGet<Asset[]>('/portal/assets'),

  // Profile
  getProfile: () => apiGet<{ id: string; name: string; email: string }>('/portal/profile'),
  updateProfile: (data: { name?: string; email?: string }) =>
    apiPut('/portal/profile', data),
  changePassword: (data: { currentPassword: string; newPassword: string }) =>
    apiPost('/portal/profile/password', data)
};
