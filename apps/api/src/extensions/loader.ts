//
// Loads extension code at startup and mounts routes on the OUTER app at
// /api/v1/<routeNamespace>. NOTE: extension sub-apps do NOT pass through the
// inner `api` instance's partner-status guard or fallback-audit middleware
// (that instance is snapshotted into `app` at module scope, before async
// startup) — every extension must apply ctx.authMiddleware itself.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Hono } from 'hono';
import type { BreezeExtension, ExtensionContext, AiToolLike } from '@breeze/extension-api';
import { discoverExtensions } from './discovery';
import { aiTools } from '../services/aiTools';
import { authMiddleware } from '../middleware/auth';

async function loadEntry(dir: string, entry: string): Promise<BreezeExtension> {
  const prodEntry = path.join(dir, 'dist', 'index.cjs');
  const target = existsSync(prodEntry) ? prodEntry : path.join(dir, entry);
  const mod = await import(pathToFileURL(target).href);
  const ext: BreezeExtension | undefined = mod.default ?? mod.extension;
  if (!ext || typeof ext.register !== 'function') {
    throw new Error(`[extensions] ${target} must default-export a BreezeExtension ({ register })`);
  }
  return ext;
}

export async function mountExtensions(app: Hono, root?: string): Promise<void> {
  if (process.env.BREEZE_EXTENSIONS_ENABLED === 'false') {
    console.log('[extensions] disabled via BREEZE_EXTENSIONS_ENABLED=false');
    return;
  }
  const discovered = discoverExtensions(root);
  if (discovered.length === 0) return;

  for (const d of discovered) {
    const ext = await loadEntry(d.dir, d.manifest.entry);
    const ctx: ExtensionContext = {
      mountRoute: (subApp) => {
        app.route(`/api/v1/${d.manifest.routeNamespace}`, subApp);
      },
      authMiddleware,
      aiTools: new Proxy(aiTools as Map<string, AiToolLike>, {
        get(target, prop, receiver) {
          if (prop === 'set') {
            return (key: string, value: AiToolLike) => {
              if (target.has(key)) {
                throw new Error(`[extensions] AI tool "${key}" already registered (extension "${d.name}")`);
              }
              return target.set(key, value);
            };
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }),
      log: (message) => console.log(`[extensions:${d.name}] ${message}`),
    };
    await ext.register(ctx);
    console.log(`[extensions] mounted "${d.name}" at /api/v1/${d.manifest.routeNamespace}`);
  }
}
