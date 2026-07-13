import { getTenantContext } from "./tenant-context.js";

/**
 * Infisical secret name mapping for provider API keys.
 * Tenant keys are stored at path agent-service/{tenant_id}/{PROVIDER}_API_KEY
 * in the agent-service workspace, environment "prod".
 */
const SECRET_NAME_MAP = {
  groq: "GROQ_API_KEY",
  gemini: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

/**
 * In-memory cache for Infisical secrets.
 * Key: `${provider}:${tenantId}` → { value, fetchedAt }
 * TTL: 5 minutes
 */
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheKey(provider, tenantId) {
  return `${provider}:${tenantId}`;
}

function getCached(provider, tenantId) {
  const key = cacheKey(provider, tenantId);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(provider, tenantId, value) {
  cache.set(cacheKey(provider, tenantId), {
    value,
    fetchedAt: Date.now(),
  });
}

/**
 * Mint a short-lived Infisical access token using Universal Auth.
 * Retries once with 500ms delay on failure.
 * Returns the access token string, or null on failure.
 */
async function mintInfisicalToken() {
  const clientId = process.env.INFISICAL_CLIENT_ID;
  const clientSecret = process.env.INFISICAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(
        "https://app.infisical.com/api/v1/auth/universal-auth/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId, clientSecret }),
        }
      );
      if (!resp.ok) {
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 500));
          continue;
        }
        return null;
      }
      const data = await resp.json();
      return data.accessToken;
    } catch {
      if (attempt === 0) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      return null;
    }
  }
  return null;
}

/**
 * Fetch a single secret from Infisical v4 API.
 * @param {string} secretName - e.g., "GROQ_API_KEY"
 * @param {string} environment - e.g., "prod"
 * @param {string} token - Infisical access token
 * @param {string} secretPath - e.g., "agent-service/{tenant_id}"
 * @returns {string|null} - secret value or null
 */
async function fetchSecret(secretName, environment, token, secretPath) {
  const projectId = process.env.INFISICAL_PROJECT_ID;
  if (!projectId) {
    console.warn("[tenant-key-resolver] no INFISICAL_PROJECT_ID env var");
    return null;
  }

  try {
    const url = `https://app.infisical.com/api/v4/secrets/${encodeURIComponent(secretName)}?projectId=${projectId}&environment=${environment}&secretPath=${encodeURIComponent(secretPath)}&viewSecretValue=true`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      const errBody = await resp.text();
      console.warn(`[tenant-key-resolver] HTTP ${resp.status} for ${secretName}: ${errBody.slice(0, 200)}`);
      return null;
    }
    const data = await resp.json();
    return data?.secret?.secretValue || null;
  } catch (err) {
    console.warn(`[tenant-key-resolver] fetch error: ${err}`);
    return null;
  }
}

/**
 * Get tenant's API key for a provider from Infisical.
 * Returns the key string or null if not configured.
 */
export async function getTenantApiKey(provider) {
  const tenantCtx = getTenantContext();
  if (!tenantCtx || tenantCtx.tenant_id === "anonymous") return null;

  const cached = getCached(provider, tenantCtx.tenant_id);
  if (cached !== null) return cached; // cached value (null = not cached yet)

  const secretName = SECRET_NAME_MAP[provider];
  if (!secretName) return null;

  const token = await mintInfisicalToken();
  if (!token) {
    console.warn(`[tenant-key-resolver] Infisical token mint failed for tenant=${tenantCtx.tenant_id} provider=${provider}`);
    return null;
  }

  const secretPath = `agent-service/${tenantCtx.tenant_id}`;
  const value = await fetchSecret(secretName, "prod", token, secretPath);
  setCache(provider, tenantCtx.tenant_id, value);

  if (!value) {
    console.warn(`[tenant-key-resolver] tenant=${tenantCtx.tenant_id} provider=${provider} → no key found at ${secretPath}`);
  }

  return value;
}

/**
 * Build a credentials object compatible with 9router's account system.
 * If tenant has a key in Infisical, returns a synthetic credential.
 * If not, returns null (caller falls back to normal account resolution).
 */
export async function getTenantCredentials(provider) {
  const apiKey = await getTenantApiKey(provider);
  if (!apiKey) return null;

  const tenantCtx = getTenantContext();
  return {
    id: `tenant-${tenantCtx.tenant_id}`,
    connectionName: `tenant-${tenantCtx.tenant_id}`,
    isActive: true,
    accessToken: apiKey,
    providerSpecificData: {},
    skipRefresh: true, // synthetic credential — no DB row to refresh
  };
}
