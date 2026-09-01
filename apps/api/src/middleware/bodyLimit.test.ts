import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, expect } from 'vitest';
import { bodyLimitForPath } from './bodyLimit';

const MB = 1024 * 1024;
const KB = 1024;

describe('bodyLimitForPath', () => {
  it('applies the tight 1MB default to ordinary routes', () => {
    expect(bodyLimitForPath('/api/v1/devices')).toEqual({
      rule: 'default',
      maxSize: 1 * MB,
      error: 'Request body too large',
    });
    expect(bodyLimitForPath('/api/v1/software/catalog')).toEqual({
      rule: 'default',
      maxSize: 1 * MB,
      error: 'Request body too large',
    });
  });

  it('carves out dev-push binary uploads at 150MB', () => {
    expect(bodyLimitForPath('/api/v1/dev/push')).toEqual({
      rule: 'dev-push',
      maxSize: 150 * MB,
      error: 'Binary too large (max 150MB)',
    });
    expect(bodyLimitForPath('/api/v1/dev/push/anything')).toEqual({
      rule: 'dev-push',
      maxSize: 150 * MB,
      error: 'Binary too large (max 150MB)',
    });
  });

  // Regression for #2401: agent command results on the heartbeat/REST
  // fallback leg can legitimately carry multi-MB stdout (capture_pprof
  // profiles, big script output). commandResultSchema caps stdout/stderr at
  // 5MB each; the body limit must not 413 a schema-valid result.
  it('carves out agent command-result submissions at 12MB', () => {
    expect(
      bodyLimitForPath('/api/v1/agents/agent-1/commands/11111111-1111-4111-8111-111111111111/result'),
    ).toEqual({
      rule: 'agent-command-result',
      maxSize: 12 * MB,
      error: 'Command result too large (max 12MB)',
    });
    // The bare /commands collection route keeps the default; it is not one of
    // the carved-out ingest segments.
    expect(bodyLimitForPath('/api/v1/agents/agent-1/commands').maxSize).toBe(1 * MB);
    // /heartbeat is now carved to 5MB (#3516) — covered by its own test below.
    expect(bodyLimitForPath('/api/v1/agents/agent-1/heartbeat').maxSize).toBe(5 * MB);
  });

  // Sized from the agent's 4MB file_write cap (~5.6MB base64 + JSON envelope);
  // the agent's WS read limit is derived from the same cap (issue #2399).
  it('carves out file-browser uploads at 8MB', () => {
    expect(bodyLimitForPath('/api/v1/system-tools/devices/dev-1/files/upload')).toEqual({
      rule: 'file-upload',
      maxSize: 8 * MB,
      error: 'File too large (max 4MB)',
    });
  });

  // Regression for #1377: the software package (installer) upload route must get a
  // 500MB+ carve-out, not the 1MB default. Before the fix, any installer over 1MB
  // was rejected by the global gate with "Request body too large" before the route's
  // own 500MB MAX_UPLOAD_SIZE check could run.
  it('carves out software package installer uploads above the route 500MB cap (#1377)', () => {
    const result = bodyLimitForPath('/api/v1/software/catalog/cat-123/versions/upload');
    expect(result.error).toBe('Package too large (max 500MB)');
    expect(result.maxSize).toBeGreaterThan(500 * MB);
    expect(result.maxSize).toBe(512 * MB);
  });

  it('does not over-match the software carve-out to sibling software routes', () => {
    // The version metadata route (no file body) and the catalog list must stay at the default.
    expect(bodyLimitForPath('/api/v1/software/catalog/cat-123/versions').maxSize).toBe(1 * MB);
    expect(bodyLimitForPath('/api/v1/software/catalog/cat-123/versions/upload/extra').maxSize).toBe(1 * MB);
  });

  // #3516: agent inventory/heartbeat ingest routes each declare a route-level
  // 5MB bodyLimit that the global 1MB gate was silently overriding, so a large
  // software inventory 413'd and sync went permanently stale.
  it('carves out agent inventory/heartbeat ingest routes at 5MB (#3516)', () => {
    for (const seg of ['hardware', 'software', 'disks', 'network', 'connections', 'heartbeat']) {
      expect(
        bodyLimitForPath(`/api/v1/agents/agent-1/${seg}`).maxSize,
        `agents/${seg} should be carved to 5MB`,
      ).toBe(5 * MB);
    }
  });

  it('does not widen the deliberately-1MB agent routes or over-match siblings (#3516)', () => {
    // monitoring-results declares its own 1MB route limit — must NOT be widened.
    expect(bodyLimitForPath('/api/v1/agents/agent-1/monitoring-results').maxSize).toBe(1 * MB);
    // warranty-info declares 1MB too.
    expect(bodyLimitForPath('/api/v1/agents/agent-1/warranty-info').maxSize).toBe(1 * MB);
    // logs/process-sample declare tighter route limits and are not in the allowlist.
    expect(bodyLimitForPath('/api/v1/agents/agent-1/logs').maxSize).toBe(1 * MB);
    expect(bodyLimitForPath('/api/v1/agents/agent-1/process-sample').maxSize).toBe(1 * MB);
    // The commands result route keeps its own (earlier, more specific) 12MB carve-out.
    expect(bodyLimitForPath('/api/v1/agents/agent-1/commands/cmd-1/result').maxSize).toBe(12 * MB);
    // Anchored: a deeper path under a matched segment must not match.
    expect(bodyLimitForPath('/api/v1/agents/agent-1/software/extra').maxSize).toBe(1 * MB);
    // A non-listed sibling stays at the default.
    expect(bodyLimitForPath('/api/v1/agents/agent-1/status').maxSize).toBe(1 * MB);
  });

  // Script bundle intake (#3245): a bundle can carry a whole script library;
  // the schema caps scripts-per-bundle and per-content size, and 20MB is the
  // effective total-bundle cap.
  it('carves out script bundle import/preview at 20MB', () => {
    expect(bodyLimitForPath('/api/v1/scripts/bundle/import')).toEqual({
      rule: 'script-bundle',
      maxSize: 20 * MB,
      error: 'Bundle too large (max 20MB)',
    });
    expect(bodyLimitForPath('/api/v1/scripts/bundle/preview')).toEqual({
      rule: 'script-bundle',
      maxSize: 20 * MB,
      error: 'Bundle too large (max 20MB)',
    });
    // Export (GET, no body) and the rest of /scripts stay on the default.
    expect(bodyLimitForPath('/api/v1/scripts/bundle/export').maxSize).toBe(1 * MB);
    expect(bodyLimitForPath('/api/v1/scripts').maxSize).toBe(1 * MB);
  });

  // Chunked package uploads (#2951): each chunk is a raw octet-stream request
  // of at most 8MB (the client's UPLOAD_CHUNK_SIZE); 9MB gives the route's own
  // per-chunk size check headroom to answer with its specific message.
  it('carves out software upload-session chunks at 9MB', () => {
    expect(
      bodyLimitForPath(
        '/api/v1/software/catalog/11111111-1111-4111-8111-111111111111/versions/uploads/22222222-2222-4222-8222-222222222222/chunks',
      ),
    ).toEqual({
      rule: 'software-chunk',
      maxSize: 9 * MB,
      error: 'Chunk too large (max 8MB)',
    });
    // Session create/status/complete/abort stay on the tight default.
    expect(
      bodyLimitForPath(
        '/api/v1/software/catalog/11111111-1111-4111-8111-111111111111/versions/uploads',
      ).maxSize,
    ).toBe(1 * MB);
  });

  // Regression for #3482: quote block/cover image uploads. The UI advertises
  // "PNG, JPEG, or WebP, up to 5 MB" and the route registers its own 5MB+64KB
  // bodyLimit, but the global gate ran first and 413'd anything over 1MB with
  // the generic "Request body too large".
  it('carves out quote image uploads at the route 5MB cap (#3482)', () => {
    expect(bodyLimitForPath('/api/v1/quotes/11111111-1111-4111-8111-111111111111/images')).toEqual({
      rule: 'image-upload',
      maxSize: 5 * MB + 64 * KB,
      error: 'Image too large (max 5 MB)',
    });
    // Sibling quote routes keep the tight default.
    expect(bodyLimitForPath('/api/v1/quotes').maxSize).toBe(1 * MB);
    expect(bodyLimitForPath('/api/v1/quotes/quote-1').maxSize).toBe(1 * MB);
    // GET of a single image is not the upload route.
    expect(bodyLimitForPath('/api/v1/quotes/quote-1/images/img-1').maxSize).toBe(1 * MB);
  });

  // Same shadowing bug, same 5MB advertised cap, found alongside #3482.
  it('carves out catalog item image and user avatar uploads at 5MB', () => {
    expect(bodyLimitForPath('/api/v1/catalog/item-1/image')).toEqual({
      rule: 'image-upload',
      maxSize: 5 * MB + 64 * KB,
      error: 'Image too large (max 5 MB)',
    });
    // Avatar keeps its own wording: at equal thresholds this gate answers
    // before the route's middleware, so the message here is what callers see.
    expect(bodyLimitForPath('/api/v1/users/me/avatar')).toEqual({
      rule: 'avatar',
      maxSize: 5 * MB + 64 * KB,
      error: 'Avatar file too large (max 5 MB)',
    });
    expect(bodyLimitForPath('/api/v1/catalog/item-1').maxSize).toBe(1 * MB);
    expect(bodyLimitForPath('/api/v1/users/me').maxSize).toBe(1 * MB);
  });

  it('carves out contract template version uploads at the route 10MB cap', () => {
    expect(
      bodyLimitForPath('/api/v1/contracts/contract-templates/tpl-1/versions/upload'),
    ).toEqual({
      rule: 'contract-template',
      maxSize: 10 * MB + 64 * KB,
      error: 'File exceeds the 10MB upload limit',
    });
    expect(bodyLimitForPath('/api/v1/contracts/contract-templates/tpl-1/versions').maxSize).toBe(1 * MB);
  });

  // #3517: the rule label is what body-limit telemetry groups on, so it has to
  // stay a closed set AND actually discriminate. A carve-out that reuses another
  // branch's label (or forgets to change 'default') would silently file its 413s
  // under the wrong bucket — exactly the blindness this telemetry exists to fix.
  it('gives every carve-out branch a distinct, non-default rule label (#3517)', () => {
    const sampled: Record<string, string> = {
      'dev-push': '/api/v1/dev/push',
      'file-upload': '/api/v1/system-tools/devices/dev-1/files/upload',
      'software-chunk':
        '/api/v1/software/catalog/cat-1/versions/uploads/up-1/chunks',
      'software-package': '/api/v1/software/catalog/cat-1/versions/upload',
      'agent-command-result': '/api/v1/agents/agent-1/commands/cmd-1/result',
      'script-bundle': '/api/v1/scripts/bundle/import',
      'image-upload': '/api/v1/catalog/item-1/image',
      avatar: '/api/v1/users/me/avatar',
      'contract-template': '/api/v1/contracts/contract-templates/tpl-1/versions/upload',
      'agent-ingest': '/api/v1/agents/agent-1/software',
    };
    for (const [rule, path] of Object.entries(sampled)) {
      expect({ path, rule: bodyLimitForPath(path).rule }).toEqual({ path, rule });
    }
    expect(bodyLimitForPath('/api/v1/devices').rule).toBe('default');
    // agent-logs / agent-process-sample are route-level rules: their limits are
    // TIGHTER than the global default, so the gate must NOT claim them.
    expect(bodyLimitForPath('/api/v1/agents/agent-1/logs').rule).toBe('default');
    expect(bodyLimitForPath('/api/v1/agents/agent-1/process-sample').rule).toBe('default');
    // Labels are Sentry tag values: bounded, and free of the characters
    // `sentry.ts` rejects (`/?#`, CR/LF) so they can never smuggle a path.
    for (const rule of [
      ...Object.keys(sampled),
      'default',
      'agent-logs',
      'agent-process-sample',
    ]) {
      expect(rule).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
    }
  });
});

