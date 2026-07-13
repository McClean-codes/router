# Spec: Provider Catalog Endpoint

## Context

agent-service needs a user-facing endpoint that its dashboard can consume. Clients should see which providers they can connect to, with signup URLs, free-tier status, and capabilities. This is the bridge between the router's 40+ provider catalog and the agent-service UI.

## Current State

- `GET /v1/models` exists in the router — returns model list from 9router's provider config
- No provider-level metadata (signup URLs, free-tier info, capabilities)
- The gateway had a `provider-registry.yaml` with richer metadata
- 9router's `open-sse/providers/registry/` has transport config but not user-facing info

## Proposed Change

Create `GET /v1/providers` that merges 9router's provider transport config with user-facing metadata. No auth required — this is a public catalog. Rate limited to 60 req/min per IP.

### Implementation Details

**File: `src/app/api/v1/providers/route.js`** (NEW)

```javascript
import { PROVIDERS } from 'open-sse/providers/index.js';
import { PROVIDER_MODELS } from 'open-sse/providers/index.js';
import { checkRateLimit } from '../../../tenant/rate-limiter.js';

// Static metadata for user-facing display
const PROVIDER_META = {
  anthropic: { display_name: 'Anthropic', signup_url: 'https://console.anthropic.com/', free_tier: false, auth_method: 'api_key', capabilities: ['chat', 'vision', 'tool_use'] },
  openai: { display_name: 'OpenAI', signup_url: 'https://platform.openai.com/', free_tier: false, auth_method: 'api_key', capabilities: ['chat', 'vision', 'tool_use', 'embeddings'] },
  groq: { display_name: 'Groq', signup_url: 'https://console.groq.com/', free_tier: true, auth_method: 'none', capabilities: ['chat', 'vision'] },
  gemini: { display_name: 'Google Gemini', signup_url: 'https://aistudio.google.com/', free_tier: true, auth_method: 'api_key', capabilities: ['chat', 'vision', 'tool_use'] },
  mistral: { display_name: 'Mistral', signup_url: 'https://console.mistral.ai/', free_tier: true, auth_method: 'api_key', capabilities: ['chat', 'vision'] },
  cerebras: { display_name: 'Cerebras', signup_url: 'https://cloud.cerebras.ai/', free_tier: true, auth_method: 'api_key', capabilities: ['chat'] },
  sambanova: { display_name: 'SambaNova', signup_url: 'https://cloud.sambanova.ai/', free_tier: true, auth_method: 'api_key', capabilities: ['chat'] },
  huggingface: { display_name: 'Hugging Face', signup_url: 'https://huggingface.co/', free_tier: true, auth_method: 'api_key', capabilities: ['chat'] },
  deepseek: { display_name: 'DeepSeek', signup_url: 'https://platform.deepseek.com/', free_tier: false, auth_method: 'api_key', capabilities: ['chat', 'tool_use'] },
  kiro: { display_name: 'Kiro', signup_url: 'https://kiro.dev/', free_tier: false, auth_method: 'api_key', capabilities: ['chat', 'tool_use'] },
  openrouter: { display_name: 'OpenRouter', signup_url: 'https://openrouter.ai/', free_tier: true, auth_method: 'api_key', capabilities: ['chat', 'vision'] },
  nvidia_nim: { display_name: 'NVIDIA NIM', signup_url: 'https://build.nvidia.com/', free_tier: true, auth_method: 'api_key', capabilities: ['chat'] },
  // ... expand for all 40+ providers as metadata is researched
};

export async function GET(request) {
  // Rate limit: 60 req/min per IP (public endpoint, prevent abuse)
  const ip = request.headers.get('x-9r-real-ip') || 'unknown';
  const rl = checkRateLimit(`providers:${ip}`, 60);
  if (!rl.allowed) {
    return Response.json(
      { error: 'Rate limit exceeded', retry_after: rl.retryAfter },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } }
    );
  }

  const providers = Object.entries(PROVIDERS).map(([id, config]) => {
    const meta = PROVIDER_META[id] || {};
    const models = PROVIDER_MODELS[id] || [];
    return {
      id,
      display_name: meta.display_name || id,
      signup_url: meta.signup_url || null,
      free_tier: meta.free_tier ?? false,
      auth_method: meta.auth_method || 'api_key',
      models: models.map(m => m.id || m),
      capabilities: meta.capabilities || ['chat'],
    };
  });

  return Response.json({ providers }, {
    headers: { 'Cache-Control': 'public, max-age=3600' },
  });
}
```

**No auth required** — the catalog is public. Rate limited to prevent abuse.

## Acceptance Criteria

1. `GET /v1/providers` returns 200 with JSON array of providers
2. Each provider has: `id`, `display_name`, `signup_url`, `free_tier`, `auth_method`, `models`, `capabilities`
3. Response includes all providers from 9router's registry (40+)
4. Free-tier providers are correctly flagged (`groq`, `gemini`, `mistral`, `cerebras`, `sambanova`, `huggingface`)
5. Response is cached for 1 hour (`Cache-Control: public, max-age=3600`)
6. No auth required — anonymous access works
7. Rate limited to 60 req/min per IP
8. Models list matches 9router's actual model catalog

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Unit | Provider metadata merge logic | 2 |
| Integration | Endpoint returns correct shape | 2 |
| Integration | Rate limit enforcement | 1 |
| E2E | Dashboard can fetch and render provider list | 1 |

## Effort Estimate

- Route handler: 1.5h
- Provider metadata (signup URLs for 40+ providers): 3h (research-heavy)
- Tests: 1h
- **Total: ~5.5h**

## Files Reference

| File | Change |
|------|--------|
| `src/app/api/v1/providers/route.js` | NEW — catalog endpoint |

## Out of Scope

- Per-provider health status (future enhancement)
- Model pricing information (future enhancement)
- Provider capability detection (static metadata for now)
