import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response && error.response.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/';
    }
    return Promise.reject(error);
  }
);

export async function login(password) {
  const { data } = await api.post('/login', { password });
  localStorage.setItem('token', data.token);
  return data;
}

export async function fetchStatus() {
  const { data } = await api.get('/status');
  return data;
}

export async function fetchTrades(params = {}) {
  const { data } = await api.get('/trades', { params });
  return data;
}

export async function fetchLogs() {
  const { data } = await api.get('/logs');
  return data;
}

export async function searchLogs(query) {
  const { data } = await api.get('/logs/search', { params: { q: query } });
  return data;
}

export async function fetchLogErrors() {
  const { data } = await api.get('/logs/errors');
  return data;
}

export async function claimTrade(tradeId) {
  const { data } = await api.post(`/claim/${tradeId}`);
  return data;
}

export async function claimAll() {
  const { data } = await api.post('/claim-all');
  return data;
}

export async function claimDirect(conditionId, outcomeIndex) {
  const { data } = await api.post('/claim-direct', { conditionId, outcomeIndex });
  return data;
}

export async function updateTradeResult(tradeId, action) {
  const { data } = await api.post(`/trades/${tradeId}/update-result`, { action });
  return data;
}

export async function toggleBookmark(tradeId, bookmarked) {
  const { data } = await api.post(`/trades/${tradeId}/bookmark`, { bookmarked });
  return data;
}

export async function fetchPositions() {
  const { data } = await api.get('/positions');
  return data;
}

export async function fetchCandles() {
  const { data } = await api.get('/candles');
  return data;
}

export async function fetchSettings() {
  const { data } = await api.get('/settings');
  return data;
}

export async function updateSetting(key, value) {
  const { data } = await api.post(`/settings/${key}`, { value });
  return data;
}

export async function togglePause(password) {
  const { data } = await api.post('/pause', { password });
  return data;
}

export async function fetchV2Positions() {
  const { data } = await api.get('/v2/positions');
  return data;
}

export async function fetchV2Lanes() {
  const { data } = await api.get('/v2/lanes');
  return data;
}

export default api;
