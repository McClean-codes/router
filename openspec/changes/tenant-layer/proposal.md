# Proposal: Tenant Layer for Router

## Problem Statement

The router (forked from 9router v0.5.30) is a single-user LLM routing proxy. It routes requests across 40+ providers with per-key cooldown, format translation, combo strategies, and token compression — but has no concept of tenants, tiers, or per-tenant credential isolation.

agent-service needs to serve multiple customers, each with their own provider API keys, tier-based access controls, and rate limits. The gateway project currently handles this with a hand-rolled router (7 providers, ~3k lines). The router fork has battle-tested routing for 40+ providers with 22k+ GitHub stars.

**Goal:** Layer multi-tenant auth, per-tenant key injection, tier-based provider filtering, and rate limiting onto the router fork without modifying its core routing engine.

## Architecture

### Current Router Flow

```
POST /v1/chat/completions
  → handleChat() [src/sse/handlers/chat.js]
    → API key check (local SQLite)
    → model → provider resolution
    → getProviderCredentials() — picks account from SQLite
    → handleChatCore() — format translation + dispatch
    → markAccountUnavailable() on error → loop to next account
```

### Proposed Flow

```
POST /v1/chat/completions
  → JWT middleware (extract TenantContext)
  → Tier enforcement (filter allowed_providers)
  → Rate limit check (per-tenant)
  → handleChat() [existing, unwrapped]
    → getProviderCredentials() [wrapped: tenant → Infisical key]
    → handleChatCore() [unchanged]
```

### Insertion Points

| Point | Location | What | Lines | 9router Impact |
|-------|----------|------|-------|----------------|
| **Auth** | Before `handleChat` | JWT extraction → TenantContext | ~200 | Zero — additive middleware |
| **Credential resolution** | Wrap `getProviderCredentials` | Per-tenant key from Infisical | ~50 | Minimal — wraps existing function |
| **Rate limiting** | After model resolution | Per-tenant rate check | ~30 | Zero — additive check |
| **Provider catalog** | New endpoint `GET /v1/providers` | Expose available providers with signup URLs | ~100 | Zero — new route |

### What Stays Unchanged

- `chatCore.js` — format translation, RTK, streaming, error handling (10k+ lines)
- `accountFallback.js` — per-key cooldown, backoff (battle-tested)
- All provider executors (40+ providers)
- Combo strategies (fallback/round-robin/fusion)
- Dashboard (separate concern)
- Token savers (Caveman, Ponytail, PXPIPE, Headroom)

## Capabilities

### C1: JWT Authentication
- Extract Bearer token from Authorization header
- Verify HS256 JWT using GATEWAY_HMAC_SECRET
- Build TenantContext (tenant_id, tier, allowed_providers, rate_limits)
- Graceful fallback to anonymous context on missing/invalid JWT

### C2: Tier-Based Provider Filtering
- Map JWT tier claim to tier policy (free/starter/growth/operator)
- Filter 9router's provider list by allowed_providers
- Expose tier info in request context for downstream use

### C3: Per-Tenant Key Injection
- Resolve tenant_id → Infisical path (agent-service/{tenant_id}/)
- Fetch provider API keys from Infisical with 1-hour TTL cache
- Inject tenant's key into credentials before chatCore
- Fall back to shared keys when tenant has no personal key

### C4: Per-Tenant Rate Limiting
- Apply tier-based rate limits (requests/min, tokens/min)
- Track per-tenant usage in-memory or SQLite
- Return 429 with Retry-After header when exceeded

### C5: Provider Catalog Endpoint
- `GET /v1/providers` — list all providers with:
  - display_name, signup_url, free_tier status
  - supported models, capabilities
  - rate_limits, auth_method
- Designed for agent-service dashboard consumption

### C6: Analytics Per Tenant
- Add tenant_id to request logging
- Per-tenant usage summaries (requests, tokens, cost)
- Expose via `/analytics/summary` and `/analytics/daily`

## Impact

### Positive
- 40+ providers vs current 7
- Battle-tested failover, per-key cooldown, format translation
- ~300 lines of adapter code vs ~3k+ to rebuild
- Dashboard comes free
- Combo strategies (fusion, round-robin, fallback) come free

### Risks
- Upstream drift — need to track 9router releases (72 so far, active)
- Security surface — auditing their code, not ours
- Their auth system (SQLite-based) needs to be bypassed/replaced

### Mitigation
- Fork gives full control — we can pin to specific versions
- Tenancy is additive middleware — minimal changes to their core
- CI tests validate tenancy behavior independent of upstream

## Non-Goals
- Modifying 9router's core routing logic
- Replacing their dashboard (separate concern)
- Token compression (RTK/Caveman) — deferred per Randy
- Hopper benchmarking — separate change

## Open Questions
1. Should anonymous access be allowed (limited providers/rate) or rejected entirely?
2. Should we keep 9router's SQLite-based auth as a fallback or fully replace with JWT?
3. How should per-tenant analytics persist — SQLite (their pattern) or external?
