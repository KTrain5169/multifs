import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { R2Bucket } from "@cloudflare/workers-types";

import { R2Binding, R2HTTP } from "../src/drivers/cloudflare.ts";
import type { DriverInterface } from "../src/types.ts";
import { stubFetch } from "./helpers.ts";

function makeFakeBucket() {
  const store = new Map<string, Uint8Array>();
  const uploadPart = vi.fn(async (partNumber: number, _value: unknown) => ({
    partNumber,
    etag: `etag-${partNumber}`,
  }));
  const bucket = {
    async get(key: string) {
      const bytes = store.get(key);
      if (!bytes) return null;
      return {
        arrayBuffer: async () => bytes.slice().buffer,
      };
    },
    async put(key: string, value: ArrayBuffer | Uint8Array) {
      store.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
      return {} as never;
    },
    async delete(key: string) {
      store.delete(Array.isArray(key) ? key[0]! : key);
    },
    async head(key: string) {
      if (!store.has(key)) return null;
      return {
        key,
        checksums: {
          toJSON: () => ({ sha256: "cafe1234" }),
        },
      } as never;
    },
    async list(options: { prefix?: string; delimiter?: string }) {
      const prefix = options.prefix ?? "";
      const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
      const objects = keys.map((key) => ({ key, checksums: { toJSON: () => ({}) } }));
      return {
        objects,
        delimitedPrefixes: options.delimiter ? [`${prefix}sub/`] : [],
        truncated: false,
      } as never;
    },
    createMultipartUpload: vi.fn(async (_key: string) => ({
      uploadId: "mpu-1",
      uploadPart,
      abort: vi.fn(async () => {}),
      complete: vi.fn(async () => ({})),
    })),
    resumeMultipartUpload: vi.fn((_key: string, uploadId: string) => ({
      uploadId,
      uploadPart,
      abort: vi.fn(async () => {}),
      complete: vi.fn(async () => ({})),
    })),
  };
  return { bucket: bucket as unknown as R2Bucket, store, uploadPart };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("R2 binding driver", () => {
  it("round-trips content through the binding", async () => {
    const { bucket } = makeFakeBucket();
    const driver: DriverInterface<unknown> = R2Binding(bucket);

    await driver.write("/a/file.txt", new Blob(["r2-content"]));
    expect(await (await driver.read("/a/file.txt"))!.text()).toBe("r2-content");
    expect(await driver.read("/missing.txt")).toBeUndefined();
    await driver.delete("/a/file.txt");
    expect(await driver.read("/a/file.txt")).toBeUndefined();
  });

  it("stats objects with checksums and throws for missing keys", async () => {
    const { bucket } = makeFakeBucket();
    const driver = R2Binding(bucket);
    await driver.write("/known.txt", new Blob(["x"]));

    const statResult = await driver.stat("/known.txt");
    expect(statResult).toMatchObject({
      type: "file",
      checksums: { sha256: "cafe1234", sha1: "", sha512: "" },
    });
    await expect(driver.stat("/nope.txt")).rejects.toThrow("File not found");
  });

  it("lists files and synthesized folders", async () => {
    const { bucket } = makeFakeBucket();
    const driver = R2Binding(bucket);
    await driver.write("/top.txt", new Blob(["x"]));

    const listing = await driver.ls("/");
    expect(listing["top.txt"]).toMatchObject({ type: "file" });
    expect(listing.sub).toEqual({ type: "folder", children: {} });
  });

  it("supports multipart uploads including resume part numbering", async () => {
    const { bucket, uploadPart } = makeFakeBucket();
    const driver = R2Binding(bucket);

    const upload = await driver.createMultipartUpload!("/big.bin");
    expect(upload.uploadId).toBe("mpu-1");

    const part = await upload.uploadPart(1, new Blob(["one"]));
    expect(part).toEqual({ partNumber: 1, etag: "etag-1" });

    await driver.resumeMultipartUpload!("mpu-1", new Blob(["two"]));
    expect(uploadPart).toHaveBeenLastCalledWith(2, expect.anything());

    await expect(driver.resumeMultipartUpload!("bogus", new Blob(["x"]))).rejects.toThrow(
      "Unknown multipart upload ID",
    );
  });
});

describe("R2 HTTP driver", () => {
  it("targets the account-scoped S3 endpoint with auto region", async () => {
    const requests = stubFetch(() => new Response(null, { status: 200 }));
    const driver = R2HTTP("abc123def", {
      bucket: "my-bucket",
      accessKeyId: "key",
      secretAccessKey: "secret",
    });

    await driver.write("/obj.bin", new Blob(["data"]));

    const request = requests[0]!;
    expect(request.url).toBe("https://abc123def.r2.cloudflarestorage.com/my-bucket/obj.bin");
    expect(request.headers.authorization).toContain("/auto/s3/aws4_request");
  });
});