/**
 * Drift guard for the recurring "route-level bodyLimit is shadowed by the
 * global gate" bug (#1377, #3482, and the three sibling upload routes #3482
 * swept up).
 *
 * The global gate is registered as `app.use('*', ...)` in index.ts, long before
 * any sub-app is mounted, so it ALWAYS runs first. A `bodyLimit({ maxSize })`
 * declared on an individual route is therefore unreachable above whatever
 * `bodyLimitForPath` grants that path — writing one without a matching carve-out
 * here silently caps the route at 1MB while the code (and usually the UI copy)
 * claims otherwise.
 *
 * Every route file that registers its own bodyLimit must be listed below with
 * the concrete path(s) it guards and the global limit that path actually gets.
 * Adding a new one fails this test until the author records the decision.
 */
const ROUTE_LEVEL_BODY_LIMITS: Record<
  string,
  {
    // A bare string path gets `globalMaxSize`; a `{ path, maxSize }` entry
    // carries its own expected limit, for files whose routes legitimately differ
    // (e.g. heartbeat.ts serves /heartbeat at 5MB and /monitoring-results at 1MB).
    paths: (string | { path: string; maxSize: number })[];
    globalMaxSize: number;
    note: string;
  }
> = {
  'devPush.ts': {
    paths: ['/api/v1/dev/push'],
    globalMaxSize: 150 * MB,
    note: 'carved out — agent binaries',
  },
  'users.ts': {
    paths: ['/api/v1/users/me/avatar'],
    globalMaxSize: 5 * MB + 64 * KB,
    note: 'carved out — 5MB avatar',
  },
  'catalog/catalog.ts': {
    paths: ['/api/v1/catalog/item-1/image'],
    globalMaxSize: 5 * MB + 64 * KB,
    note: 'carved out — 5MB product image',
  },
  'contracts/templates.ts': {
    paths: ['/api/v1/contracts/contract-templates/tpl-1/versions/upload'],
    globalMaxSize: 10 * MB + 64 * KB,
    note: 'carved out — 10MB template document',
  },
  'quotes/lifecycle.ts': {
    paths: ['/api/v1/quotes/quote-1/images'],
    globalMaxSize: 5 * MB + 64 * KB,
    note: 'carved out — 5MB quote image (#3482)',
  },
  'agents/heartbeat.ts': {
    // /heartbeat carved to 5MB (#3516). /monitoring-results deliberately stays
    // at the 1MB default: its own route-level bodyLimit is 1MB, so the gate must
    // agree — this per-path override is the guard against widening it by accident.
    paths: [
      '/api/v1/agents/agent-1/heartbeat',
      { path: '/api/v1/agents/agent-1/monitoring-results', maxSize: 1 * MB },
    ],
    globalMaxSize: 5 * MB,
    note: 'carved out — 5MB agent heartbeat ingest (#3516); monitoring-results kept at its declared 1MB.',
  },
  'agents/inventory.ts': {
    // hardware/software/disks/network carved to 5MB (#3516) so the schema item
    // caps (software: 10,000 items) bind instead of the 1MB byte gate.
    // warranty-info declares its own 1MB route limit and stays there.
    paths: [
      '/api/v1/agents/agent-1/hardware',
      '/api/v1/agents/agent-1/software',
      '/api/v1/agents/agent-1/disks',
      '/api/v1/agents/agent-1/network',
      { path: '/api/v1/agents/agent-1/warranty-info', maxSize: 1 * MB },
    ],
    globalMaxSize: 5 * MB,
    note: 'carved out — 5MB agent inventory ingest (#3516); warranty-info kept at its declared 1MB.',
  },
  'agents/connections.ts': {
    paths: ['/api/v1/agents/agent-1/connections'],
    globalMaxSize: 5 * MB,
    note: 'carved out — 5MB agent connections ingest (#3516); same shape as heartbeat/inventory.',
  },
  'agents/logs.ts': {
    paths: ['/api/v1/agents/agent-1/logs'],
    globalMaxSize: 1 * MB,
    note: 'route limit (256KB) is TIGHTER than the global default, so it applies as written.',
  },
  'agents/pamObservations.ts': {
    paths: [
      '/api/v1/agents/agent-1/commands/11111111-1111-4111-8111-111111111111/pam-observations',
    ],
    globalMaxSize: 1 * MB,
    note: 'route limit (32KB) is TIGHTER than the global default, so it applies as written.',
  },
  'agents/processSample.ts': {
    paths: ['/api/v1/agents/agent-1/process-sample'],
    globalMaxSize: 1 * MB,
    note: 'route limit (256KB) is TIGHTER than the global default, so it applies as written.',
  },
};

