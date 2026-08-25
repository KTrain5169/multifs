import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vite-plus/test";

import { MultiFS } from "../src/index.ts";
import type { DirectoryListing, DriverInterface, MultipartUpload } from "../src/types.ts";

export async function waitFor(
  condition: () => boolean,
  timeoutMs = 5000,
  label = "condition",
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

export type FetchHandler = (request: RecordedRequest) => Response | Promise<Response>;

async function bodyBytes(body: unknown): Promise<Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (body instanceof Uint8Array) return body;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new TypeError("Unsupported mock fetch body type");
}

export function stubFetch(handler: FetchHandler): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
    let url: string;
    let method: string;
    let rawHeaders: Record<string, string>;
    let rawBody: unknown;
    if (typeof input === "string" || input instanceof URL) {
      url = String(input);
      method = init?.method ?? "GET";
      rawHeaders = Object.fromEntries(new Headers(init?.headers ?? {}));
      rawBody = init?.body;
    } else {
      const request = input as Request;
      url = request.url;
      method = request.method;
      rawHeaders = Object.fromEntries(request.headers);
      rawBody = await request.arrayBuffer();
    }
    const recorded: RecordedRequest = { url, method, headers: rawHeaders };
    requests.push(recorded);
    recorded.body = await bodyBytes(rawBody);
    return handler(recorded);
  });
  vi.stubGlobal("fetch", fetchMock);
  return requests;
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function textResponse(
  text: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(text, { status, headers });
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface RecordingDriverOptions {
  name?: string;
  withMultipart?: boolean;
}

export interface DriverRecorder {
  reads: string[];
  writes: Array<{ path: string; size: number; options: unknown }>;
  deletes: string[];
  watches: string[];
  unwatches: string[];
  disposed: number;
  stoppedWatchers: number[];
  completedUploads: string[][];
  abortedUploads: string[];
  resumedUploads: string[];
}

export function makeRecorder(): DriverRecorder {
  return {
    reads: [],
    writes: [],
    deletes: [],
    watches: [],
    unwatches: [],
    disposed: 0,
    stoppedWatchers: [],
    completedUploads: [],
    abortedUploads: [],
    resumedUploads: [],
  };
}

export function recordingDriver(
  recorder: DriverRecorder,
  options: RecordingDriverOptions = {},
): DriverInterface<DriverRecorder> {
  let nextId = 0;
  const driver: DriverInterface<DriverRecorder> = {
    name: options.name ?? "recording",
    raw: recorder,
    read(filePath) {
      recorder.reads.push(filePath);
      return Promise.resolve(new Blob(["recorded"]));
    },
    write(filePath, contents, writeOptions) {
      recorder.writes.push({ path: filePath, size: contents.size, options: writeOptions });
      return Promise.resolve();
    },
    delete(filePath) {
      recorder.deletes.push(filePath);
      return Promise.resolve();
    },
    ls() {
      return Promise.resolve({} as DirectoryListing);
    },
    stat(_filePath) {
      return Promise.resolve({ type: "file", checksums: { sha1: "", sha256: "", sha512: "" } });
    },
    watch(filePath, listener) {
      recorder.watches.push(filePath);
      const id = recorder.watches.length;
      return {
        listener,
        stop() {
          recorder.stoppedWatchers.push(id);
        },
      };
    },
    unwatch(filePath) {
      recorder.unwatches.push(filePath);
    },
    dispose() {
      recorder.disposed += 1;
    },
  };

  if (options.withMultipart) {
    driver.createMultipartUpload = (filePath) => {
      const uploadId = `upload-${++nextId}`;
      return Promise.resolve({
        filePath,
        uploadId,
        uploadPart: () => Promise.resolve({ partNumber: 0, etag: "" }),
        abort: () => {
          recorder.abortedUploads.push(uploadId);
          return Promise.resolve();
        },
        complete: (uploadedParts) => {
          recorder.completedUploads.push(uploadedParts.map((p) => `${p.partNumber}:${p.etag}`));
          return Promise.resolve();
        },
      } satisfies MultipartUpload);
    };
    driver.resumeMultipartUpload = (uploadId) => {
      recorder.resumedUploads.push(uploadId);
      return Promise.resolve();
    };
  }

  return driver;
}

export interface LocalFsHandle {
  fs: MultiFS<unknown>;
  cleanup: () => Promise<void>;
}

export type LocalFsFactory = () => Promise<LocalFsHandle>;

export async function createNodeFs(): Promise<LocalFsHandle> {
  const root = await mkdtemp(join(tmpdir(), "multifs-"));
  const { node } = await import("../src/drivers/node.ts");
  return {
    fs: new MultiFS(root, node(root)),
    cleanup: async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

export async function createMemoryFs(): Promise<LocalFsHandle> {
  const { memory } = await import("../src/drivers/memory.ts");
  return {
    fs: new MultiFS(memory()),
    cleanup: async () => {},
  };
}
