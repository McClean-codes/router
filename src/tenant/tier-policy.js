// ── Tier Policy ──────────────────────────────────────────────────
//
// Maps tier names to allowed providers and rate limits.
// Expanded for 9router's 40+ provider catalog (D9).
//
// Key difference from gateway: gateway had 7 providers.
// 9router supports cerebras, sambanova, huggingface as free-tier providers.

export const ANONYMOUS_TIER = "anonymous";

/**
 * Tier definitions — each tier adds providers on top of the previous.
 * Operator tier: allowed_providers = null → means ALL providers (D8).
 */
const TIER_DEFINITIONS = {
  anonymous: {
    allowed_providers: ["groq", "gemini", "mistral", "cerebras", "sambanova"],
    rate_limits: { requests_per_minute: 10 },
  },
  free: {
    allowed_providers: [
      "groq", "gemini", "mistral", "cerebras", "sambanova", "huggingface",
    ],
    rate_limits: { requests_per_minute: 30 },
  },
  starter: {
    allowed_providers: [
      "groq", "gemini", "mistral", "cerebras", "sambanova", "huggingface",
      "anthropic", "openai", "deepseek",
    ],
    rate_limits: { requests_per_minute: 60 },
  },
  growth: {
    allowed_providers: [
      "groq", "gemini", "mistral", "cerebras", "sambanova", "huggingface",
      "anthropic", "openai", "deepseek",
      "kiro", "openrouter", "nvidia_nim",
    ],
    rate_limits: { requests_per_minute: 120 },
  },
  operator: {
    // null = wildcard — all providers allowed (D8)
    allowed_providers: null,
    rate_limits: { requests_per_minute: 300 },
  },
};

/**
 * Get the policy for a given tier.
 * Unknown tiers fall back to anonymous.
 *
 * @param {string} tier
 * @returns {{ allowed_providers: string[] | null, rate_limits: { requests_per_minute: number } }}
 */
export function getTierPolicy(tier) {
  return TIER_DEFINITIONS[tier] || TIER_DEFINITIONS[ANONYMOUS_TIER];
}

/**
 * Check if a provider is allowed for a given tier.
 * Operator tier (null allowed_providers) allows everything.
 *
 * @param {string} tier
 * @param {string} provider
 * @returns {boolean}
 */
export function isProviderAllowed(tier, provider) {
  const policy = getTierPolicy(tier);
  // null = wildcard (operator tier)
  if (policy.allowed_providers === null) return true;
  return policy.allowed_providers.includes(provider);
}

/**
 * Get the resolved provider list for a tier.
 * Returns the actual list for non-operator tiers, or ['*'] for operator.
 *
 * @param {string} tier
 * @returns {string[]}
 */
export function resolveAllowedProviders(tier) {
  const policy = getTierPolicy(tier);
  if (policy.allowed_providers === null) return ["*"];
  return [...policy.allowed_providers];
}

/**
 * Get all tier names.
 * @returns {string[]}
 */
export function getAllTiers() {
  return Object.keys(TIER_DEFINITIONS);
}