// index.ts hosts the global gate itself; bodyLimit.ts is this module. Route
// surfaces live under src/ generally (routes/, but also modules/, extensions/),
// so the scan roots at src/ rather than src/routes to catch registrations
// mounted from outside the routes tree.
// index.ts mounts the global gate; bodyLimitGate.ts IS the gate (it owns the
// only `bodyLimit(` call that is not route-level); bodyLimit.ts is this module.
const SCAN_EXEMPT = new Set([
  'index.ts',
  'middleware/bodyLimit.ts',
  'middleware/bodyLimitGate.ts',
]);

function filesRegisteringBodyLimit(dir: string, root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      found.push(...filesRegisteringBodyLimit(full, root));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      const rel = relative(root, full);
      if (SCAN_EXEMPT.has(rel)) continue;
      // Deliberately loose: `bodyLimit(opts)` and `bodyLimit(make(5 * MB))`
      // must be caught too, not just an inline object literal. Over-inclusion
      // fails loudly and is the correct bias for a drift guard.
      if (/\bbodyLimit\(/.test(readFileSync(full, 'utf8'))) {
        found.push(rel.startsWith('routes/') ? rel.slice('routes/'.length) : rel);
      }
    }
  }
  return found;
}

describe('route-level bodyLimit registrations vs the global gate', () => {
  const srcDir = join(__dirname, '..');

  it('every file that registers its own bodyLimit is recorded here', () => {
    const actual = filesRegisteringBodyLimit(srcDir, srcDir).sort();
    // Fail loudly if the scan root ever stops resolving — an empty scan would
    // otherwise make this assertion pass vacuously against an empty registry.
    expect(actual.length).toBeGreaterThan(0);
    const recorded = Object.keys(ROUTE_LEVEL_BODY_LIMITS).sort();
    // A new entry means someone added a route-level bodyLimit. Decide whether
    // that path needs a bodyLimitForPath carve-out (it does, if the route limit
    // is larger than 1MB) and record the decision above.
    expect(actual).toEqual(recorded);
  });

  it('the global gate grants each recorded path the limit it claims', () => {
    for (const [file, { paths, globalMaxSize, note }] of Object.entries(ROUTE_LEVEL_BODY_LIMITS)) {
      for (const entry of paths) {
        const path = typeof entry === 'string' ? entry : entry.path;
        const expected = typeof entry === 'string' ? globalMaxSize : entry.maxSize;
        expect(
          { file, path, maxSize: bodyLimitForPath(path).maxSize },
          `${file} (${note})`,
        ).toEqual({ file, path, maxSize: expected });
      }
    }
  });
});

describe('ticket attachment upload carve-out (W08 #3902)', () => {
  it('gives POST /tickets/:id/attachments 10 MiB + 64 KiB of headroom', () => {
    const p = bodyLimitForPath('/api/v1/tickets/11111111-2222-4333-8444-555555555555/attachments');
    expect(p).toEqual({
      rule: 'ticket-attachment',
      maxSize: 10 * 1024 * 1024 + 64 * 1024,
      error: 'Attachment too large (max 10 MB)',
    });
  });

  it('does NOT widen the sibling comment route', () => {
    expect(bodyLimitForPath('/api/v1/tickets/11111111-2222-4333-8444-555555555555/comments').rule)
      .toBe('default');
  });

  it('does not match the content sub-path', () => {
    expect(
      bodyLimitForPath('/api/v1/tickets/11111111-2222-4333-8444-555555555555/attachments/22222222-2222-4333-8444-555555555555/content').rule,
    ).toBe('default');
  });
});
