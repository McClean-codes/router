# Tasks: Tenant Layer

## M1: Tenant Context + JWT Auth

- [ ] **T1.1** Create `src/lib/tenant-context.ts` — withTenantContext HOF + AsyncLocalStorage + getTenantContext
- [ ] **T1.2** Create `src/tenant/tier-policy.ts` — tier definitions, provider mapping, isProviderAllowed helper
- [ ] **T1.3** Wrap `src/app/api/v1/chat/completions/route.js` POST with withTenantContext
- [ ] **T1.4** Wrap `src/app/api/v1/messages/route.js` POST with withTenantContext
- [ ] **T1.5** Wrap `src/app/api/v1/responses/route.js` POST with withTenantContext
- [ ] **T1.6** Write unit tests: JWT verification with jose (valid, invalid, expired, wrong secret)
- [ ] **T1.7** Write unit tests: tier policy lookup and anonymous fallback
- [ ] **T1.8** Write integration test: withTenantContext → handler receives context

## M2: Tier Enforcement + Provider Filtering

- [ ] **T2.1** Add provider filter check in `chat.js` between line 186 (provider resolution) and line 199 (getProviderCredentials)
- [ ] **T2.2** Modify requireApiKey check (line 67-77) to skip when tenant has valid JWT
- [ ] **T2.3** Return 403 with provider name and tier in error message for disallowed providers
- [ ] **T2.4** Write unit tests for isProviderAllowed (allowed, not allowed, operator null)
- [ ] **T2.5** Write unit tests for resolveAllowedProviders (each tier, override, operator)
- [ ] **T2.6** Write integration tests: disallowed provider → 403, allowed → 200, requireApiKey+JWT bypass

## M3: Key Vault + Credential Injection

- [ ] **T3.1** Create `src/tenant/infisical-client.ts` — REST wrapper with 10s timeout
- [ ] **T3.2** Create `src/tenant/key-vault.ts` — Infisical fetch + 1h cache + path traversal guard
- [ ] **T3.3** Create `src/tenant/key-vault-singleton.ts` — env-based initialization
- [ ] **T3.4** Wrap credential resolution in `chat.js` — check Infisical before getProviderCredentials (insert at ~line 190)
- [ ] **T3.5** Write unit tests for KeyVault (cached, fresh, infisical down, bad tenant_id)
- [ ] **T3.6** Write unit tests for Infisical client (success, timeout, auth error)
- [ ] **T3.7** Write integration test: tenant key injection end-to-end

## M4: Rate Limiting

- [ ] **T4.1** Create `src/tenant/rate-limiter.ts` — sliding window counter, per-IP for anonymous
- [ ] **T4.2** Add rate limit check in `withTenantContext` after JWT verification
- [ ] **T4.3** Return 429 with `Retry-After` and `X-RateLimit-Remaining` headers
- [ ] **T4.4** Write unit tests for checkRateLimit (within, at, over limit, window reset)
- [ ] **T4.5** Write unit tests for getRateLimitKey (authenticated vs anonymous)
- [ ] **T4.6** Write integration test: rapid-fire → 429

## M5: Provider Catalog + Analytics

- [ ] **T5.1** Create `src/app/api/v1/providers/route.js` — public catalog endpoint (rate limited, no auth)
- [ ] **T5.2** Build provider metadata map (signup URLs, free-tier, capabilities for 40+ providers)
- [ ] **T5.3** Create `src/tenant/analytics.ts` — SQLite logging with setImmediate writes + graceful degradation
- [ ] **T5.4** Create `src/app/api/v1/analytics/summary/route.js` — authenticated summary endpoint
- [ ] **T5.5** Create `src/app/api/v1/analytics/daily/route.js` — authenticated daily endpoint
- [ ] **T5.6** Integrate `logRequest()` in chat.js — use provider response usage.prompt_tokens/completion_tokens
- [ ] **T5.7** Write unit tests for analytics queries and graceful degradation
- [ ] **T5.8** Write integration tests: endpoint shape, auth requirement, rate limiting

## M6: Integration Testing + Deployment

- [ ] **T6.1** E2E tests: JWT auth flow, tier filtering, rate limiting, key injection
- [ ] **T6.2** Update Dockerfile if any new npm dependencies
- [ ] **T6.3** Document required Fly.io secrets (`GATEWAY_HMAC_SECRET`, `INFISICAL_*`)
- [ ] **T6.4** Deploy alongside gateway for A/B comparison
- [ ] **T6.5** Verify agent-service can authenticate and route through tenant-layer router

## Dependency Graph

```
T1.1 → T1.2 → T1.3, T1.4, T1.5 → T1.6, T1.7, T1.8

T1.1 → T2.1, T2.2 (need getTenantContext)
T1.2 → T2.4, T2.5 (need isProviderAllowed, resolveAllowedProviders)
T2.1, T2.2, T2.3 → T2.6

T1.1 → T3.4 (need getTenantContext for key injection)
T3.1 → T3.2 → T3.3 → T3.4 → T3.5, T3.6, T3.7

T1.1 → T4.2 (rate limit goes in withTenantContext)
T4.1 → T4.2 → T4.3 → T4.4, T4.5, T4.6

T5.1, T5.2 — INDEPENDENT of M1-M4 (public endpoint, no tenant context needed)
T5.3 → T5.4, T5.5 → T5.7, T5.8
T3.4 → T5.6 (analytics logs after credential resolution)

T1-T5 → T6.1 → T6.2, T6.3, T6.4, T6.5
```

**Note:** M5 provider catalog (T5.1-T5.2) can run in parallel with M2-M4. It's a static public endpoint that doesn't depend on tenant context. M5 analytics (T5.3-T5.8) depends on M3 for the credential resolution call site.

## Total Effort

| Milestone | Hours |
|-----------|-------|
| M1: Tenant Context + JWT Auth | 6 |
| M2: Tier Filtering | 4.5 |
| M3: Key Injection | 6.5 |
| M4: Rate Limiting | 4 |
| M5: Catalog + Analytics | 12.5 |
| M6: Integration + Deploy | 6 |
| **Total** | **~39.5h** |
