import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { s3 } from "../src/drivers/aws.ts";
import type { DriverInterface } from "../src/types.ts";
import { sha256Hex, stubFetch, textResponse } from "./helpers.ts";

function makeDriver(): DriverInterface<unknown> {
  return s3({
    bucket: "test-bucket",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "very-secret",
    region: "us-east-1",
    endpoint: "https://s3.local",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("S3 driver (fetch mocked)", () => {
  it("writes objects with a signed PUT request", async () => {
    const payload = "object-body";
    const requests = stubFetch(() => new Response(null, { status: 200 }));
    const driver = makeDriver();

    await driver.write("/folder/hello world.txt", new Blob([payload]));

    const request = requests[0]!;
    expect(request.method).toBe("PUT");
    expect(request.url).toBe("https://s3.local/test-bucket/folder/hello%20world.txt");
    expect(request.headers["x-amz-content-sha256"]).toBe(sha256Hex(payload));
    expect(request.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
    );
  });

  it("reads objects and returns undefined for missing keys", async () => {
    stubFetch((request) =>
      request.method === "GET" && request.url.endsWith("/exists.txt")
        ? textResponse("found")
        : new Response(null, { status: 404 }),
    );
    const driver = makeDriver();

    expect(await (await driver.read("/exists.txt"))!.text()).toBe("found");
    expect(await driver.read("/missing.txt")).toBeUndefined();
  });

  it("deletes objects idempotently", async () => {
    const requests = stubFetch((request) =>
      request.url.endsWith("/gone.txt")
        ? new Response(null, { status: 204 })
        : new Response(null, { status: 404 }),
    );
    const driver = makeDriver();

    await driver.delete("/gone.txt");
    await driver.delete("/never-existed.txt");

    expect(requests.map((request) => request.method)).toEqual(["DELETE", "DELETE"]);
  });

  it("stats files via HEAD and throws on missing keys", async () => {
    stubFetch((request) =>
      request.url.endsWith("/known.bin")
        ? new Response(null, { status: 200, headers: { etag: '"abc123"' } })
        : new Response(null, { status: 404 }),
    );
    const driver = makeDriver();

    const statResult = await driver.stat("/known.bin");
    expect(statResult).toMatchObject({ type: "file" });
    expect(statResult.type === "file" && statResult.checksums.sha256).toBe("");

    await expect(driver.stat("/unknown.bin")).rejects.toThrow("File not found");
  });

  it("lists with pagination, files, and common prefixes", async () => {
    let page = 0;
    const requests = stubFetch(() => {
      page += 1;
      if (page === 1) {
        return textResponse(
          [
            "<ListBucketResult>",
            "<IsTruncated>true</IsTruncated>",
            "<NextContinuationToken>token-2</NextContinuationToken>",
            "<Contents><Key>root.txt</Key><ETag>&quot;e1&quot;</ETag></Contents>",
            "</ListBucketResult>",
          ].join(""),
        );
      }
      return textResponse(
        [
          "<ListBucketResult>",
          "<IsTruncated>false</IsTruncated>",
          "<Contents><Key>root2.txt</Key><ETag>&quot;e2&quot;</ETag></Contents>",
          "<CommonPrefixes><Prefix>deep/</Prefix></CommonPrefixes>",
          "<CommonPrefixes><Prefix>photos/</Prefix></CommonPrefixes>",
          "</ListBucketResult>",
        ].join(""),
      );
    });
    const driver = makeDriver();

    const listing = await driver.ls("/");

    expect(page).toBe(2);
    expect(requests[1]?.url).toContain("continuation-token=token-2");
    expect(Object.keys(listing).sort()).toEqual(["deep", "photos", "root.txt", "root2.txt"]);
    expect(listing.photos).toEqual({ type: "folder", children: {} });
    expect(listing.deep).toEqual({ type: "folder", children: {} });
    expect(listing["root.txt"]).toMatchObject({ type: "file" });
    expect(listing["root2.txt"]).toMatchObject({ type: "file" });
  });

  it("runs the full multipart upload flow", async () => {
    const requests = stubFetch((request) => {
      const url = new URL(request.url);
      if (url.searchParams.has("uploads")) {
        return textResponse(
          "<CreateMultipartUploadResult><UploadId>U-42</UploadId></CreateMultipartUploadResult>",
        );
      }
      if (request.method === "PUT" && url.searchParams.get("uploadId") === "U-42") {
        return new Response(null, { status: 200, headers: { etag: '"part-etag"' } });
      }
      if (request.method === "POST" && url.searchParams.get("uploadId") === "U-42") {
        return textResponse(
          "<CompleteMultipartUploadResult><ETag>&quot;final&quot;</ETag></CompleteMultipartUploadResult>",
        );
      }
      return new Response(null, { status: 500 });
    });
    const driver = makeDriver();

    const upload = await driver.createMultipartUpload!("/videos/big.mp4");
    expect(upload.uploadId).toBe("U-42");

    const part = await upload.uploadPart(1, new Blob(["chunk"]));
    expect(part).toEqual({ partNumber: 1, etag: "part-etag" });

    const partRequest = requests[1]!;
    const partUrl = new URL(partRequest.url);
    expect(partUrl.searchParams.get("partNumber")).toBe("1");
    expect(partUrl.searchParams.get("uploadId")).toBe("U-42");

    await upload.complete([{ partNumber: 1, etag: part.etag }]);
    const completeRequest = requests[2]!;
    const completeBody = new TextDecoder().decode(completeRequest.body!);
    expect(completeBody).toContain("<Part><PartNumber>1</PartNumber><ETag>part-etag</ETag></Part>");
  });

  it("aborts multipart uploads", async () => {
    const requests = stubFetch((request) => {
      const url = new URL(request.url);
      if (url.searchParams.has("uploads")) {
        return textResponse(
          "<CreateMultipartUploadResult><UploadId>U-7</UploadId></CreateMultipartUploadResult>",
        );
      }
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(null, { status: 500 });
    });
    const driver = makeDriver();

    const upload = await driver.createMultipartUpload!("/big.bin");
    await upload.abort();

    const abortRequest = requests[1]!;
    expect(abortRequest.method).toBe("DELETE");
    expect(new URL(abortRequest.url).searchParams.get("uploadId")).toBe("U-7");
  });

  it("throws with server details when a request fails", async () => {
    stubFetch(() => new Response(null, { status: 403, statusText: "Forbidden" }));
    const driver = makeDriver();
    await expect(driver.write("/nope.txt", new Blob(["x"]))).rejects.toThrow("403");
  });

  it("resume uploads content as the next sequential part", async () => {
    const requests = stubFetch((request) => {
      const url = new URL(request.url);
      if (url.searchParams.has("uploads")) {
        return textResponse(
          "<CreateMultipartUploadResult><UploadId>U-9</UploadId></CreateMultipartUploadResult>",
        );
      }
      if (url.searchParams.get("uploadId")) {
        return new Response(null, { status: 200, headers: { etag: '"p"' } });
      }
      return new Response(null, { status: 500 });
    });
    const driver = makeDriver();
    await driver.createMultipartUpload!("/big.bin");
    await driver.resumeMultipartUpload!("U-9", new Blob(["resumed-chunk"]));

    const resumeRequest = requests.find((request) => {
      return (
        request.method === "PUT" && new URL(request.url).searchParams.get("partNumber") === "1"
      );
    })!;
    expect(resumeRequest).toBeDefined();
    const resumeUrl = new URL(resumeRequest.url);
    expect(resumeUrl.searchParams.get("uploadId")).toBe("U-9");
    expect(createHash("sha256").update(resumeRequest.body!).digest("hex")).toBe(
      sha256Hex("resumed-chunk"),
    );
  });
});
