// Fixed-window rate limiter, kept in memory (one server instance). Every AI
// request costs Gemini quota, so each client gets `limit` requests per
// `windowMs`, and a separate global daily cap protects the free quota even
// from many clients at once.
export function createRateLimiter({ limit, windowMs, now = Date.now }) {
  const windows = new Map();
  return function allow(key) {
    const t = now();
    const w = windows.get(key);
    if (!w || t - w.start >= windowMs) {
      // Drop stale entries now and then so the map can't grow forever.
      if (windows.size > 10_000) {
        for (const [k, v] of windows) if (t - v.start >= windowMs) windows.delete(k);
      }
      windows.set(key, { start: t, count: 1 });
      return true;
    }
    if (w.count >= limit) return false;
    w.count += 1;
    return true;
  };
}
