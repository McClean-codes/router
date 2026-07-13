# Spec: JWT Authentication + Tenant Context

## Context

The router fork (9router v0.5.30) uses a SQLite-based API key system for single-user auth. agent-service needs multi-tenant JWT authentication so each customer authenticates with their own token. The gateway already has a working JWT system (HS256, `GATEWAY_HMAC_SECRET`) that agent-service signs tokens for. The router needs to verify the same tokens.

## Current State

- `src/sse/handlers/chat.js:56-77` — API key check against local SQLite DB (`settings.requireApiKey`)
- `src/sse/services/auth.js` — `getProviderCredentials()` reads from SQLite `provider_connections` table
- No JWT verification exists in the router codebase
- `jose` (^6.1.3) is already in `package.json` — use this, NOT `jsonwebtoken`
- Router uses `output: "standalone"` (Node.js), but Next.js middleware defaults to Edge Runtime

## Proposed Change

Create `src/lib/tenant-context.ts` with a `withTenantContext` HOF that wraps route handlers. The HOF extracts and verifies the JWT, builds a `TenantContext`, and runs the handler inside `AsyncLocalStorage.run()`. This avoids Edge Runtime entirely — the handler executes in Node.js where `node:async_hooks` works.

### Why not Next.js middleware

Next.js middleware runs in Edge Runtime by default, even with `output: "standalone"`. Edge Runtime does not support `node:async_hooks` (needed for AsyncLocalStorage). Even if forced to Node.js via `export const runtime = 'nodejs'`, `enterWith()` does not propagate context from middleware to route handlers because Next.js dispatches them in separate execution contexts.

The `withTenantContext` HOF wraps handlers at the route level, executing in the same Node.js process where AsyncLocalStorage works natively.

### Implementation Details

**File: `src/lib/tenant-context.ts`** (NEW)

```typescript
import { AsyncLocalStorage } from 'node:async_hooks';
import { jwtVerify } from 'jose';

export interface TenantContext {
  tenant_id: string;
  tier: string;
  allowed_providers: string[] | null; // null = use tier default
}

const tenantStorage = new AsyncLocalStorage<TenantContext>();

const HMAC_SECRET = new TextEncoder().encode(process.env.GATEWAY_HMAC_SECRET || '');

export function getTenantContext(): TenantContext {
  return tenantStorage.getStore() || {
    tenant_id: 'anonymous',
    tier: 'anonymous',
    allowed_providers: null,
  };
}

export function withTenantContext(
  handler: (request: Request) => Promise<Response>
) {
  return async (request: Request): Promise<Response> => {
    const authHeader = request.headers.get('authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    let ctx: TenantContext;

    if (token && HMAC_SECRET.length > 0) {
      try {
        const { payload } = await jwtVerify(token, HMAC_SECRET, {
          algorithms: ['HS256'],
        });
        ctx = {
          tenant_id: (payload.sub as string) || 'unknown',
          tier: (payload.tier as string) || 'free',
          allowed_providers: (payload.allowed_providers as string[]) || null,
        };
      } catch {
        // Invalid JWT → anonymous fallback (graceful, not 401)
        ctx = buildAnonymousContext();
      }
    } else {
      ctx = buildAnonymousContext();
    }

    return tenantStorage.run(ctx, () => handler(request));
  };
}

function buildAnonymousContext(): TenantContext {
  return {
    tenant_id: 'anonymous',
    tier: 'anonymous',
    allowed_providers: null, // resolved by tier-policy at consumption time
  };
}
```

**Route handler wrapping (example for chat/completions):**

`src/app/api/v1/chat/completions/route.js` (MODIFIED):

```javascript
import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { withTenantContext } from "../../../../lib/tenant-context.js";

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

export const POST = withTenantContext(async (request) => {
  await ensureInitialized();
  return await handleChat(request);
});
```

Same wrapping applied to `messages/route.js` and `responses/route.js`.

**File: `src/tenant/tier-policy.ts`** (NEW)

