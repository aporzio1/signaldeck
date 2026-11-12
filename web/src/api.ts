export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text };
  }
  if (!response.ok) {
    throw new ApiError(response.status, body?.error || `Request failed (${response.status})`);
  }
  return body as T;
}

export const api = {
  get: <T = any>(path: string) => request<T>(path),
  post: <T = any>(path: string, body?: any) => request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  put: <T = any>(path: string, body?: any) => request<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  del: <T = any>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export type AuthStatus = { setupRequired: boolean; authenticated: boolean };

export const authApi = {
  status: () => request<AuthStatus>('/auth/status'),
  setup: (password: string) => request('/auth/setup', { method: 'POST', body: JSON.stringify({ password }) }),
  login: (password: string) => request('/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  changePassword: (current: string, next: string) =>
    request('/auth/password', { method: 'POST', body: JSON.stringify({ current, next }) }),
  tokens: () => request<{ tokens: any[] }>('/auth/tokens'),
  createToken: (name: string) => request<{ token: string; id: string; name: string }>('/auth/tokens', {
    method: 'POST',
    body: JSON.stringify({ name }),
  }),
  revokeToken: (id: string) => request(`/auth/tokens/${id}`, { method: 'DELETE' }),
};
