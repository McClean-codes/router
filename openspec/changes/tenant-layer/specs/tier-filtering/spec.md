# Spec: Tier-Based Provider Filtering

## Context

After JWT authentication resolves a `TenantContext` (M1), the router must enforce which providers each tier can access. A `free` tenant calling `anthropic` should get a 403, not a silent routing to a free provider. The enforcement happens in `handleChat` after model→provider resolution.

## Current State

- `src/sse/handlers/chat.js:186` — `const { provider, model } = modelInfo;` (provider resolved from model name)
- `src/sse/handlers/chat.js:199` — `getProviderCredentials(provider, ...)` (credential fetch)
- `src/sse/handlers/chat.js:67-77` — `settings.requireApiKey` check (API key validation)
- No provider filtering exists — any model routes to any provider
- 9router's `accountFallback.js` handles failover but doesn't filter by tenant

## Proposed Change

Two changes in `chat.js`:

1. **requireApiKey bypass (D11):** When a valid JWT is present (tenant is not anonymous), skip the SQLite API key check. The JWT IS the authentication.

2. **Provider filter:** After provider resolution (line 186), before credential fetch (line 199), check `isProviderAllowed(provider, allowed)`. Return 403 if not allowed.

### Implementation Details

**File: `src/sse/handlers/chat.js`** (MODIFIED)

At line 67, modify the `requireApiKey` check:

```javascript
import { getTenantContext } from '../../lib/tenant-context.js';

// Line 67: requireApiKey check
const tenantCtx = getTenantContext();
if (settings.requireApiKey && tenantCtx.tenant_id === 'anonymous') {
  // Only enforce API key for unauthenticated requests (D11)
  if (!apiKey) {
    log.warn("AUTH", "Missing API key (requireApiKey=true)");
    return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
  }
  const valid = await isValidApiKey(apiKey);
  if (!valid) {
    log.warn("AUTH", "Invalid API key (requireApiKey=true)");
    return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }
}
// Authenticated tenants (valid JWT) bypass requireApiKey — JWT is their auth
```

At line 186, after provider resolution, add provider filter:

```javascript
import { isProviderAllowed, resolveAllowedProviders } from '../../tenant/tier-policy.js';

// Line 186: const { provider, model } = modelInfo; (existing)

// Line ~187: provider filter (NEW)
const allowed = resolveAllowedProviders(tenantCtx.tier, tenantCtx.allowed_providers);
if (!isProviderAllowed(provider, allowed)) {
  log.warn('TENANT', `Provider ${provider} not allowed for tier ${tenantCtx.tier}`);
  return errorResponse(HTTP_STATUS.FORBIDDEN, `Provider '${provider}' not available for your tier (${tenantCtx.tier})`);
}
```

**Important:** The provider filter goes between line 186 (provider resolution) and line 199 (`getProviderCredentials` call). Not at the spec's previous incorrect line reference.

## Acceptance Criteria

1. `free` tier request for `anthropic` model → 403 with message "not available for your tier"
2. `starter` tier request for `anthropic` model → 200 (allowed)
3. `operator` tier request for any provider → 200 (all allowed)
4. Anonymous tier request for `anthropic` → 403
5. Anonymous tier request for `groq` → 200 (free provider)
6. 403 response includes provider name and tenant tier in error message
7. Provider filtering applies to all chat/message/response endpoints
8. `requireApiKey=true` + valid JWT → request proceeds (JWT bypasses API key check)
9. `requireApiKey=true` + no JWT + no API key → 401
10. Combo/fusion strategies still work — filtering applies per-model in the combo

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Unit | `isProviderAllowed` (allowed, not allowed, operator null) | 3 |
| Unit | `resolveAllowedProviders` (each tier, override, operator) | 4 |
| Integration | Full request with disallowed provider → 403 | 2 |
| Integration | requireApiKey + JWT bypass | 2 |
| E2E | Tier-filtered request through actual provider call | 2 |

## Effort Estimate

- Provider check in `chat.js`: 1.5h
- requireApiKey bypass: 0.5h
- `isProviderAllowed` + `resolveAllowedProviders`: 0.5h
- Tests: 2h
- **Total: ~4.5h**

## Files Reference

| File | Change |
|------|--------|
| `src/sse/handlers/chat.js:~67` | MODIFIED — requireApiKey bypass for JWT |
| `src/sse/handlers/chat.js:~187` | MODIFIED — add provider filter after line 186 |
| `src/tenant/tier-policy.ts` | NEW (from M1) — `isProviderAllowed`, `resolveAllowedProviders` |

## Out of Scope

- Key injection (M3)
- Rate limiting (M4)
