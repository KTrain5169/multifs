import type {
  AllStat,
  DirectoryListing,
  DriverInterface,
  FileWatchListener,
  MultipartUpload,
  UploadedMultiparts,
  Watcher,
} from "../types.ts";
import { createS3Driver } from "../internal/s3.ts";

interface WatchEntry {
  listeners: Set<FileWatchListener>;
}

export interface R2StringChecksumsLike {
  sha1?: string;
  sha256?: string;
  sha512?: string;
}

export interface R2ObjectLike {
  key: string;
  checksums?: { toJSON(): R2StringChecksumsLike };
}

export interface R2MultipartUploadLike {
  uploadId: string;
  uploadPart(partNumber: number, value: ArrayBuffer): Promise<{ partNumber: number; etag: string }>;
  abort(): Promise<void>;
  complete(uploadedParts: Array<{ partNumber: number; etag: string }>): Promise<unknown>;
}

export interface R2BucketLike {
  head(key: string): Promise<R2ObjectLike | null>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, value: ArrayBuffer): Promise<unknown>;
  delete(key: string | string[]): Promise<void>;
  list(options: { prefix?: string; delimiter?: string; cursor?: string }): Promise<{
    objects: R2ObjectLike[];
    delimitedPrefixes?: string[];
    truncated?: boolean;
    cursor?: string;
  }>;
  createMultipartUpload(key: string, options?: unknown): Promise<R2MultipartUploadLike>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUploadLike;
}

export function R2Binding<const TRawBucket extends R2BucketLike>(
  bucket: TRawBucket,
): DriverInterface<TRawBucket> {
  const watchEntries = new Map<string, WatchEntry>();
  const activeUploads = new Map<
    string,
    {
      filePath: string;
      upload: R2MultipartUploadLike;
      nextPartNumber: number;
    }
  >();

  function toKey(filePath: string): string {
    return filePath.replace(/^\/+/, "");
  }

  function toChecksums(object: { checksums?: { toJSON(): R2StringChecksumsLike } }): AllStat {
    const stringChecksums = object.checksums?.toJSON();
    return {
      type: "file",
      checksums: {
        sha1: stringChecksums?.sha1 ?? "",
        sha256: stringChecksums?.sha256 ?? "",
        sha512: stringChecksums?.sha512 ?? "",
      },
    };
  }

  return {
    name: "cloudflare-r2-binding",
    raw: bucket,

    async read(filePath) {
      const object = await bucket.get(toKey(filePath));
      if (!object) return undefined;
      return new Blob([await object.arrayBuffer()]);
    },

    async write(filePath, contents) {
      await bucket.put(toKey(filePath), await contents.arrayBuffer());
    },

    async delete(filePath) {
      await bucket.delete(toKey(filePath));
    },

    async stat(filePath) {
      const object = await bucket.head(toKey(filePath));
      if (!object) {
        throw new Error(`File not found: ${filePath}`);
      }
      return toChecksums(object);
    },

    async ls(dir) {
      const prefix = dir === "/" ? "" : `${dir.replace(/^\//, "").replace(/\/$/, "")}/`;
      const listing: DirectoryListing = {};
      let cursor: string | undefined;
      do {
        const result = await bucket.list({ prefix, delimiter: "/", cursor });
        for (const object of result.objects) {
          if (!object.key.startsWith(prefix)) continue;
          const name = object.key.slice(prefix.length);
          if (!name || name.endsWith("/")) continue;
          listing[name] = toChecksums(object);
        }
        for (const commonPrefix of result.delimitedPrefixes ?? []) {
          const name = commonPrefix.slice(prefix.length).replace(/\/$/, "");
          if (!name) continue;
          listing[name] = { type: "folder", children: {} };
        }
        cursor = result.truncated ? result.cursor : undefined;
      } while (cursor);
      return listing;
    },

    watch(path, listener): Watcher {
      let entry = watchEntries.get(path);
      if (!entry) {
        entry = { listeners: new Set() };
        watchEntries.set(path, entry);
      }
      entry.listeners.add(listener);
      return {
        listener,
        stop() {
          const current = watchEntries.get(path);
          if (!current) return;
          current.listeners.delete(listener);
          if (current.listeners.size === 0) {
            watchEntries.delete(path);
          }
        },
      };
    },

    unwatch(path) {
      watchEntries.delete(path);
    },

    async createMultipartUpload(filePath): Promise<MultipartUpload> {
      const key = toKey(filePath);
      const upload = await bucket.createMultipartUpload(key);
      activeUploads.set(upload.uploadId, { filePath: key, upload, nextPartNumber: 1 });
      return {
        filePath,
        uploadId: upload.uploadId,
        async uploadPart(partNumber: number, value: Blob): Promise<UploadedMultiparts> {
          const uploaded = await upload.uploadPart(partNumber, await value.arrayBuffer());
          const record = activeUploads.get(upload.uploadId);
          if (record) {
            record.nextPartNumber = Math.max(record.nextPartNumber, partNumber + 1);
          }
          return { partNumber, etag: uploaded.etag };
        },
        async abort(): Promise<void> {
          await upload.abort();
        },
        async complete(uploadedParts: UploadedMultiparts[]): Promise<void> {
          await upload.complete(
            uploadedParts.map(({ partNumber, etag }) => ({ partNumber, etag })),
          );
        },
      };
    },

    async resumeMultipartUpload(uploadId, content) {
      const record = activeUploads.get(uploadId);
      if (!record) {
        throw new Error(`Unknown multipart upload ID "${uploadId}".`);
      }
      const resumed = bucket.resumeMultipartUpload(record.filePath, uploadId);
      const partNumber = record.nextPartNumber++;
      await resumed.uploadPart(partNumber, await content.arrayBuffer());
    },

    dispose() {
      watchEntries.clear();
      activeUploads.clear();
    },
  };
}

export interface R2HTTPOptions {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function R2HTTP(accountId: string, options: R2HTTPOptions): DriverInterface<R2HTTPOptions> {
  const driver = createS3Driver({
    ...options,
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  });
  return { ...driver, name: "cloudflare-r2-http", raw: options };
}
