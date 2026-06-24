const API_BASE = '/api';
const AUTH_KEY = 'qr_auth_token';

export function getToken() {
  return localStorage.getItem(AUTH_KEY);
}

export function setToken(token) {
  localStorage.setItem(AUTH_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(AUTH_KEY);
}

function authHeaders(extra = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...extra };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return headers;
}

function buildUrl(path, params = {}) {
  const url = new URL(API_BASE + path, window.location.origin);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  return url;
}

async function parseResponse(res, fallbackMsg) {
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Resposta inválida do servidor (status ${res.status}).`);
  }
  if (!res.ok) throw new Error(data.error || fallbackMsg);
  return data;
}

export async function apiGet(path, params = {}) {
  const url = buildUrl(path, params);
  const res = await fetch(url, { headers: authHeaders() });
  return parseResponse(res, 'Erro na requisição');
}

export async function apiDelete(path, params = {}) {
  const url = buildUrl(path, params);
  const res = await fetch(url, { method: 'DELETE', headers: authHeaders() });
  return parseResponse(res, 'Erro ao excluir');
}

export async function apiPost(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  return parseResponse(res, 'Erro na requisição');
}

// Auth-specific calls go straight to /api/auth (not through the apiGet helpers
// above, mirroring the original page, although the behaviour is equivalent).
export async function authMe() {
  const token = getToken();
  if (!token) return { loggedIn: false };
  const res = await fetch(`${API_BASE}/auth?action=me`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  return parseResponse(res, 'Erro ao verificar sessão');
}

export async function authSubmit(mode, username, password) {
  const res = await fetch(`${API_BASE}/auth?action=${mode}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return parseResponse(res, 'Erro ao autenticar');
}
