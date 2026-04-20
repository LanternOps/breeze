import { describe, it, expect } from 'vitest';
import archiver from 'archiver';
import StreamZip from 'node-stream-zip';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renameAppInZip } from './installerAppZip';

/** Build a fixture zip containing a fake `.app` directory. */
async function buildFixtureZip(appName: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 0 } });
    const chunks: Buffer[] = [];
    archive.on('data', (c: Buffer) => chunks.push(c));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);

    archive.append('fake-binary', { name: `${appName}/Contents/MacOS/BreezeInstaller`, mode: 0o755 });
    archive.append('<plist/>', { name: `${appName}/Contents/Info.plist` });
    archive.append('codesign-data', { name: `${appName}/Contents/_CodeSignature/CodeResources` });
    archive.append('pkg-bytes', { name: `${appName}/Contents/Resources/breeze-agent-amd64.pkg` });
    archive.append('pkg-bytes', { name: `${appName}/Contents/Resources/breeze-agent-arm64.pkg` });
    archive.finalize().catch(reject);
  });
}

async function listEntries(zipBuf: Buffer): Promise<string[]> {
  const tmp = join(tmpdir(), `installer-zip-test-${Date.now()}.zip`);
  await writeFile(tmp, zipBuf);
  try {
    const z = new StreamZip.async({ file: tmp });
    const entries = Object.keys(await z.entries());
    await z.close();
    return entries.sort();
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

describe('renameAppInZip', () => {
  it('renames the app directory in every entry path', async () => {
    const input = await buildFixtureZip('Breeze Installer.app');
    const out = await renameAppInZip(input, {
      oldAppName: 'Breeze Installer.app',
      newAppName: 'Breeze Installer [A7K2XQ@us.2breeze.app].app',
    });
    const entries = await listEntries(out);
    expect(entries).toEqual([
      'Breeze Installer [A7K2XQ@us.2breeze.app].app/Contents/Info.plist',
      'Breeze Installer [A7K2XQ@us.2breeze.app].app/Contents/MacOS/BreezeInstaller',
      'Breeze Installer [A7K2XQ@us.2breeze.app].app/Contents/Resources/breeze-agent-amd64.pkg',
      'Breeze Installer [A7K2XQ@us.2breeze.app].app/Contents/Resources/breeze-agent-arm64.pkg',
      'Breeze Installer [A7K2XQ@us.2breeze.app].app/Contents/_CodeSignature/CodeResources',
    ]);
  });

  it('preserves entry contents byte-for-byte', async () => {
    const input = await buildFixtureZip('Breeze Installer.app');
    const out = await renameAppInZip(input, {
      oldAppName: 'Breeze Installer.app',
      newAppName: 'Breeze Installer [BBBBBB@host.local].app',
    });
    const tmp = join(tmpdir(), `installer-zip-content-${Date.now()}.zip`);
    await writeFile(tmp, out);
    const z = new StreamZip.async({ file: tmp });
    const data = await z.entryData('Breeze Installer [BBBBBB@host.local].app/Contents/Info.plist');
    await z.close();
    await unlink(tmp);
    expect(data.toString()).toBe('<plist/>');
  });

  it('throws if no entry matches the old app name', async () => {
    const input = await buildFixtureZip('Different.app');
    await expect(
      renameAppInZip(input, {
        oldAppName: 'Breeze Installer.app',
        newAppName: 'Breeze Installer [A7K2XQ@x.example].app',
      }),
    ).rejects.toThrow(/no entries matched/i);
  });
});
