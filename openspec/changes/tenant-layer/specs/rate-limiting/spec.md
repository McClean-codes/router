# Spec: Per-Tenant Rate Limiting

## Context

Each tier has a requests/min limit. The rate limiter prevents any single tenant from overwhelming shared infrastructure or burning through provider quotas. It sits in the `withTenantContext` HOF, after JWT verification but before the request reaches the routing engine.

Token-based limits are deferred — shipping phantom limits (defined but unenforced) is worse than not having them. When analytics can provide accurate token counts, token limits will be added.

## Current State

- 9router has per-key cooldown in `accountFallback.js` — but this is per-connection, not per-tenant
- No tenant-level rate limiting exists
- The gateway had a basic per-tenant rate limiter (in-memory)

## Proposed Change

Add a sliding window rate limiter in `src/tenant/rate-limiter.ts`. The `withTenantContext` HOF checks the limit after building the `TenantContext`. If exceeded, return 429 with `Retry-After`.

**Anonymous keying (D12):** Anonymous tenants are keyed by IP (`anonymous:${ip}`), not a shared `anonymous` key. This prevents a single abusive client from exhausting the limit for all anonymous users.

### Implementation Details

**File: `src/tenant/rate-limiter.ts`** (NEW)

```typescript
interface WindowEntry {
  count: number;
  windowStart: number;
}

const windows = new Map<string, WindowEntry>();

export function checkRateLimit(
  key: string,
  limit: number
): { allowed: boolean; retryAfter?: number; remaining?: number } {
  const now = Date.now();
  const windowMs = 60_000; // 1 minute

  let entry = windows.get(key);
  if (!entry || (now - entry.windowStart) >= windowMs) {
    entry = { count: 0, windowStart: now };
    windows.set(key, entry);
  }

  entry.count++;

  if (entry.count > limit) {
    const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);
    return { allowed: false, retryAfter, remaining: 0 };
  }

  return { allowed: true, remaining: limit - entry.count };
}

export function getRateLimitKey(tenantId: string, ip: string): string {
  if (tenantId === 'anonymous') return `anonymous:${ip}`;
  return tenantId;
}
```

**Integration in `src/lib/tenant-context.ts`:**

```typescript
import { checkRateLimit, getRateLimitKey } from '../tenant/rate-limiter.js';
import { getTierPolicy } from '../tenant/tier-policy.js';

// Inside withTenantContext, after building ctx:
const policy = getTierPolicy(ctx.tier);
if (policy) {
  const ip = request.headers.get('x-9r-real-ip') || 'unknown';
  const key = getRateLimitKey(ctx.tenant_id, ip);
  const result = checkRateLimit(key, policy.rate_limits.requests_per_minute);

  if (!result.allowed) {
    return new NextResponse(
      JSON.stringify({ error: 'Rate limit exceeded', retry_after: result.retryAfter }),
      {
        status: 429,
        headers: {
          'Retry-After': String(result.retryAfter),
          'X-RateLimit-Remaining': '0',
          'Content-Type': 'application/json',
        },
      }
    );
  }
}
```

## Acceptance Criteria

1. Free tier: 31st request within 60s → 429 with `Retry-After` header
2. Starter tier: 61st request within 60s → 429
3. Operator tier: 301st request within 60s → 429
4. Anonymous tier: 11th request from same IP → 429
5. Different anonymous IPs have independent rate limit windows
6. Window resets after 60 seconds — next request succeeds
7. 429 response body includes `retry_after` (seconds) and `error` message
8. `X-RateLimit-Remaining` header on successful requests shows remaining count
9. Rate limiter is per-tenant (or per-IP for anonymous) — tenant A's requests don't count against tenant B
10. No token-based limits in v1 (deferred)

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Unit | checkRateLimit (within limit, at limit, over limit, window reset) | 4 |
| Unit | getRateLimitKey (authenticated vs anonymous) | 2 |
| Integration | withTenantContext returns 429 when limit exceeded | 2 |
| E2E | Rapid-fire requests hit rate limit | 1 |

## Effort Estimate

- `rate-limiter.ts`: 1.5h
- Integration in `tenant-context.ts`: 1h
- Tests: 1.5h
- **Total: ~4h**

## Files Reference

| File | Change |
|------|--------|
| `src/tenant/rate-limiter.ts` | NEW — sliding window counter |
| `src/lib/tenant-context.ts` | MODIFIED — add rate limit check in withTenantContext |

## Out of Scope

- Redis-backed rate limiting (multi-instance)
- Token-based rate limiting (deferred to when analytics provide accurate counts)
- Per-provider rate limiting (9router handles this via accountFallback)
