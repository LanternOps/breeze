/**
 * Portal API Client
 * Handles all API requests for the customer portal
 */

import { navigateTo } from './navigation';

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

function buildQueryString(query?: Record<string, string | number | undefined>): string {
  if (!query) {
    return '';
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }

  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
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

export function buildServerForwardHeaders(request: Request): Headers {
  const headers = new Headers();
  const cookie = request.headers.get('cookie');
  const host = request.headers.get('host');
  const forwardedHost = request.headers.get('x-forwarded-host');
  const forwardedProto = request.headers.get('x-forwarded-proto');

  if (cookie) headers.set('cookie', cookie);
  if (host) headers.set('host', host);
  if (forwardedHost) headers.set('x-forwarded-host', forwardedHost);
  if (forwardedProto) headers.set('x-forwarded-proto', forwardedProto);

  return headers;
}

export interface ApiRequestConfig {
  headers?: HeadersInit;
  redirectOnUnauthorized?: boolean;
}

export interface ApiResponse<T> {
  data?: T;
  error?: string;
  statusCode?: number;
  headers?: Headers;
}

function clearAuth(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('portal-auth');
}

export async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {},
  config: ApiRequestConfig = {}
): Promise<ApiResponse<T>> {
  const url = buildPortalApiUrl(endpoint);
  const method = (options.method ?? 'GET').toUpperCase();

  const headers = new Headers(config.headers);
  const optionHeaders = new Headers(options.headers);
  optionHeaders.forEach((value, key) => headers.set(key, value));

  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const csrfToken = readCookie(CSRF_COOKIE_NAME);
    if (csrfToken) {
      headers.set(CSRF_HEADER_NAME, csrfToken);
    }
  }

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      credentials: 'include'
    });

    if (response.status === 401) {
      clearAuth();
      if (config.redirectOnUnauthorized !== false && typeof window !== 'undefined') {
        void navigateTo('/login', { replace: true });
      }
      return {
        error: 'Session expired',
        statusCode: response.status,
        headers: response.headers
      };
    }

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        error: body?.error || 'Request failed',
        statusCode: response.status,
        headers: response.headers
      };
    }

    return {
      data: body as T,
      statusCode: response.status,
      headers: response.headers
    };
  } catch {
    return { error: 'Network error' };
  }
}

export async function apiGet<T>(
  endpoint: string,
  config: ApiRequestConfig = {}
): Promise<ApiResponse<T>> {
  return apiRequest<T>(endpoint, { method: 'GET' }, config);
}

export async function apiPost<T>(
  endpoint: string,
  body?: unknown,
  config: ApiRequestConfig = {}
): Promise<ApiResponse<T>> {
  return apiRequest<T>(endpoint, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined
  }, config);
}

export async function apiPut<T>(
  endpoint: string,
  body?: unknown,
  config: ApiRequestConfig = {}
): Promise<ApiResponse<T>> {
  return apiRequest<T>(endpoint, {
    method: 'PUT',
    body: body ? JSON.stringify(body) : undefined
  }, config);
}

export async function apiPatch<T>(
  endpoint: string,
  body?: unknown,
  config: ApiRequestConfig = {}
): Promise<ApiResponse<T>> {
  return apiRequest<T>(endpoint, {
    method: 'PATCH',
    body: body ? JSON.stringify(body) : undefined
  }, config);
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
}

export interface PaginatedResult<T> extends ApiResponse<T[]> {
  pagination?: Pagination;
}

export interface Device {
  id: string;
  hostname: string;
  displayName: string | null;
  osType: string | null;
  osVersion: string | null;
  status: 'online' | 'offline' | 'warning';
  lastSeenAt: string | null;
}

export type TicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface TicketSummary {
  id: string;
  ticketNumber: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  createdAt: string;
  updatedAt: string;
}

export interface TicketComment {
  id: string;
  authorName: string;
  content: string;
  createdAt: string;
}

export interface TicketDetails extends TicketSummary {
  description: string;
  comments: TicketComment[];
}

export interface Asset {
  id: string;
  hostname: string;
  displayName: string | null;
  osType: string | null;
  status: 'online' | 'offline' | 'warning';
  lastSeenAt: string | null;
}

export interface Profile {
  id: string;
  orgId: string;
  orgName: string | null;
  organizationId: string;
  organizationName: string;
  email: string;
  name: string | null;
  receiveNotifications: boolean;
  status: string;
}

