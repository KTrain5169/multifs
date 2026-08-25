import type {
  AllStat,
  DirectoryListing,
  DriverInterface,
  FileWatchListener,
  MultipartUpload,
  UploadedMultiparts,
  Watcher,
} from "../types.ts";

export interface VercelBlobOptions {
  token: string;
  apiURL?: string;
}

interface VercelBlobObject {
  url: string;
  pathname: string;
  size?: number;
  uploadedAt?: string;
}

const DEFAULT_API_URL = "https://blob.vercel-storage.com";

export function vercelBlob(options: VercelBlobOptions): DriverInterface<VercelBlobOptions> {
  const apiURL = (options.apiURL ?? DEFAULT_API_URL).replace(/\/$/, "");
  const urlCache = new Map<string, string>();
  const activeUploads = new Map<string, { pathname: string; nextPartNumber: number }>();

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${options.token}`, ...extra };
  }

  function cleanPath(pathname: string): string {
    return pathname.replace(/^\/+/, "");
  }

  function encodedPath(pathname: string): string {
    return cleanPath(pathname).split("/").filter(Boolean).map(encodeURIComponent).join("/");
  }

  async function resolveUrl(pathname: string): Promise<string> {
    let url = urlCache.get(pathname);
    if (!url) {
      url = `${apiURL}/${encodedPath(pathname)}`;
      urlCache.set(pathname, url);
    }
    return url;
  }

  function emptyChecksums(): AllStat {
    return { type: "file", checksums: { sha1: "", sha256: "", sha512: "" } };
  }

  function inertWatcher(): Watcher {
    return {
      listener: () => {},
      stop() {},
    };
  }

  return {
    name: "vercel-blob",
    raw: options,

    async read(filePath) {
      const response = await fetch(await resolveUrl(filePath), { headers: headers() });
      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new Error(`Vercel Blob read failed with status ${response.status}`);
      }
      return new Blob([await response.arrayBuffer()]);
    },

    async write(filePath, contents, writeOptions) {
      const allowOverwrite = writeOptions?.recursive === false ? "false" : "true";
      const response = await fetch(
        `${apiURL}/${encodedPath(filePath)}?pathname=${encodeURIComponent(cleanPath(filePath))}`,
        {
          method: "PUT",
          headers: headers({
            "x-add-random-suffix": "false",
            "x-allow-overwrite": allowOverwrite,
            "x-content-type": contents.type || "application/octet-stream",
          }),
          body: contents,
        },
      );
      if (!response.ok) {
        throw new Error(`Vercel Blob write failed with status ${response.status}`);
      }
      const payload = (await response.json()) as { url?: string };
      if (payload.url) {
        urlCache.set(filePath, payload.url);
      }
    },

    async delete(filePath) {
      const urls = [await resolveUrl(filePath)];
      const response = await fetch(`${apiURL}/delete`, {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ urls }),
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`Vercel Blob delete failed with status ${response.status}`);
      }
    },

    async stat(filePath) {
      const url = await resolveUrl(filePath);
      const response = await fetch(`${apiURL}/head?${new URLSearchParams({ url }).toString()}`, {
        headers: headers(),
      });
      if (response.status === 404) {
        throw new Error(`File not found: ${filePath}`);
      }
      if (!response.ok) {
        throw new Error(`Vercel Blob stat failed with status ${response.status}`);
      }
      return emptyChecksums();
    },

    async ls(dir) {
      const prefix = dir === "/" ? "" : `${dir.replace(/^\//, "").replace(/\/$/, "")}/`;
      const listing: DirectoryListing = {};
      let cursor: string | undefined;
      do {
        const params = new URLSearchParams({ limit: "1000", mode: "expanded", prefix });
        if (cursor) params.set("cursor", cursor);
        const response = await fetch(`${apiURL}?${params.toString()}`, { headers: headers() });
        if (!response.ok) {
          throw new Error(`Vercel Blob list failed with status ${response.status}`);
        }
        const payload = (await response.json()) as {
          blobs?: VercelBlobObject[];
          cursor?: string;
          hasMore?: boolean;
        };
        for (const blob of payload.blobs ?? []) {
          urlCache.set(blob.pathname, blob.url);
          if (!blob.pathname.startsWith(prefix)) continue;
          const relative = blob.pathname.slice(prefix.length);
          const [firstSegment, ...rest] = relative.split("/");
          if (!firstSegment) continue;
          if (rest.length > 0) {
            listing[firstSegment] ??= { type: "folder", children: {} };
          } else {
            listing[firstSegment] = emptyChecksums();
          }
        }
        cursor = payload.hasMore ? payload.cursor : undefined;
      } while (cursor);
      return listing;
    },

    watch(_path, _listener: FileWatchListener): Watcher {
      return inertWatcher();
    },

    unwatch() {},

    async createMultipartUpload(filePath): Promise<MultipartUpload> {
      const response = await fetch(
        `${apiURL}/mpu?pathname=${encodeURIComponent(cleanPath(filePath))}`,
        {
          method: "POST",
          headers: headers({ "content-type": "application/json" }),
          body: JSON.stringify({ pathname: filePath }),
        },
      );
      if (!response.ok) {
        throw new Error(`Vercel Blob multipart creation failed with status ${response.status}`);
      }
      const payload = (await response.json()) as { uploadId?: string };
      const uploadId = payload.uploadId ?? "";
      activeUploads.set(uploadId, { pathname: filePath, nextPartNumber: 1 });

      return {
        filePath,
        uploadId,
        async uploadPart(partNumber, value): Promise<UploadedMultiparts> {
          const partResponse = await fetch(
            `${apiURL}/mpu/${encodeURIComponent(uploadId)}/${partNumber}?pathname=${encodeURIComponent(cleanPath(filePath))}`,
            {
              method: "PUT",
              headers: headers({ "x-content-type": value.type || "application/octet-stream" }),
              body: value,
            },
          );
          if (!partResponse.ok) {
            throw new Error(`Vercel Blob part upload failed with status ${partResponse.status}`);
          }
          const record = activeUploads.get(uploadId);
          if (record) {
            record.nextPartNumber = Math.max(record.nextPartNumber, partNumber + 1);
          }
          const partPayload = (await partResponse.json()) as { etag?: string };
          return { partNumber, etag: partPayload.etag ?? "" };
        },
        async abort(): Promise<void> {
          const abortResponse = await fetch(`${apiURL}/mpu/${encodeURIComponent(uploadId)}/abort`, {
            method: "POST",
            headers: headers({ "content-type": "application/json" }),
            body: JSON.stringify({ pathname: filePath, uploadId }),
          });
          if (!abortResponse.ok) {
            throw new Error(
              `Vercel Blob multipart abort failed with status ${abortResponse.status}`,
            );
          }
        },
        async complete(uploadedParts: UploadedMultiparts[]): Promise<void> {
          const completeResponse = await fetch(
            `${apiURL}/mpu/${encodeURIComponent(uploadId)}/complete`,
            {
              method: "POST",
              headers: headers({ "content-type": "application/json" }),
              body: JSON.stringify({
                pathname: filePath,
                parts: uploadedParts.map(({ partNumber, etag }) => ({ number: partNumber, etag })),
              }),
            },
          );
          if (!completeResponse.ok) {
            throw new Error(
              `Vercel Blob multipart completion failed with status ${completeResponse.status}`,
            );
          }
          const completed = (await completeResponse.json()) as { url?: string; pathname?: string };
          if (completed.url && completed.pathname) {
            urlCache.set(completed.pathname, completed.url);
          }
        },
      };
    },

    async resumeMultipartUpload(uploadId, content) {
      const record = activeUploads.get(uploadId);
      if (!record) {
        throw new Error(`Unknown multipart upload ID "${uploadId}".`);
      }
      const partNumber = record.nextPartNumber++;
      const partResponse = await fetch(
        `${apiURL}/mpu/${encodeURIComponent(uploadId)}/${partNumber}?pathname=${encodeURIComponent(cleanPath(record.pathname))}`,
        {
          method: "PUT",
          headers: headers({ "x-content-type": content.type || "application/octet-stream" }),
          body: content,
        },
      );
      if (!partResponse.ok) {
        throw new Error(`Vercel Blob multipart resume failed with status ${partResponse.status}`);
      }
    },

    dispose() {
      urlCache.clear();
      activeUploads.clear();
    },
  };
}
