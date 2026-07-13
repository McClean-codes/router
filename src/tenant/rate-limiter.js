// ── Rate Limiter ──────────────────────────────────────────────────
//
// Sliding window rate limiter, per-tenant (or per-IP for anonymous).
// In-memory only — no Redis. Single-instance.
//
// Key design decisions (D12):
// - Anonymous tenants keyed by IP (anonymous:${ip}), not shared "anonymous"
// - Token-based limits deferred (phantom limits are worse than none)
// - Window resets after 60 seconds

/**
 * @typedef {Object} WindowEntry
 * @property {number} count
 * @property {number} windowStart
 */

/** @type {Map<string, WindowEntry>} */
const windows = new Map();
const WINDOW_MS = 60_000; // 1 minute

/**
 * Check if a request is within the rate limit.
 *
 * @param {string} key - Rate limit key (tenant_id or anonymous:ip)
 * @param {number} limit - Max requests per minute
 * @returns {{ allowed: boolean, retryAfter?: number, remaining?: number }}
 */
export function checkRateLimit(key, limit) {
  const now = Date.now();

  let entry = windows.get(key);
  if (!entry || (now - entry.windowStart) >= WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    windows.set(key, entry);
  }

  entry.count++;

  if (entry.count > limit) {
    const retryAfter = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfter, remaining: 0 };
  }

  return { allowed: true, remaining: limit - entry.count };
}

/**
 * Get the rate limit key for a tenant.
 * Authenticated tenants keyed by tenant_id.
 * Anonymous tenants keyed by IP to prevent one client exhausting the pool.
 *
 * @param {string} tenantId
 * @param {string} ip
 * @returns {string}
 */
export function getRateLimitKey(tenantId, ip) {
  if (tenantId === "anonymous") return `anonymous:${ip}`;
  return tenantId;
}
