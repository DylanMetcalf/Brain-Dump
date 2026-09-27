// API client with offline capture. Nothing the user says is ever lost:
// if the network is down, thoughts are queued locally and replayed idempotently.

const TOKEN_KEY = 'bd.token';
const QUEUE_KEY = 'bd.queue';
const BASE = (window.BRAIN_DUMP_SERVER ?? '').replace(/\/$/, '');

export const auth = {
  get token() {
    return localStorage.getItem(TOKEN_KEY);
  },
  set token(t) {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  },
};

export class NetworkError extends Error {}

export async function api(path, { method, body } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: {
        'Content-Type': 'application/json',
        ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new NetworkError('offline');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    auth.token = null;
    location.reload();
  }
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  return data;
}

export function newClientId() {
  return (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/-/g, '');
}

// ---------------------------------------------------------------------------
// Offline queue
// ---------------------------------------------------------------------------

export function queued() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function saveQueue(q) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}

export function enqueue(text) {
  const q = queued();
  const item = { clientId: newClientId(), text, capturedAt: new Date().toISOString() };
  q.push(item);
  saveQueue(q);
  return item;
}

let flushing = false;
export async function flushQueue() {
  if (flushing || !auth.token) return [];
  const q = queued();
  if (!q.length) return [];
  flushing = true;
  try {
    const { replies } = await api('/api/sync', { body: { captures: q } });
    const done = new Set(replies.map((r) => r.clientId));
    saveQueue(queued().filter((x) => !done.has(x.clientId)));
    return replies;
  } catch {
    return [];
  } finally {
    flushing = false;
  }
}

/** Send a thought; fall back to the offline queue when the network is unavailable. */
export async function say(text, sessionId) {
  const clientId = newClientId();
  try {
    return await api('/api/utterance', { body: { text, sessionId, clientId } });
  } catch (err) {
    if (err instanceof NetworkError) {
      const q = queued();
      q.push({ clientId, text, capturedAt: new Date().toISOString() });
      saveQueue(q);
      return {
        offline: true,
        sessionId,
        text: "You're offline — I've saved that and I'll sort it as soon as you're back.",
        actions: [],
        links: [],
        settled: true,
        sessionEnded: false,
      };
    }
    throw err;
  }
}

export function openStream(onEvent) {
  if (!auth.token || !('EventSource' in window)) return () => {};
  let es;
  let closed = false;
  let retry = 1000;
  const connect = () => {
    es = new EventSource(`${BASE}/api/stream?token=${encodeURIComponent(auth.token)}`);
    es.addEventListener('sync', (e) => {
      retry = 1000;
      onEvent('sync', JSON.parse(e.data));
    });
    es.addEventListener('notification', (e) => onEvent('notification', JSON.parse(e.data)));
    es.addEventListener('devices', () => onEvent('devices', {}));
    es.onerror = () => {
      es.close();
      if (!closed) setTimeout(connect, (retry = Math.min(retry * 2, 30000)));
    };
  };
  connect();
  return () => {
    closed = true;
    es?.close();
  };
}
