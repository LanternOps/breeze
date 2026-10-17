/**
 * An in-memory S3 bucket store for integration tests, plugged into
 * services/backupSnapshotStorage.ts through `__setBackupS3ClientFactoryForTests`.
 * Implements the three commands storage GC sends (ListObjectsV2, GetObject,
 * DeleteObjects) and records every call, so a test can assert exactly which
 * prefixes were listed and which keys were deleted.
 */
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

export type InMemoryS3Call =
  | { op: 'list'; bucket: string; prefix: string }
  | { op: 'get'; bucket: string; key: string }
  | { op: 'delete'; bucket: string; keys: string[] };

type StoredObject = { body: string; lastModified: Date };

export class InMemoryS3 {
  private readonly buckets = new Map<string, Map<string, StoredObject>>();
  readonly calls: InMemoryS3Call[] = [];

  put(bucket: string, key: string, body: string, lastModified: Date): void {
    let objects = this.buckets.get(bucket);
    if (!objects) {
      objects = new Map();
      this.buckets.set(bucket, objects);
    }
    objects.set(key, { body, lastModified });
  }

  keys(bucket: string): string[] {
    return [...(this.buckets.get(bucket)?.keys() ?? [])].sort();
  }

  callsFor(bucket: string): InMemoryS3Call[] {
    return this.calls.filter((c) => c.bucket === bucket);
  }

  /** A client whose `send` answers from this store, for any bucket. */
  client(): { send(command: unknown): Promise<unknown> } {
    return { send: async (command: unknown) => this.send(command) };
  }

  private async send(command: unknown): Promise<unknown> {
    if (command instanceof ListObjectsV2Command) {
      const bucket = String(command.input.Bucket);
      const prefix = command.input.Prefix ?? '';
      this.calls.push({ op: 'list', bucket, prefix });
      const contents = this.keys(bucket)
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ Key: key, LastModified: this.buckets.get(bucket)!.get(key)!.lastModified }));
      return { Contents: contents, IsTruncated: false };
    }
    if (command instanceof GetObjectCommand) {
      const bucket = String(command.input.Bucket);
      const key = String(command.input.Key);
      this.calls.push({ op: 'get', bucket, key });
      const object = this.buckets.get(bucket)?.get(key);
      if (!object) throw Object.assign(new Error(`NoSuchKey: ${key}`), { name: 'NoSuchKey' });
      return {
        ContentLength: Buffer.byteLength(object.body, 'utf8'),
        Body: { transformToString: async () => object.body },
      };
    }
    if (command instanceof DeleteObjectsCommand) {
      const bucket = String(command.input.Bucket);
      const keys = (command.input.Delete?.Objects ?? []).map((o) => String(o.Key));
      this.calls.push({ op: 'delete', bucket, keys });
      for (const key of keys) this.buckets.get(bucket)?.delete(key);
      return { Errors: [] };
    }
    throw new Error(`InMemoryS3: unsupported command ${(command as { constructor?: { name?: string } })?.constructor?.name}`);
  }
}
