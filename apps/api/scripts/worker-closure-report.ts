/**
 * Worker-split closure report (#4142).
 *
 * Shows how many worker-registry entries are still pinned `socket-owner`
 * because their import closure reaches `routes/agentWs.ts` or
 * `services/agentCommandAwait.ts`, which entries a hypothetical cut would
 * unpin, and the "frontier importers" that hold the edges.
 *
 *   cd apps/api && npx tsx scripts/worker-closure-report.ts \
 *     [--cut-socket services/commandQueue.ts]… [--cut services/remoteSessionTeardown.ts]…
 *
 *   --cut-socket <src-rel>  drop that file's edges to AGENT_WS / AGENT_COMMAND_AWAIT
 *   --cut <src-rel>         drop every edge from that file into routes/ or to AGENT_COMMAND_AWAIT
 *
 * <src-rel> is relative to apps/api/src. Same resolver as the contract test
 * (services/workerClosure/closureGraph.ts); this is a preview, the contract
 * test remains the authority.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  AGENT_COMMAND_AWAIT,
  AGENT_WS,
  ROLE_SAFE_BOUNDARY_MODULES,
  ROUTES_DIR,
  SRC_ROOT,
  importClosure,
  parseFile,
  parseRegistrySource,
  relPath,
  resolveRelativeSpec,
  socketLocalOffenders,
  REGISTRY_FILE,
  type EdgeFilter,
} from '../src/services/workerClosure/closureGraph';

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function resolveSrcRel(rel: string, flag: string): string {
  const abs = path.resolve(SRC_ROOT, rel);
  if (!abs.startsWith(SRC_ROOT + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    fail(`${flag} ${rel}: not a file under apps/api/src`);
  }
  return abs;
}

const cutSocket = new Set<string>();
const cutFull = new Set<string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i]!;
  if (flag !== '--cut-socket' && flag !== '--cut') fail(`unknown argument: ${flag}`);
  const value = argv[++i];
  if (!value) fail(`${flag} requires a <src-rel> value`);
  (flag === '--cut-socket' ? cutSocket : cutFull).add(resolveSrcRel(value, flag));
}

const isSocketTarget = (to: string): boolean => to === AGENT_WS || to === AGENT_COMMAND_AWAIT;
const isRouteTarget = (to: string): boolean => to.startsWith(ROUTES_DIR) || to === AGENT_COMMAND_AWAIT;

const dropEdge: EdgeFilter = (from, to) =>
  (cutSocket.has(from) && isSocketTarget(to)) || (cutFull.has(from) && isRouteTarget(to));

const entries = parseRegistrySource();
const pinned: string[] = [];
const cleanSocketOwner: string[] = [];
const frontier = new Set<string>();

for (const entry of entries) {
  const target = resolveRelativeSpec(REGISTRY_FILE, entry.spec);
  if (!target) fail(`could not resolve load() spec "${entry.spec}" for entry "${entry.name}"`);
  const closure = importClosure(target, { followDynamic: true, dropEdge });
  const clean = socketLocalOffenders(closure).length === 0;
  if (clean) {
    if (entry.placement === 'socket-owner') cleanSocketOwner.push(entry.name);
    continue;
  }
  pinned.push(entry.name);
  // Frontier: non-route files in this pinned closure with a live direct edge into routes/ or agentCommandAwait.
  for (const file of closure) {
    // Not actionable: routes/ files, the await module itself (a target), and role-safe boundary leaves (never traversed).
    if (file.startsWith(ROUTES_DIR) || file === AGENT_COMMAND_AWAIT || ROLE_SAFE_BOUNDARY_MODULES.has(file)) continue;
    const { staticSpecs, dynamicSpecs } = parseFile(file);
    for (const spec of [...staticSpecs, ...dynamicSpecs]) {
      const resolved = resolveRelativeSpec(file, spec);
      if (resolved && isRouteTarget(resolved) && !dropEdge(file, resolved)) frontier.add(relPath(file));
    }
  }
}

const socketOwnerCount = entries.filter((e) => e.placement === 'socket-owner').length;
const globalCount = entries.filter((e) => e.placement === 'global').length;
const universe = new Set([
  ...entries.filter((e) => e.placement === 'socket-owner').map((e) => e.name),
  ...pinned,
]);

console.log(`pinned ${pinned.length}/${universe.size}`);
console.log(`socket-owner ${socketOwnerCount}`);
console.log(`global ${globalCount}`);
console.log(`clean socket-owner (flip candidates): ${[...cleanSocketOwner].sort().join(' ')}`);
console.log(`frontier importers: ${[...frontier].sort().join(' ')}`);
