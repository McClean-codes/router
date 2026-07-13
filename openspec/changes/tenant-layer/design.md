# Design: Tenant Layer for Router

## Goals & Non-Goals

**Goals:**
- Layer multi-tenant JWT authentication onto the router fork without modifying core routing
- Inject per-tenant provider API keys from Infisical, with shared free-tier fallback
- Filter providers by tenant tier (free/starter/growth/operator)
- Apply per-tenant rate limits (requests/min)
- Expose a user-facing `GET /v1/providers` catalog endpoint for agent-service dashboard
- Track per-tenant analytics (request count, token usage)

**Non-Goals:**
- Modifying 9router's core routing logic (`chatCore.js`, `accountFallback.js`)
- Token compression (RTK/Caveman) — deferred
- Hopper benchmarking — separate change
- Replacing the dashboard — separate concern
- Upstream sync automation — deferred to a future change

## Decisions (resolved)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Auth enforcement mode | **Soft gate**: valid JWT → full access; no/invalid JWT → anonymous context (free providers only, 10 req/min). No 401 on missing token. | Matches gateway behavior (SPEC §5.5a). Agents may not always carry tokens; anonymous fallback keeps the system usable for internal testing. |
| D2 | JWT library | **jose** (^6.1.3) — already in package.json | Web Crypto API compatible, works in both Edge and Node.js. No new dependency. |
| D3 | Tenant context propagation | **AsyncLocalStorage via route-handler wrapper** (`withTenantContext` HOF) | Next.js middleware runs in Edge Runtime by default — `node:async_hooks` is unavailable there. Instead, wrap each route handler with a HOF that extracts JWT, builds context, and runs the handler inside `AsyncLocalStorage.run()`. This executes in Node.js (standalone mode) where AsyncLocalStorage works. |
| D4 | Credential injection strategy | **Wrap `getProviderCredentials`**: check Infisical first, fall back to local SQLite | Preserves 9router's account selection + cooldown logic. Tenant key overrides the SQLite-stored key when present. |
| D5 | Rate limiter storage | **In-memory Map** with per-tenant sliding window (requests only) | Simple, no external deps. Sufficient for single-instance deployment. Token-based limits deferred — shipping unenforced limits is worse than not having them. |
| D6 | Provider catalog source | **Merge gateway's `provider-registry.yaml` with 9router's provider config** | Gateway registry has signup URLs, free-tier info, capabilities. 9router has the transport config. Combined gives the richest catalog. |
| D7 | Analytics persistence | **SQLite** (same pattern as 9router's existing usage DB) | No new infra. 9router already has a SQLite DB for connections/settings. Add a `tenant_usage` table. Writes via `setImmediate()` to avoid blocking event loop. |
| D8 | Anonymous tier providers | `groq`, `gemini`, `mistral`, `cerebras`, `sambanova` — free providers 9router supports without auth | These providers have `noAuth: true` in 9router's `FREE_PROVIDERS` constant. Anonymous users can use them without any API key. |
| D9 | Tier-to-provider mapping | **Expand** the gateway's 4-tier model to include 9router's additional free providers | 9router supports 40+ providers. The tier policy maps to 9router's provider IDs (e.g. `cerebras`, `sambanova`) not the gateway's narrower set. |
| D10 | Context propagation mechanism | **Route-handler wrapper** (`withTenantContext`), not Next.js middleware | Avoids Edge Runtime entirely. Each route handler wraps itself: `export const POST = withTenantContext(handler)`. Clean, explicit, no hidden propagation. |
| D11 | `requireApiKey` bypass | **JWT bypasses `requireApiKey`**: when a valid JWT is present, skip the SQLite API key check | A tenant with a valid JWT is already authenticated. Requiring a separate API key on top would break the multi-tenant flow. The `requireApiKey` setting only applies to anonymous/unauthenticated requests. |
| D12 | Anonymous rate limiting | **Per-IP keying** for anonymous tenants: `anonymous:${ip}` | Prevents a single abusive client from exhausting the shared anonymous limit. Authenticated tenants use `tenant_id` as the key. |

## Repository / Module Layout

```
router/
├── src/
│   ├── lib/
│   │   └── tenant-context.ts                # NEW — withTenantContext HOF + AsyncLocalStorage
│   ├── tenant/                               # NEW — tenant subsystem (ported from gateway)
│   │   ├── tier-policy.ts                    # NEW — tier → provider mapping + rate limits
│   │   ├── key-vault.ts                      # NEW — Infisical key fetch + cache
│   │   ├── infisical-client.ts               # NEW — thin Infisical REST wrapper
│   │   ├── rate-limiter.ts                   # NEW — per-tenant sliding window
│   │   └── analytics.ts                      # NEW — per-tenant usage tracking
│   ├── app/api/v1/
│   │   ├── chat/completions/route.js         # MODIFIED — wrap with withTenantContext
│   │   ├── messages/route.js                 # MODIFIED — wrap with withTenantContext
│   │   ├── responses/route.js                # MODIFIED — wrap with withTenantContext
│   │   ├── providers/route.js                # NEW — provider catalog endpoint
│   │   └── analytics/                        # NEW — tenant analytics endpoints
│   │       ├── summary/route.js
│   │       └── daily/route.js
│   └── sse/handlers/chat.js                  # MODIFIED — read tenant context, wrap credentials, filter providers
├── open-sse/
│   └── services/auth.js                      # UNCHANGED — getProviderCredentials stays as-is
├── config/
│   └── infisical.json                        # NEW — Infisical project config (optional, env vars preferred)
```

## Pipelines / Data Flow

### Request Lifecycle (with tenant layer)

```
Client POST /v1/chat/completions
  │
  ├─► route.js: withTenantContext(handler)
  │     ├── extract Bearer token from Authorization header
  │     ├── verify HS256 JWT using jose (GATEWAY_HMAC_SECRET)
  │     ├── build TenantContext from claims (or anonymous fallback)
  │     ├── store in AsyncLocalStorage for downstream consumption
  │     └── call handler(request) inside AsyncLocalStorage.run()
  │
  ├─► handleChat(request)
  │     ├── read TenantContext via getTenantContext()
  │     ├── requireApiKey check: skip if valid JWT present (D11)
  │     ├── model → provider resolution (existing, line 186)
  │     ├── check provider ∈ tenant.allowed_providers → 403 if not
  │     ├── getProviderCredentials(provider) → WRAPPED
  │     │     ├── tenant has personal key from Infisical? → use it
  │     │     └── fall back to 9router's SQLite-based selection
  │     ├── handleChatCore() — unchanged
  │     └── analytics: log request (tenant_id, provider, model, tokens)
  │
  └─► Response to client
```

### Credential Resolution (wrapped)

```
getProviderCredentials(provider)
  │
  ├─► KeyVault.getKey(tenantId, provider)
  │     ├── cache hit? → return cached key
  │     ├── fetch from Infisical: agent-service/{tenant_id}/{PROVIDER}_API_KEY
  │     ├── cache for 1 hour
  │     └── fall back to shared key (env var)
  │
  └─► If tenant key found:
        └── return { id: "tenant", accessToken: tenantKey, ... }
      If no tenant key:
        └── proceed with 9router's existing SQLite selection (unchanged)
```

## Subsystem Deep-Dives

### §1: JWT Authentication (src/lib/tenant-context.ts)

**Location:** `src/lib/tenant-context.ts` — a HOF that wraps route handlers.

**Why not Next.js middleware:** Next.js middleware runs in Edge Runtime by default, even with `output: "standalone"`. Edge Runtime does not support `node:async_hooks` (needed for AsyncLocalStorage). The `withTenantContext` HOF wraps handlers at the route level, executing in Node.js where AsyncLocalStorage works.

**Flow:**
1. HOF receives the incoming `Request`
2. Read `Authorization` header
3. Extract Bearer token
4. Verify HS256 with `jose.jwtVerify()` using `GATEWAY_HMAC_SECRET`
5. Extract claims: `sub` (tenant_id), `tier`, `allowed_providers` (optional override)
6. Build `TenantContext` from claims
7. Run `handler(request)` inside `tenantStorage.run(context, ...)`
8. If no token or invalid token → build anonymous context (free tier, 10 req/min)

**JWT Payload Shape:**
```json
{
  "sub": "tenant_abc123",
  "tier": "growth",
  "allowed_providers": ["anthropic", "groq", "gemini"],
  "iat": 1720000000,
  "exp": 1720086400
}
```

**Anonymous Context:**
```json
{
  "tenant_id": "anonymous",
  "tier": "anonymous",
  "allowed_providers": ["groq", "gemini", "mistral", "cerebras", "sambanova"],
  "rate_limits": { "requests_per_minute": 10 }
}
```

### §2: Tier Policy (tenant/tier-policy.ts)

**Tier → Provider Mapping (expanded for 9router's catalog):**

| Tier | Allowed Providers | Req/Min |
|------|-------------------|---------|
| anonymous | groq, gemini, mistral, cerebras, sambanova | 10 |
| free | groq, gemini, mistral, cerebras, sambanova, huggingface | 30 |
| starter | + anthropic, openai, deepseek | 60 |
| growth | + kiro, openrouter, nvidia_nim | 120 |
| operator | all 40+ providers | 300 |

**Key difference from gateway:** The gateway had 7 providers. 9router has 40+. The tier boundaries expand to include more free-tier providers (cerebras, sambanova, huggingface) that 9router already supports without auth.

**Token limits removed from tier definitions.** Shipping phantom limits (defined but unenforced) is worse than not having them. Token-based rate limiting is deferred to a future change when the analytics pipeline can provide accurate token counts.

### §3: Key Vault (tenant/key-vault.ts)

Ported directly from gateway's `tenant/key-vault.js`. Changes:
- TypeScript types
- `createKeyVaultFromEnv()` reads from env vars (same pattern)
- 1-hour TTL cache per tenant
- Path traversal guard on tenant_id (`/^[a-zA-Z0-9_-]+$/`)
- 10s timeout on Infisical API calls
- Graceful degradation: if Infisical is down, fall back to shared keys

### §4: Rate Limiter (tenant/rate-limiter.ts)

**Algorithm:** Sliding window counter per tenant.

```
Map<key, { count: number, windowStart: number }>
```

- Window = 60 seconds
- **Keying:** authenticated tenants use `tenant_id`; anonymous tenants use `anonymous:${ip}` (D12)
- Check: if `count >= tier.rate_limits.requests_per_minute` → 429 with `Retry-After` header
- Reset: when window expires, reset count to 0
- **Requests only** — token-based limits deferred (D5)

**Why in-memory:** Single-instance deployment. The router runs on one Fly.io machine. If scaling to multiple instances later, swap to Redis or Fly Redis.

### §5: Provider Catalog (GET /v1/providers)

**Response shape:**
```json
{
  "providers": [
    {
      "id": "anthropic",
      "display_name": "Anthropic",
      "signup_url": "https://console.anthropic.com/",
      "free_tier": false,
      "auth_method": "api_key",
      "models": ["claude-sonnet-4", "claude-opus-4"],
      "capabilities": ["chat", "vision", "tool_use"]
    }
  ],
  "tiers": {
    "free": { "providers": ["groq", "gemini", ...], "rate_limits": {...} },
    "starter": { ... },
    "growth": { ... },
    "operator": { ... }
  }
}
```

**No auth required** — this is a public catalog endpoint. Rate limited to 60 req/min per IP to prevent abuse.

### §6: Analytics (tenant/analytics.ts)

**SQLite table:**
```sql
CREATE TABLE tenant_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  latency_ms INTEGER DEFAULT 0,
  status TEXT DEFAULT 'ok',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_tenant_usage_tenant ON tenant_usage(tenant_id);
CREATE INDEX idx_tenant_usage_created ON tenant_usage(created_at);
```

**Write strategy:** All writes via `setImmediate()` to avoid blocking the event loop. The synchronous `better-sqlite3` `.run()` is wrapped in a microtask.

**Token counting:** Use provider response `usage.prompt_tokens` and `usage.completion_tokens` (returned by most providers via chatCore). Do NOT approximate from character count.

**Endpoints:**
- `GET /v1/analytics/summary` — total requests, tokens per provider (requires auth)
- `GET /v1/analytics/daily` — daily breakdown for the last 30 days (requires auth)

## Performance Budgets

| Metric | Target | Rationale |
|--------|--------|-----------|
| JWT verification (jose) | < 1ms | HS256 is fast; no network call |
| Infisical key fetch (cold) | < 2s (p95) | 10s timeout, but typical is 200-500ms |
| Infisical key fetch (cached) | < 0.1ms | In-memory lookup |
| Rate limit check | < 0.1ms | In-memory Map lookup |
| Provider catalog response | < 50ms | Static data, no external calls |
| Analytics query (summary) | < 100ms | SQLite with indexes |
| Middleware overhead per request | < 5ms total | JWT + rate limit + context propagation |

## Open Items

| Item | Assumed Default | Unblocks | Blocks Decomposition? |
|------|-----------------|----------|----------------------|
| Should anonymous access be allowed? | Yes — free providers, 10 req/min | Randy confirmation | No — default is safe |
| Keep 9router's SQLite auth as fallback? | Yes — wrap, don't replace | Randy confirmation | No — wrapping is additive |
| Analytics persistence: SQLite or external? | SQLite (matches 9router pattern) | Randy confirmation | No — SQLite is simplest |
| How to handle multi-instance scaling? | In-memory rate limiter (single instance) | Future scaling decision | No — single instance is current deployment |
| Infisical credentials for the router container? | Same `INFISICAL_SERVICE_TOKEN` as gateway | Sherlock infra setup | No — env var config, not code |

## Handoff / Milestones

```
M1: Tenant Context + JWT Auth
    ├── src/lib/tenant-context.ts (withTenantContext HOF + AsyncLocalStorage)
    ├── src/tenant/tier-policy.ts (tier definitions, provider mapping)
    └── Wrap chat/completions, messages, responses route handlers
    Functionally complete: requests with valid JWT carry TenantContext; anonymous requests get free-tier context.

M2: Tier Enforcement + Provider Filtering
    ├── Add provider filter check in chat.js after line 186 (provider resolution)
    ├── requireApiKey bypass when JWT present (line 67-77)
    └── Return 403 for disallowed providers
    Functionally complete: tenants can only use providers in their tier.

M3: Key Vault + Credential Injection
    ├── src/tenant/key-vault.ts (Infisical integration, cache)
    ├── src/tenant/infisical-client.ts (REST wrapper)
    └── Wrap getProviderCredentials in chat.js (after line 199)
    Functionally complete: per-tenant keys injected; shared keys as fallback.

M4: Rate Limiting
    ├── src/tenant/rate-limiter.ts (sliding window, per-IP for anonymous)
    └── Apply in withTenantContext after JWT verification
    Functionally complete: tenants rate-limited per tier.

M5: Provider Catalog + Analytics
    ├── GET /v1/providers (public catalog, rate limited)
    ├── src/tenant/analytics.ts (SQLite tracking, async writes)
    ├── GET /v1/analytics/summary + /daily
    └── Log requests in chat.js after response (using provider response token counts)
    Functionally complete: dashboard can fetch provider list; usage tracked.

M6: Integration Testing + Deployment
    ├── E2E tests for JWT auth, tier filtering, rate limiting, key injection
    ├── Dockerfile update (add tenant deps if any)
    ├── Fly.io secrets (GATEWAY_HMAC_SECRET, INFISICAL_*)
    └── Deploy alongside gateway for A/B comparison
    Functionally complete: tenant-layer router deployed, serving agent-service traffic.
```

**Dependency Graph:**
```
M1 → M2 → M3 → M4 → M5 → M6
```

M1 is the foundation (context propagation). M2 builds on it (enforcement). M3 adds key injection. M4 adds rate limits. M5 adds observability. M6 validates everything end-to-end.

**Architect's involvement ends here. Nikola validates the design, then decomposes into task cards for Newton.**