export interface BrandingConfig {
  id?: string;
  orgId?: string;
  name?: string;
  logoUrl?: string | null;
  faviconUrl?: string | null;
  primaryColor?: string | null;
  secondaryColor?: string | null;
  accentColor?: string | null;
  customDomain?: string | null;
  welcomeMessage?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
  footerText?: string | null;
  customCss?: string | null;
  enableTickets?: boolean;
  enableAssetCheckout?: boolean;
  enableSelfService?: boolean;
  enablePasswordReset?: boolean;
}

export interface ListParams {
  page?: number;
  limit?: number;
}

function mapPaginatedData<T>(
  response: ApiResponse<{ data: T[]; pagination?: Pagination }>
): PaginatedResult<T> {
  if (!response.data) {
    return {
      error: response.error,
      statusCode: response.statusCode,
      headers: response.headers
    };
  }

  return {
    data: response.data.data,
    pagination: response.data.pagination,
    statusCode: response.statusCode,
    headers: response.headers
  };
}

export const portalApi = {
  getDevices: async (
    params: ListParams = {},
    config: ApiRequestConfig = {}
  ): Promise<PaginatedResult<Device>> => {
    const query = buildQueryString({ page: params.page ?? 1, limit: params.limit ?? 50 });
    const response = await apiGet<{ data: Device[]; pagination: Pagination }>(
      `/portal/devices${query}`,
      config
    );
    return mapPaginatedData(response);
  },

  getTickets: async (
    params: ListParams = {},
    config: ApiRequestConfig = {}
  ): Promise<PaginatedResult<TicketSummary>> => {
    const query = buildQueryString({ page: params.page ?? 1, limit: params.limit ?? 50 });
    const response = await apiGet<{ data: TicketSummary[]; pagination: Pagination }>(
      `/portal/tickets${query}`,
      config
    );
    return mapPaginatedData(response);
  },

  getTicket: async (
    id: string,
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<TicketDetails>> => {
    const response = await apiGet<{ ticket: TicketDetails }>(`/portal/tickets/${id}`, config);
    if (!response.data) {
      return {
        error: response.error,
        statusCode: response.statusCode,
        headers: response.headers
      };
    }

    return {
      data: response.data.ticket,
      statusCode: response.statusCode,
      headers: response.headers
    };
  },

  createTicket: async (
    data: { subject: string; description: string; priority: TicketPriority },
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<TicketSummary & { description: string }>> => {
    const response = await apiPost<{ ticket: TicketSummary & { description: string } }>(
      '/portal/tickets',
      data,
      config
    );
    if (!response.data) {
      return {
        error: response.error,
        statusCode: response.statusCode,
        headers: response.headers
      };
    }

    return {
      data: response.data.ticket,
      statusCode: response.statusCode,
      headers: response.headers
    };
  },

  getAssets: async (
    params: ListParams = {},
    config: ApiRequestConfig = {}
  ): Promise<PaginatedResult<Asset>> => {
    const query = buildQueryString({ page: params.page ?? 1, limit: params.limit ?? 50 });
    const response = await apiGet<{ data: Asset[]; pagination: Pagination }>(
      `/portal/assets${query}`,
      config
    );
    return mapPaginatedData(response);
  },

  getProfile: async (config: ApiRequestConfig = {}): Promise<ApiResponse<Profile>> => {
    const response = await apiGet<{ user: Profile }>('/portal/profile', config);
    if (!response.data) {
      return {
        error: response.error,
        statusCode: response.statusCode,
        headers: response.headers
      };
    }

    return {
      data: response.data.user,
      statusCode: response.statusCode,
      headers: response.headers
    };
  },

  updateProfile: async (
    data: { name?: string; receiveNotifications?: boolean; password?: string; email?: string },
    config: ApiRequestConfig = {}
  ): Promise<ApiResponse<Profile>> => {
    const response = await apiPatch<{ user: Profile }>('/portal/profile', data, config);
    if (!response.data) {
      return {
        error: response.error,
        statusCode: response.statusCode,
        headers: response.headers
      };
    }

    return {
      data: response.data.user,
      statusCode: response.statusCode,
      headers: response.headers
    };
  },

  changePassword: (
    data: { currentPassword: string; newPassword: string },
    config: ApiRequestConfig = {}
  ) => apiPost<{ success: boolean; message?: string }>('/portal/profile/password', data, config),

  getBranding: async (config: ApiRequestConfig = {}): Promise<ApiResponse<BrandingConfig>> => {
    const response = await apiGet<{ branding: BrandingConfig }>('/portal/branding', config);
    if (!response.data) {
      return {
        error: response.error,
        statusCode: response.statusCode,
        headers: response.headers
      };
    }

    return {
      data: response.data.branding,
      statusCode: response.statusCode,
      headers: response.headers
    };
  }
};
