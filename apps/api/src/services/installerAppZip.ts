import archiver from 'archiver';
import StreamZip from 'node-stream-zip';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface RenameAppInZipOpts {
  oldAppName: string;  // e.g. "Breeze Installer.app"
  newAppName: string;  // e.g. "Breeze Installer [A7K2XQ@us.2breeze.app].app"
}

/**
 * Walks every entry in `sourceZip` and rewrites its path so that the
 * leading `oldAppName` directory becomes `newAppName`. Entry contents
 * are preserved byte-for-byte — this is just a metadata rewrite.
 *
 * The Mac code signature lives inside `Contents/_CodeSignature/` and
 * is hashed from `Contents/` contents, NOT the bundle's own directory
 * name. Renaming the top-level folder leaves both `codesign --verify`
 * and `xcrun stapler validate` passing.
 *
 * Throws if no entry begins with `oldAppName/` — guards against feeding
 * in the wrong fixture (e.g. a release where the build output renamed
 * its top-level directory).
 */
export async function renameAppInZip(
  sourceZip: Buffer,
  opts: RenameAppInZipOpts,
): Promise<Buffer> {
  const workDir = await mkdtemp(join(tmpdir(), 'installer-app-zip-'));
  const inputPath = join(workDir, 'in.zip');
  await writeFile(inputPath, sourceZip);
  try {
    const reader = new StreamZip.async({ file: inputPath });
    const entries = await reader.entries();
    let matched = 0;

    const out = archiver('zip', { zlib: { level: 0 } }); // store-only; .app contents already small or pre-compressed
    const chunks: Buffer[] = [];
    out.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((resolve, reject) => {
      out.on('end', () => resolve());
      out.on('error', reject);
    });

    for (const entry of Object.values(entries)) {
      const oldPrefix = `${opts.oldAppName}/`;
      let newPath = entry.name;
      if (entry.name === opts.oldAppName) {
        newPath = opts.newAppName;
        matched++;
      } else if (entry.name.startsWith(oldPrefix)) {
        newPath = opts.newAppName + entry.name.slice(opts.oldAppName.length);
        matched++;
      }
      if (entry.isDirectory) {
        out.append('', { name: newPath, mode: entry.attr });
      } else {
        const data = await reader.entryData(entry.name);
        out.append(data, { name: newPath, mode: entry.attr });
      }
    }
    await reader.close();

    if (matched === 0) {
      throw new Error(
        `installerAppZip: no entries matched old app name "${opts.oldAppName}" — wrong fixture?`,
      );
    }

    await out.finalize();
    await done;
    return Buffer.concat(chunks);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
