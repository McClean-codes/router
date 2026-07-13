import { describe, expect, it, vi, beforeEach } from "vitest";
import { SignJWT } from "jose";

// ── T1.7: Tier Policy Tests ──────────────────────────────────────

import {
  getTierPolicy,
  isProviderAllowed,
  resolveAllowedProviders,
  getAllTiers,
  ANONYMOUS_TIER,
} from "@/tenant/tier-policy.js";

describe("tier-policy", () => {
  describe("getTierPolicy", () => {
    it("returns anonymous policy for unknown tier", () => {
      const policy = getTierPolicy("nonexistent");
      expect(policy.allowed_providers).toEqual([
        "groq", "gemini", "mistral", "cerebras", "sambanova",
      ]);
      expect(policy.rate_limits.requests_per_minute).toBe(10);
    });

    it("returns anonymous policy explicitly", () => {
      const policy = getTierPolicy(ANONYMOUS_TIER);
      expect(policy.rate_limits.requests_per_minute).toBe(10);
    });

    it("returns free tier with 6 providers", () => {
      const policy = getTierPolicy("free");
      expect(policy.allowed_providers).toContain("huggingface");
      expect(policy.rate_limits.requests_per_minute).toBe(30);
    });

    it("returns starter tier with anthropic/openai/deepseek", () => {
      const policy = getTierPolicy("starter");
      expect(policy.allowed_providers).toContain("anthropic");
      expect(policy.allowed_providers).toContain("openai");
      expect(policy.allowed_providers).toContain("deepseek");
      expect(policy.rate_limits.requests_per_minute).toBe(60);
    });

    it("returns growth tier with kiro/openrouter/nvidia_nim", () => {
      const policy = getTierPolicy("growth");
      expect(policy.allowed_providers).toContain("kiro");
      expect(policy.allowed_providers).toContain("openrouter");
      expect(policy.allowed_providers).toContain("nvidia_nim");
      expect(policy.rate_limits.requests_per_minute).toBe(120);
    });

    it("returns operator tier with null allowed_providers (wildcard)", () => {
      const policy = getTierPolicy("operator");
      expect(policy.allowed_providers).toBeNull();
      expect(policy.rate_limits.requests_per_minute).toBe(300);
    });
  });

  describe("isProviderAllowed", () => {
    it("allows groq for anonymous tier", () => {
      expect(isProviderAllowed("anonymous", "groq")).toBe(true);
    });

    it("denies anthropic for anonymous tier", () => {
      expect(isProviderAllowed("anonymous", "anthropic")).toBe(false);
    });

    it("allows anthropic for starter tier", () => {
      expect(isProviderAllowed("starter", "anthropic")).toBe(true);
    });

    it("allows any provider for operator tier (wildcard)", () => {
      expect(isProviderAllowed("operator", "anthropic")).toBe(true);
      expect(isProviderAllowed("operator", "any-random-provider")).toBe(true);
    });

    it("denies unknown provider for free tier", () => {
      expect(isProviderAllowed("free", "nonexistent")).toBe(false);
    });
  });

  describe("resolveAllowedProviders", () => {
    it("returns ['*'] for operator tier", () => {
      expect(resolveAllowedProviders("operator")).toEqual(["*"]);
    });

    it("returns actual list for other tiers", () => {
      const providers = resolveAllowedProviders("free");
      expect(providers).toContain("groq");
      expect(providers).not.toContain("*");
    });

    it("returns a copy (not mutable reference)", () => {
      const a = resolveAllowedProviders("free");
      const b = resolveAllowedProviders("free");
      a.push("mutated");
      expect(b).not.toContain("mutated");
    });
  });

  describe("getAllTiers", () => {
    it("returns all 5 tier names", () => {
      const tiers = getAllTiers();
      expect(tiers).toEqual(["anonymous", "free", "starter", "growth", "operator"]);
    });
  });
});

// ── T1.6 + T1.8: JWT + withTenantContext Tests ───────────────────

import { withTenantContext, getTenantContext } from "@/lib/tenant-context.js";

const TEST_SECRET = "test-hmac-secret-for-jwt-signing";

function makeRequest(opts = {}) {
  const headers = new Headers();
  if (opts.authorization) {
    headers.set("Authorization", opts.authorization);
  }
  headers.set("x-forwarded-for", opts.ip || "127.0.0.1");
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
}

async function signJwt(payload, secret = TEST_SECRET) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .sign(new TextEncoder().encode(secret));
}

