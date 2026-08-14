import archiver from "archiver";
import StreamZip from "node-stream-zip";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  INSTALLER_APP_NAME,
  INSTALLER_BOOTSTRAP_PAYLOAD_NAME,
  LEGACY_INSTALLER_APP_NAME,
  stampedInstallerAppName,
} from "./installerAppNaming";

export interface RenameAppInZipOpts {
  oldAppName: string; // e.g. "Nodes Unlimited Installer.app"
  newAppName: string; // e.g. "Nodes Unlimited Installer [A7K2XQ@rmm.example].app"
  extraFiles?: Array<{
    path: string;
    data: Buffer | string;
    mode?: number;
  }>;
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
  const workDir = await mkdtemp(join(tmpdir(), "installer-app-zip-"));
  const inputPath = join(workDir, "in.zip");
  await writeFile(inputPath, sourceZip);
  try {
    const reader = new StreamZip.async({ file: inputPath });
    const entries = await reader.entries();
    let matched = 0;

    const out = archiver("zip", { zlib: { level: 0 } }); // store-only; .app contents already small or pre-compressed
    const chunks: Buffer[] = [];
    out.on("data", (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((resolve, reject) => {
      out.on("end", () => resolve());
      out.on("error", reject);
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
      // node-stream-zip exposes external file attributes as a raw uint32
      // (Unix mode is in the high 16 bits, type+mode bits packed). archiver
      // expects a plain 9-bit Unix permission integer. Passing entry.attr
      // directly garbles the mode to 0 → unreadable directories ("zero-byte
      // .app" symptom). Extract perms or fall back to sane defaults.
      const unixMode = (entry.attr >>> 16) & 0o777;
      const mode = unixMode || (entry.isDirectory ? 0o755 : 0o644);
      if (entry.isDirectory) {
        out.append("", { name: newPath, mode });
      } else {
        const data = await reader.entryData(entry.name);
        out.append(data, { name: newPath, mode });
      }
    }
    for (const file of opts.extraFiles ?? []) {
      out.append(file.data, { name: file.path, mode: file.mode ?? 0o600 });
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

/**
 * Stamps a macOS installer zip with its enrollment token.
 *
 * The token is carried in TWO places by design:
 *   1. the app bundle's own filename — `Nodes Unlimited Installer [TOKEN@host].app`
 *   2. a sibling `Nodes Unlimited Installer.bootstrap.json`
 * The Swift installer prefers the JSON (FilenameTokenParser.load), but macOS
 * App Translocation copies ONLY the .app bundle to a randomized read-only path
 * when a quarantined app is launched in place — stranding the sibling JSON
 * (#2544). The bundle name travels through translocation, so the filename
 * fallback keeps the install working.
 *
 * Accepts a zip whose bundle carries either the current Nodes Unlimited name or
 * the pre-rebrand "Breeze Installer.app" name, so a release cut on either side
 * of the rebrand still yields a stamped (never silently unstamped) installer.
 */
export async function stampInstallerAppZip(
  sourceZip: Buffer,
  opts: { token: string; apiHost: string },
): Promise<Buffer> {
  const newAppName = stampedInstallerAppName(opts.token, opts.apiHost);
  const extraFiles = [
    {
      path: INSTALLER_BOOTSTRAP_PAYLOAD_NAME,
      data: JSON.stringify({ token: opts.token, apiHost: opts.apiHost }),
      mode: 0o600,
    },
  ];
  try {
    return await renameAppInZip(sourceZip, {
      oldAppName: INSTALLER_APP_NAME,
      newAppName,
      extraFiles,
    });
  } catch (err) {
    // Pre-rebrand release asset — retry with the legacy bundle name rather
    // than falling through to an unstamped installer.
    return await renameAppInZip(sourceZip, {
      oldAppName: LEGACY_INSTALLER_APP_NAME,
      newAppName,
      extraFiles,
    });
  }
}
