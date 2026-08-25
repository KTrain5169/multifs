import type {
  AllStat,
  DirectoryListing,
  DriverInterface,
  FileWatchListener,
  Watcher,
} from "../types.ts";

export interface NetlifyBlobsOptions {
  siteID?: string;
  token?: string;
  apiURL?: string;
}

interface NetlifyBlobEntry {
  key: string;
  etag?: string;
  last_modified?: string;
  size?: number;
}

function envBlobsContext(): { url: string; token: string } | null {
  const raw =
    typeof process !== "undefined" && process.env ? process.env.NETLIFY_BLOBS_CONTEXT : undefined;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { url?: string; token?: string };
    if (parsed.url && parsed.token) {
      return { url: parsed.url, token: parsed.token };
    }
  } catch {
    return null;
  }
  return null;
}

export function netlifyBlobs(
  storeName: string,
  options: NetlifyBlobsOptions = {},
): DriverInterface<NetlifyBlobsOptions & { storeName: string }> {
  const context = envBlobsContext();
  const token = options.token ?? context?.token;
  let baseURL: string;
  if (context) {
    baseURL = `${context.url.replace(/\/$/, "")}/${storeName}`;
  } else {
    if (!options.siteID || !token) {
      throw new Error(
        `The netlify driver requires either a Netlify runtime context or an explicit "siteID" and "token".`,
      );
    }
    const apiURL = options.apiURL ?? "https://api.netlify.com";
    baseURL = `${apiURL.replace(/\/$/, "")}/api/v1/blobs/site-${options.siteID}/${storeName}`;
  }

  function encodedSegments(filePath: string): string {
    return filePath
      .replace(/^\/+/, "")
      .split("/")
      .filter(Boolean)
      .map(encodeURIComponent)
      .join("/");
  }

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const requestHeaders: Record<string, string> = token
      ? { authorization: `Bearer ${token}` }
      : {};
    if (init.headers) {
      for (const [name, value] of new Headers(init.headers)) {
        requestHeaders[name] = value;
      }
    }
    return fetch(`${baseURL}/${path}`, { ...init, headers: requestHeaders });
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
    name: "netlify-blobs",
    raw: { storeName, ...options },

    async read(filePath) {
      const response = await request(encodedSegments(filePath));
      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new Error(`Netlify Blobs read failed with status ${response.status}`);
      }
      return new Blob([await response.arrayBuffer()]);
    },

    async write(filePath, contents, _writeOptions) {
      const response = await request(encodedSegments(filePath), {
        method: "PUT",
        body: contents,
        headers: { "content-type": contents.type || "application/octet-stream" },
      });
      if (!response.ok) {
        throw new Error(`Netlify Blobs write failed with status ${response.status}`);
      }
    },

    async delete(filePath) {
      const response = await request(encodedSegments(filePath), {
        method: "DELETE",
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`Netlify Blobs delete failed with status ${response.status}`);
      }
    },

    async stat(filePath) {
      const params = new URLSearchParams({ metadata: "true" });
      const response = await request(`${encodedSegments(filePath)}?${params.toString()}`);
      if (response.status === 404) {
        throw new Error(`File not found: ${filePath}`);
      }
      if (!response.ok) {
        throw new Error(`Netlify Blobs stat failed with status ${response.status}`);
      }
      return emptyChecksums();
    },

    async ls(dir) {
      const directory = dir === "/" ? "" : dir.replace(/^\//, "").replace(/\/$/, "");
      const listing: DirectoryListing = {};
      let cursor: string | undefined;
      do {
        const params = new URLSearchParams({ delimiter: "/" });
        if (directory) params.set("directory", `${directory}/`);
        if (cursor) params.set("cursor", cursor);
        const response = await request(`?${params.toString()}`);
        if (!response.ok) {
          throw new Error(`Netlify Blobs list failed with status ${response.status}`);
        }
        const payload = (await response.json()) as {
          blobs?: NetlifyBlobEntry[];
          directories?: string[];
          cursor?: string;
          next_cursor?: string;
        };
        for (const blob of payload.blobs ?? []) {
          listing[blob.key] = emptyChecksums();
        }
        for (const directoryName of payload.directories ?? []) {
          listing[directoryName.replace(/\/$/, "")] = { type: "folder", children: {} };
        }
        cursor = payload.next_cursor ?? (payload.cursor || undefined);
      } while (cursor);
      return listing;
    },

    watch(_path, _listener: FileWatchListener): Watcher {
      return inertWatcher();
    },

    unwatch() {},

    dispose() {},
  };
}
