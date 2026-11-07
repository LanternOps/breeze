import { Readable } from 'node:stream';
import { defaultVerifyDeps, type AttestationVerifyDeps } from '../../services/backupAttestationVerify';
import { BackupObjectTooLargeError } from '../../services/backupSnapshotStorage';

type FetchObject = AttestationVerifyDeps['fetchObject'];

/**
 * The default verifier deps with every attested object served by `fetchObject`,
 * the manifest included. The verifier streams the manifest (#11026), so it is
 * handed over as a stream built from the same bytes, with the declared-length
 * check the real reader makes.
 */
export function verifyDepsFromBytes(fetchObject: FetchObject): AttestationVerifyDeps {
  return {
    ...defaultVerifyDeps,
    fetchObject,
    openObject: async (args) => {
      const bytes = await fetchObject(args);
      if (bytes.byteLength > args.maxBytes) throw new BackupObjectTooLargeError(args.key, bytes.byteLength, args.maxBytes);
      return Readable.from([Buffer.from(bytes)]);
    },
  };
}
