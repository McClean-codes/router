# Spec: Per-Tenant Analytics

## Context

agent-service needs per-tenant usage tracking for billing, dashboards, and operational visibility. Each request should be logged with tenant_id, provider, model, token counts (from provider response), and latency. Two endpoints expose summaries.

## Current State

- 9router has a usage tracking system in its SQLite DB — but it's per-connection, not per-tenant
- No tenant-level analytics exist
- The gateway had a basic `analytics/tenant-usage.js` module
- `better-sqlite3` is in `optionalDependencies` with `sql.js` fallback
- Most providers return `usage.prompt_tokens` and `usage.completion_tokens` in their response

## Proposed Change

Add a `tenant_usage` SQLite table and log every request. Use actual provider-reported token counts (NOT character count approximation). All writes via `setImmediate()` to avoid blocking the event loop.

### Implementation Details

**File: `src/tenant/analytics.ts`** (NEW)

```typescript
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'tenant-usage.db');

let db: Database.Database;

export function initAnalytics() {
  try {
    db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS tenant_usage (
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
      CREATE INDEX IF NOT EXISTS idx_tenant_usage_tenant ON tenant_usage(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_tenant_usage_created ON tenant_usage(created_at);
    `);
  } catch (err) {
    console.error('[analytics] Failed to initialize SQLite:', err);
    // Graceful degradation — analytics disabled, requests still work
    db = null;
  }
}

export function logRequest(entry: {
  tenant_id: string;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  latency_ms: number;
  status: string;
}) {
  if (!db) return; // analytics disabled

  // Write via setImmediate to avoid blocking event loop (better-sqlite3 is sync)
  setImmediate(() => {
    try {
      db.prepare(`
        INSERT INTO tenant_usage (tenant_id, provider, model, prompt_tokens, completion_tokens, total_tokens, latency_ms, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.tenant_id, entry.provider, entry.model,
        entry.prompt_tokens, entry.completion_tokens, entry.total_tokens,
        entry.latency_ms, entry.status
      );
    } catch (err) {
      console.error('[analytics] Failed to log request:', err);
    }
  });
}

export function getSummary(tenantId: string) {
  if (!db) return [];
  return db.prepare(`
    SELECT provider, model,
           COUNT(*) as total_requests,
           SUM(prompt_tokens) as total_prompt_tokens,
           SUM(completion_tokens) as total_completion_tokens,
           SUM(total_tokens) as total_tokens,
           AVG(latency_ms) as avg_latency_ms
    FROM tenant_usage
    WHERE tenant_id = ?
    GROUP BY provider, model
    ORDER BY total_requests DESC
  `).all(tenantId);
}

export function getDaily(tenantId: string, days = 30) {
  if (!db) return [];
  return db.prepare(`
    SELECT DATE(created_at) as date,
           COUNT(*) as total_requests,
           SUM(total_tokens) as total_tokens
    FROM tenant_usage
    WHERE tenant_id = ? AND created_at > datetime('now', ?)
    GROUP BY DATE(created_at)
    ORDER BY date DESC
  `).all(tenantId, `-${days} days`);
}
```

**File: `src/app/api/v1/analytics/summary/route.js`** (NEW)

```javascript
import { withTenantContext, getTenantContext } from '../../../../lib/tenant-context.js';
import { getSummary } from '../../../../tenant/analytics.js';

export const GET = withTenantContext(async (request) => {
  const ctx = getTenantContext();
  if (ctx.tenant_id === 'anonymous') {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }
  const summary = getSummary(ctx.tenant_id);
  return Response.json({ tenant_id: ctx.tenant_id, summary });
});
```

**File: `src/app/api/v1/analytics/daily/route.js`** (NEW) — same pattern, calls `getDaily()`.

**Integration in `chat.js`:** After the response is sent, log the request using provider-reported token counts:

```javascript
import { logRequest } from '../../tenant/analytics.js';

// After handleChatCore returns response:
const tenantCtx = getTenantContext();
const response = /* result from handleChatCore */;
const latencyMs = Date.now() - startTime;

// Use provider-reported token counts (NOT character count)
const usage = response?.usage || {};
logRequest({
  tenant_id: tenantCtx.tenant_id,
  provider: resolvedProvider,
  model: modelStr,
  prompt_tokens: usage.prompt_tokens || 0,
  completion_tokens: usage.completion_tokens || 0,
  total_tokens: usage.total_tokens || 0,
  latency_ms: latencyMs,
  status: 'ok',
});
```

## Acceptance Criteria

1. Every chat request logged to `tenant_usage` table with correct fields
2. Token counts use provider-reported `usage.prompt_tokens` and `usage.completion_tokens` (NOT character count)
3. Anonymous requests logged with `tenant_id: 'anonymous'`
4. `GET /v1/analytics/summary` returns aggregated usage per provider+model
5. `GET /v1/analytics/daily` returns daily breakdown for last 30 days
6. Analytics endpoints require authenticated tenant (401 for anonymous)
7. SQLite DB auto-created on first request (if not exists)
8. DB path relative to module location, not `process.cwd()` (D7)
9. Indexes on `tenant_id` and `created_at` for fast queries
10. Writes via `setImmediate()` — never blocks event loop
11. Graceful degradation: if SQLite init fails, analytics disabled but requests still work
12. `better-sqlite3` fallback to `sql.js` handled (both in optionalDependencies)

## Testing Plan

| Layer | What | Count |
|-------|------|-------|
| Unit | logRequest (writes correct fields) | 1 |
| Unit | getSummary (aggregation logic) | 2 |
| Unit | getDaily (date filtering) | 2 |
| Unit | Graceful degradation (db=null) | 1 |
| Integration | Endpoint returns correct shape | 2 |
| E2E | Full request → analytics shows up in summary | 1 |

## Effort Estimate

- `analytics.ts`: 2h
- Route handlers: 1h
- Integration in `chat.js`: 1h
- Tests: 2h
- **Total: ~6h**

## Files Reference

| File | Change |
|------|--------|
| `src/tenant/analytics.ts` | NEW — SQLite logging + queries |
| `src/app/api/v1/analytics/summary/route.js` | NEW — summary endpoint |
| `src/app/api/v1/analytics/daily/route.js` | NEW — daily endpoint |
| `src/sse/handlers/chat.js` | MODIFIED — log request after response with provider token counts |

## Out of Scope

- Cost calculation (depends on provider pricing, future)
- Export/download analytics (future)
- Real-time streaming analytics (future)
