// apps/api/src/services/agentPresence.ts
import { getRedis } from './redis';

// Fenced presence leases for agent WebSockets (wave 3.5b, #4084).
// A lease is an ADMISSION HINT for the command relay — the socket-owning
// process's in-memory map stays authoritative. Fencing: every mutation is
// token-guarded server-side (Lua), so an old socket's delayed onClose can
// never delete a newer connection's lease.
const PRESENCE_KEY_PREFIX = 'agent-presence:';
export const AGENT_PRESENCE_TTL_MS = 90_000;

export interface AgentPresenceLease {
  instanceId: string;
  connectionToken: string;
}

// Runs server-side in Redis (ioredis Lua API, not JS eval); token comes in as
// ARGV, never interpolated into the script.
const REFRESH_IF_TOKEN_MATCHES_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, lease = pcall(cjson.decode, raw)
if not ok or lease.connectionToken ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;

const DELETE_IF_TOKEN_MATCHES_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, lease = pcall(cjson.decode, raw)
if not ok or lease.connectionToken ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

function presenceKey(agentId: string): string {
  return `${PRESENCE_KEY_PREFIX}${agentId}`;
}

export async function setAgentPresence(agentId: string, lease: AgentPresenceLease): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    // Unconditional SET: onOpen installs the newest socket as authoritative
    // (mirrors the activeConnections/epoch model), so the newest lease wins.
    await redis.set(presenceKey(agentId), JSON.stringify(lease), 'PX', AGENT_PRESENCE_TTL_MS);
  } catch (err) {
    console.warn(`[AgentPresence] set failed for ${agentId.slice(0, 12)}:`, err);
  }
}

export async function refreshAgentPresence(agentId: string, connectionToken: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    const res = await redis.eval(
      REFRESH_IF_TOKEN_MATCHES_LUA, 1, presenceKey(agentId), connectionToken, String(AGENT_PRESENCE_TTL_MS),
    );
    return res === 1;
  } catch (err) {
    console.warn(`[AgentPresence] refresh failed for ${agentId.slice(0, 12)}:`, err);
    return false;
  }
}

export async function clearAgentPresence(agentId: string, connectionToken: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    const res = await redis.eval(DELETE_IF_TOKEN_MATCHES_LUA, 1, presenceKey(agentId), connectionToken);
    return res === 1;
  } catch (err) {
    console.warn(`[AgentPresence] clear failed for ${agentId.slice(0, 12)}:`, err);
    return false;
  }
}

/**
 * Unconditional delete — no token fencing. Used only from `evictAgentSocket`
 * (module-level in agentWs.ts), which has no `connectionToken` in scope. The
 * pong-branch self-heal in the WS lifecycle bounds the collateral window: a
 * reconnect racing this delete re-establishes its lease on its next pong.
 */
export async function clearAgentPresenceUnfenced(agentId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(presenceKey(agentId));
  } catch (err) {
    console.warn(`[AgentPresence] unfenced clear failed for ${agentId.slice(0, 12)}:`, err);
  }
}

export async function readAgentPresence(agentId: string): Promise<AgentPresenceLease | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(presenceKey(agentId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AgentPresenceLease;
    if (typeof parsed?.instanceId !== 'string' || typeof parsed?.connectionToken !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}