```typescript
export interface TierPolicy {
  tier: string;
  allowed_providers: string[];
  rate_limits: { requests_per_minute: number };
}

const TIER_POLICIES: Record<string, TierPolicy> = {
  anonymous: {
    tier: 'anonymous',
    allowed_providers: ['groq', 'gemini', 'mistral', 'cerebras', 'sambanova'],
    rate_limits: { requests_per_minute: 10 },
  },
  free: {
    tier: 'free',
    allowed_providers: ['groq', 'gemini', 'mistral', 'cerebras', 'sambanova', 'huggingface'],
    rate_limits: { requests_per_minute: 30 },
  },
  starter: {
    tier: 'starter',
    allowed_providers: ['groq', 'gemini', 'mistral', 'cerebras', 'sambanova', 'huggingface', 'anthropic', 'openai', 'deepseek'],
    rate_limits: { requests_per_minute: 60 },
  },
  growth: {
    tier: 'growth',
    allowed_providers: ['groq', 'gemini', 'mistral', 'cerebras', 'sambanova', 'huggingface', 'anthropic', 'openai', 'deepseek', 'kiro', 'openrouter', 'nvidia_nim'],
    rate_limits: { requests_per_minute: 120 },
  },
  operator: {
    tier: 'operator',
    allowed_providers: [], // empty = all providers (resolved as null/flag, not ['*'])
    rate_limits: { requests_per_minute: 300 },
  },
};

export function getTierPolicy(tier: string): TierPolicy | null {
  return TIER_POLICIES[tier] || null;
}

export function resolveAllowedProviders(tier: string, override: string[] | null): string[] | null {
  if (override) return override;
  const policy = TIER_POLICIES[tier];
  if (!policy) return TIER_POLICIES.anonymous!.allowed_providers;
  if (policy.allowed_providers.length === 0) return null; // null = operator, all allowed
  return policy.allowed_providers;
}

export function isProviderAllowed(provider: string, allowed: string[] | null): boolean {
  if (allowed === null) return true; // operator tier
  return allowed.includes(provider);
}
```

**Key design change from review (D9/D12):** Operator tier returns `null` (not `['*']`) to signal "all providers allowed". The `isProviderAllowed()` helper encapsulates the check so consumers don't need to handle the wildcard case.

## Acceptance Criteria

1. A valid HS256 JWT in `Authorization: Bearer <token>` → `TenantContext` available in route handler via `getTenantContext()`
2. No `Authorization` header → anonymous context (free tier, 10 req/min)
3. Invalid JWT → anonymous context (graceful fallback, not 401)
4. `GATEWAY_HMAC_SECRET` not configured → all requests treated as anonymous
5. JWT payload `sub` field maps to `tenant_id` in context
6. JWT payload `tier` field maps to tier policy lookup
7. JWT payload `allowed_providers` overrides tier default when present
8. Wrapper applies to `/v1/chat/*`, `/v1/messages/*`, `/v1/responses/*`
9. Non-`/v1/*` routes (dashboard, health, settings, `/v1/providers`) are unaffected
10. Uses `jose` library (NOT `jsonwebtoken`)
11. Tests: JWT valid, JWT invalid, no JWT, expired JWT, wrong secret

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Unit | JWT verification with jose (valid, invalid, expired, wrong secret) | 4 |
| Unit | Anonymous context construction | 2 |
| Unit | Tier policy lookup (valid tier, unknown tier) | 2 |
| Unit | AsyncLocalStorage propagation via withTenantContext | 2 |
| Integration | withTenantContext → handler receives context | 2 |
| E2E | Full request with valid JWT → response carries tenant context | 1 |

## Effort Estimate

- `src/lib/tenant-context.ts`: 2h
- `src/tenant/tier-policy.ts`: 1h
- Route handler wrapping (3 files): 1h
- Tests: 2h
- **Total: ~6h**

## Files Reference

| File | Change |
|------|--------|
| `src/lib/tenant-context.ts` | NEW — withTenantContext HOF + AsyncLocalStorage |
| `src/tenant/tier-policy.ts` | NEW — tier definitions + provider mapping |
| `src/app/api/v1/chat/completions/route.js` | MODIFIED — wrap POST with withTenantContext |
| `src/app/api/v1/messages/route.js` | MODIFIED — wrap POST with withTenantContext |
| `src/app/api/v1/responses/route.js` | MODIFIED — wrap POST with withTenantContext |

## Out of Scope

- Key injection (M3)
- Rate limiting (M4)
- Provider filtering enforcement (M2)
