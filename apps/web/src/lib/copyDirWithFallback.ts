import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export interface CopyDirImpl {
  cpSync: (src: string, dest: string, opts: { recursive: true }) => void;
  rmSync: (path: string, opts: { recursive: true; force: true }) => void;
  execCp: (src: string, dest: string) => void;
}

const defaultImpl: CopyDirImpl = {
  cpSync: fs.cpSync,
  rmSync: fs.rmSync,
  execCp: (src, dest) => {
    execFileSync('cp', ['-R', src, dest]);
  },
};

// Recursively copy `src` to `dest`. Used by scripts/copy-monaco-assets.ts
// (run under node --experimental-strip-types, so keep this file strip-types safe).
export function copyDirWithFallback(src: string, dest: string, impl: CopyDirImpl = defaultImpl): void {
  try {
    impl.cpSync(src, dest, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EACCES') throw err;
    // colima/virtiofs bind mounts: native recursive cpSync throws EACCES (#9535). Drop the
    // partial copy and let `cp -R` create dest itself (an existing dest, or `src/.`, also fails there).
    impl.rmSync(dest, { recursive: true, force: true });
    impl.execCp(src, dest);
  }
}
