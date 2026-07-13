// ── Tenant Context ───────────────────────────────────────────────
//
// TenantContext is the architectural spine. Every request carries it;
// every downstream subsystem reads from it.
//
// Properties:
//   tenant_id          — unique identifier ('anonymous' for unauthenticated)
//   tier               — 'anonymous' | 'free' | 'starter' | 'growth' | 'operator'
//   allowed_providers  — subset of registered providers this tenant can use
//   rate_limits        — { requests_per_minute: number }
//   jwt                — raw JWT payload if authenticated (null for anonymous)

import { AsyncLocalStorage } from "node:async_hooks";
import { jwtVerify } from "jose";
import { getTierPolicy, ANONYMOUS_TIER } from "@/tenant/tier-policy.js";

const tenantStorage = new AsyncLocalStorage();

/**
 * Get the current request's TenantContext.
 * Call this from any code running inside a withTenantContext handler.
 * @returns {import("@/tenant/tier-policy.js").TenantContext | null}
 */
export function getTenantContext() {
  return tenantStorage.getStore() || null;
}

/**
 * Build a TenantContext from verified JWT claims.
 * @param {object} claims - Decoded JWT payload
 * @returns {object} TenantContext-shaped object
 */
function buildContextFromClaims(claims) {
  const tenant_id = claims.sub || "anonymous";
  const tier = claims.tier || "free";
  const policy = getTierPolicy(tier);

  return {
    tenant_id,
    tier,
    allowed_providers: claims.allowed_providers || policy.allowed_providers,
    rate_limits: policy.rate_limits,
    jwt: claims,
  };
}

/**
 * Build an anonymous TenantContext (no JWT, free tier).
 * @param {string} [ip] - Client IP for per-IP rate limiting
 * @returns {object} TenantContext-shaped object
 */
function buildAnonymousContext(ip) {
  const policy = getTierPolicy(ANONYMOUS_TIER);
  return {
    tenant_id: "anonymous",
    tier: ANONYMOUS_TIER,
    allowed_providers: policy.allowed_providers,
    rate_limits: policy.rate_limits,
    jwt: null,
    client_ip: ip || "unknown",
  };
}

/**
 * Extract client IP from request headers.
 * @param {Request} request
 * @returns {string}
 */
function extractClientIp(request) {
  // Check common proxy headers first
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp;

  // Fallback — not ideal but works for single-instance
  return request.headers.get("x-forwarded-for") || "unknown";
}

/**
 * withTenantContext — Higher-order function that wraps a Next.js route handler.
 *
 * Extracts JWT from Authorization header, verifies it with jose,
 * builds TenantContext, and runs the handler inside AsyncLocalStorage.
 *
 * If no token or invalid token → anonymous context (free tier, 10 req/min).
 *
 * @param {Function} handler - The route handler (async function taking Request)
 * @returns {Function} Wrapped handler
 */
export function withTenantContext(handler) {
  return async function wrappedHandler(request, context) {
    const secret = process.env.GATEWAY_HMAC_SECRET;
    let tenantCtx;

    const authHeader = request.headers.get("Authorization");
    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (bearerToken && secret) {
      try {
        const { payload } = await jwtVerify(
          bearerToken,
          new TextEncoder().encode(secret),
          { algorithms: ["HS256"] }
        );
        tenantCtx = buildContextFromClaims(payload);
      } catch {
        // Invalid/expired JWT → anonymous fallback (D1: soft gate)
        tenantCtx = buildAnonymousContext(extractClientIp(request));
      }
    } else {
      // No token or no secret configured → anonymous
      tenantCtx = buildAnonymousContext(extractClientIp(request));
    }

    // Run handler inside AsyncLocalStorage so getTenantContext() works downstream
    return tenantStorage.run(tenantCtx, () => handler(request, context));
  };
}
