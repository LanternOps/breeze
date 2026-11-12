import { access, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const DENIED = 'API local backup storage is unavailable for this destination. Configure an operator-managed BACKUP_LOCAL_ROOT.';

function contained(base: string, target: string): boolean {
  const path = relative(base, target);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function boundedAbsolutePath(value: string): boolean {
  return isAbsolute(value) && value.length <= 4096 && !value.includes('\0') &&
    value.split(sep).length <= 64;
}

/** API-host storage is an explicit operator capability, separate from endpoint paths. */
export async function resolveApiLocalBackupPath(destination: string, key = '', orgId?: string, configId?: string): Promise<string> {
  if (!orgId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(orgId)) throw new Error(DENIED);
  if (!configId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(configId)) throw new Error(DENIED);
  const configured = process.env.BACKUP_LOCAL_ROOT;
  if (!configured || !boundedAbsolutePath(configured)) throw new Error(DENIED);
  const base = resolve(configured);
  const organizationRoot = resolve(base, orgId);
  // Endpoint settings do not confer host filesystem authority.
  const root = resolve(organizationRoot, configId);
  void destination;
  // A destination cannot own the operator root, or the filesystem root itself.
  if (base === dirname(base) || root === organizationRoot || !contained(organizationRoot, root)) throw new Error(DENIED);
  const target = resolve(root, key);
  if (!contained(root, target) || !boundedAbsolutePath(target)) throw new Error(DENIED);

  try {
    const canonicalBase = await realpath(base);
    if (!(await lstat(root)).isDirectory()) throw new Error(DENIED);
    // Reject links anywhere below the operator root, including an existing leaf.
    // Missing suffixes are allowed for artifact publication and absent-object reads.
    let current = base;
    for (const component of relative(base, target).split(sep).filter(Boolean)) {
      current = resolve(current, component);
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error(DENIED);
        if (!contained(canonicalBase, await realpath(current))) throw new Error(DENIED);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
    }
    return target;
  } catch {
    throw new Error(DENIED);
  }
}

export async function probeApiLocalBackupDestination(destination: string, orgId: string, configId: string): Promise<void> {
  const path = await resolveApiLocalBackupPath(destination, '', orgId, configId);
  // Inspect existing storage only; the probe never creates a directory or file.
  try { await access(path, constants.R_OK | constants.W_OK); } catch { throw new Error(DENIED); }
}