describe("withTenantContext", () => {
  beforeEach(() => {
    delete process.env.GATEWAY_HMAC_SECRET;
  });

  it("provides anonymous context when no Authorization header", async () => {
    const handler = withTenantContext(async (req) => {
      const ctx = getTenantContext();
      return new Response(JSON.stringify(ctx));
    });

    const res = await handler(makeRequest(), {});
    const ctx = await res.json();

    expect(ctx.tenant_id).toBe("anonymous");
    expect(ctx.tier).toBe("anonymous");
    expect(ctx.jwt).toBeNull();
    expect(ctx.allowed_providers).toContain("groq");
  });

  it("provides anonymous context when no GATEWAY_HMAC_SECRET is set", async () => {
    // No secret configured → can't verify JWT → anonymous
    const token = await signJwt({ sub: "tenant_123", tier: "growth" });
    const handler = withTenantContext(async (req) => {
      const ctx = getTenantContext();
      return new Response(JSON.stringify(ctx));
    });

    const res = await handler(makeRequest({ authorization: `Bearer ${token}` }), {});
    const ctx = await res.json();

    expect(ctx.tenant_id).toBe("anonymous");
  });

  it("provides authenticated context with valid JWT", async () => {
    process.env.GATEWAY_HMAC_SECRET = TEST_SECRET;
    const token = await signJwt({ sub: "tenant_abc", tier: "growth" });

    const handler = withTenantContext(async (req) => {
      const ctx = getTenantContext();
      return new Response(JSON.stringify(ctx));
    });

    const res = await handler(makeRequest({ authorization: `Bearer ${token}` }), {});
    const ctx = await res.json();

    expect(ctx.tenant_id).toBe("tenant_abc");
    expect(ctx.tier).toBe("growth");
    expect(ctx.jwt).toBeDefined();
    expect(ctx.jwt.sub).toBe("tenant_abc");
    expect(ctx.allowed_providers).toContain("kiro");
  });

  it("falls back to anonymous on invalid JWT", async () => {
    process.env.GATEWAY_HMAC_SECRET = TEST_SECRET;

    const handler = withTenantContext(async (req) => {
      const ctx = getTenantContext();
      return new Response(JSON.stringify(ctx));
    });

    const res = await handler(
      makeRequest({ authorization: "Bearer invalid.token.here" }),
      {}
    );
    const ctx = await res.json();

    expect(ctx.tenant_id).toBe("anonymous");
    expect(ctx.tier).toBe("anonymous");
  });

  it("falls back to anonymous on expired JWT", async () => {
    process.env.GATEWAY_HMAC_SECRET = TEST_SECRET;
    const token = await new SignJWT({ sub: "tenant_abc", tier: "free" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime("1h ago")
      .sign(new TextEncoder().encode(TEST_SECRET));

    const handler = withTenantContext(async (req) => {
      const ctx = getTenantContext();
      return new Response(JSON.stringify(ctx));
    });

    const res = await handler(makeRequest({ authorization: `Bearer ${token}` }), {});
    const ctx = await res.json();

    expect(ctx.tenant_id).toBe("anonymous");
  });

  it("falls back to anonymous on wrong secret", async () => {
    process.env.GATEWAY_HMAC_SECRET = TEST_SECRET;
    const token = await signJwt({ sub: "tenant_abc", tier: "free" }, "wrong-secret");

    const handler = withTenantContext(async (req) => {
      const ctx = getTenantContext();
      return new Response(JSON.stringify(ctx));
    });

    const res = await handler(makeRequest({ authorization: `Bearer ${token}` }), {});
    const ctx = await res.json();

    expect(ctx.tenant_id).toBe("anonymous");
  });

  it("respects custom allowed_providers in JWT claims", async () => {
    process.env.GATEWAY_HMAC_SECRET = TEST_SECRET;
    const token = await signJwt({
      sub: "tenant_custom",
      tier: "starter",
      allowed_providers: ["anthropic", "groq"],
    });

    const handler = withTenantContext(async (req) => {
      const ctx = getTenantContext();
      return new Response(JSON.stringify(ctx));
    });

    const res = await handler(makeRequest({ authorization: `Bearer ${token}` }), {});
    const ctx = await res.json();

    expect(ctx.allowed_providers).toEqual(["anthropic", "groq"]);
  });

  it("passes request through to handler unchanged", async () => {
    const handler = withTenantContext(async (req) => {
      return new Response(req.method);
    });

    const res = await handler(makeRequest(), {});
    expect(await res.text()).toBe("POST");
  });

  it("returns handler's response directly", async () => {
    const handler = withTenantContext(async (req) => {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const res = await handler(makeRequest(), {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

// ── T1.8: Integration test — context propagation ─────────────────

describe("withTenantContext integration", () => {
  it("context is accessible from nested async calls", async () => {
    process.env.GATEWAY_HMAC_SECRET = TEST_SECRET;
    const token = await signJwt({ sub: "tenant_nested", tier: "starter" });

    // Simulate nested async function that reads context
    async function nestedServiceCall() {
      // This simulates what downstream code does
      return getTenantContext();
    }

    const handler = withTenantContext(async (req) => {
      const ctx = await nestedServiceCall();
      return new Response(JSON.stringify(ctx));
    });

    const res = await handler(makeRequest({ authorization: `Bearer ${token}` }), {});
    const ctx = await res.json();

    expect(ctx.tenant_id).toBe("tenant_nested");
    expect(ctx.tier).toBe("starter");
  });

  it("concurrent requests get independent contexts", async () => {
    process.env.GATEWAY_HMAC_SECRET = TEST_SECRET;
    const tokenA = await signJwt({ sub: "tenant_a", tier: "free" });
    const tokenB = await signJwt({ sub: "tenant_b", tier: "operator" });

    const handler = withTenantContext(async (req) => {
      // Small delay to ensure interleaving
      await new Promise((r) => setTimeout(r, 10));
      const ctx = getTenantContext();
      return new Response(JSON.stringify(ctx));
    });

    const [resA, resB] = await Promise.all([
      handler(makeRequest({ authorization: `Bearer ${tokenA}` }), {}),
      handler(makeRequest({ authorization: `Bearer ${tokenB}` }), {}),
    ]);

    const ctxA = await resA.json();
    const ctxB = await resB.json();

    expect(ctxA.tenant_id).toBe("tenant_a");
    expect(ctxA.tier).toBe("free");
    expect(ctxB.tenant_id).toBe("tenant_b");
    expect(ctxB.tier).toBe("operator");
  });
});
