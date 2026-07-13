# Spec: Per-Tenant Key Injection

## Context

Each customer has their own provider API keys stored in Infisical at `agent-service/{tenant_id}/{PROVIDER}_API_KEY`. When a tenant makes a request, the router should use their personal key instead of the shared key. This gives tenants their own rate limits, usage tracking, and billing isolation on the provider side.

## Current State

- `src/sse/services/auth.js:20-80` — `getProviderCredentials()` reads from SQLite `provider_connections` table
- `src/sse/services/auth.js:199` — call site in `chat.js`: `getProviderCredentials(provider, excludeConnectionIds, model)`
- No Infisical integration in the router
- No per-tenant key resolution

## Proposed Change

Wrap the credential resolution in `chat.js` to check Infisical first. If the tenant has a personal key, inject it as a virtual connection. If not, fall back to 9router's existing SQLite-based selection (shared keys).

### Implementation Details

**File: `src/tenant/key-vault.ts`** (NEW)

```typescript
import { fetchSecretsByPath } from './infisical-client';

const CACHE_TTL_MS = 3600_000; // 1 hour
const TENANT_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

interface CachedSecrets {
  secrets: Record<string, string>;
  fetchedAt: number;
}

export class KeyVault {
  private cache = new Map<string, CachedSecrets>();
  private sharedKeys: Record<string, string>;
  private infisicalToken: string | null;
  private projectId: string;
  private environment: string;

  constructor(
    sharedKeys: Record<string, string>,
    infisicalToken: string | null,
    options: { projectId?: string; environment?: string } = {}
  ) {
    this.sharedKeys = sharedKeys;
    this.infisicalToken = infisicalToken;
    this.projectId = options.projectId || '';
    this.environment = options.environment || 'prod';
  }

  async getKey(tenantId: string, provider: string): Promise<string | null> {
    const secrets = await this.fetchTenantSecrets(tenantId);
    const secretName = `${provider.toUpperCase()}_API_KEY`;
    if (secrets?.[secretName]) return secrets[secretName];
    return this.sharedKeys[provider] || null;
  }

  private async fetchTenantSecrets(tenantId: string): Promise<Record<string, string> | null> {
    const cached = this.cache.get(tenantId);
    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
      return cached.secrets;
    }

    if (!this.infisicalToken) return null;
    if (!TENANT_ID_REGEX.test(tenantId)) return null; // path traversal guard

    const path = `agent-service/${tenantId}`;
    const secrets = await fetchSecretsByPath(path, this.infisicalToken, {
      environment: this.environment,
      projectId: this.projectId,
    });

    if (secrets) {
      this.cache.set(tenantId, { secrets, fetchedAt: Date.now() });
    }
    return secrets;
  }

  invalidateCache(tenantId: string) { this.cache.delete(tenantId); }
  clearCache() { this.cache.clear(); }
}
```

**File: `src/tenant/infisical-client.ts`** (NEW)

Thin REST wrapper — direct port from gateway's `tenant/infisical-client.js`. Uses `fetch()` with `AbortSignal.timeout(10_000)`.

**File: `src/tenant/key-vault-singleton.ts`** (NEW)

```typescript
import { KeyVault } from './key-vault';

const sharedKeys: Record<string, string> = {};
const envMap: Record<string, string> = {
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  gemini: 'GEMINI_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  sambanova: 'SAMBANOVA_API_KEY',
};
for (const [provider, envVar] of Object.entries(envMap)) {
  const val = process.env[envVar];
  if (val) sharedKeys[provider] = val;
}

export const keyVault = new KeyVault(
  sharedKeys,
  process.env.INFISICAL_SERVICE_TOKEN || null,
  {
    projectId: process.env.INFISICAL_PROJECT_ID || '',
    environment: process.env.INFISICAL_ENVIRONMENT || 'prod',
  }
);
```

**File: `src/sse/handlers/chat.js`** (MODIFIED)

After line 199 (`getProviderCredentials` call), the credentials are resolved. We need to intercept BEFORE that call. Insert between line 186 (provider resolution) and line 199 (credential fetch):

```javascript
import { keyVault } from '../../tenant/key-vault-singleton.js';

// After line 186 (provider resolution) and the provider filter check:
const tenantCtx = getTenantContext();
let credentials;

if (tenantCtx.tenant_id !== 'anonymous' && keyVault) {
  const tenantKey = await keyVault.getKey(tenantCtx.tenant_id, provider);
  if (tenantKey) {
    // Inject as virtual connection — bypass SQLite selection
    credentials = {
      id: 'tenant',
      connectionName: `${tenantCtx.tenant_id}/${provider}`,
      isActive: true,
      accessToken: tenantKey,
      providerSpecificData: {},
    };
    log.debug('KEY-VAULT', `Using tenant key for ${tenantCtx.tenant_id}/${provider}`);
  }
}

if (!credentials) {
  // Fall through to existing getProviderCredentials() — shared keys via SQLite
  credentials = await getProviderCredentials(provider, excludeConnectionIds, model);
}
```

## Acceptance Criteria

1. Tenant with personal `ANTHROPIC_API_KEY` in Infisical → request uses their key
2. Tenant without personal key → falls back to shared key (existing SQLite selection)
3. Anonymous tenant → always uses shared key
4. Infisical unavailable → falls back to shared keys (graceful degradation)
5. 1-hour cache TTL — same tenant+provider doesn't hit Infisical twice within an hour
6. Path traversal guard: tenant_id with `../` → rejected, falls back to shared key
7. 10s timeout on Infisical API — won't hang the request
8. Keys are never logged (masked in debug output)

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Unit | KeyVault.getKey (cached, fresh, infisical down, bad tenant_id) | 4 |
| Unit | Infisical client (success, timeout, auth error) | 3 |
| Integration | Wrapped getProviderCredentials (tenant key, shared fallback) | 2 |
| E2E | Full request with tenant key in Infisical | 1 |

## Effort Estimate

- `key-vault.ts`: 2h
- `infisical-client.ts`: 1h
- Singleton + wrap in `chat.js`: 1.5h
- Tests: 2h
- **Total: ~6.5h**

## Files Reference

| File | Change |
|------|--------|
| `src/tenant/key-vault.ts` | NEW — Infisical key fetch + cache |
| `src/tenant/infisical-client.ts` | NEW — REST wrapper |
| `src/tenant/key-vault-singleton.ts` | NEW — env-based singleton init |
| `src/sse/handlers/chat.js:~190` | MODIFIED — inject tenant key before getProviderCredentials |

## Out of Scope

- Multi-key rotation per provider (future enhancement)
- Key rotation on provider side (tenant manages their own keys)
