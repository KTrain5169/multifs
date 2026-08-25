import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { vercelBlob } from "../src/drivers/vercel.ts";
import { jsonResponse, stubFetch, textResponse } from "./helpers.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeDriver() {
  return vercelBlob({ token: "vercel-tok", apiURL: "https://blob.test" });
}

describe("Vercel Blob driver (fetch mocked)", () => {
  it("writes blobs with pathname query and disables random suffixes", async () => {
    const requests = stubFetch(() =>
      jsonResponse({ url: "https://cdn.test/file.txt", pathname: "file.txt" }),
    );
    const driver = makeDriver();

    await driver.write("/file.txt", new Blob(["vercel!"]));

    const request = requests[0]!;
    expect(request.method).toBe("PUT");
    expect(request.url).toBe("https://blob.test/file.txt?pathname=file.txt");
    expect(request.headers.authorization).toBe("Bearer vercel-tok");
    expect(request.headers["x-add-random-suffix"]).toBe("false");
  });

  it("reads from the cached upload URL", async () => {
    stubFetch((request) => {
      if (request.method === "PUT")
        return jsonResponse({ url: "https://cdn.test/cached.txt", pathname: "cached.txt" });
      return request.url === "https://cdn.test/cached.txt"
        ? textResponse("from-cdn")
        : new Response(null, { status: 404 });
    });
    const driver = makeDriver();
    await driver.write("/cached.txt", new Blob(["ignored"]));

    expect(await (await driver.read("/cached.txt"))!.text()).toBe("from-cdn");
    expect(await driver.read("/never.txt")).toBeUndefined();
  });

  it("deletes via the batch delete endpoint", async () => {
    const requests = stubFetch(() => new Response(null, { status: 200 }));
    const driver = makeDriver();
    await driver.delete("/file.txt");

    const request = requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://blob.test/delete");
    expect(JSON.parse(new TextDecoder().decode(request.body))).toEqual({
      urls: ["https://blob.test/file.txt"],
    });
  });

  it("stats via the head endpoint and throws for missing keys", async () => {
    const requests = stubFetch((request) =>
      request.url.includes("known.txt")
        ? jsonResponse({ size: 3 })
        : new Response(null, { status: 404 }),
    );
    const driver = makeDriver();

    expect(await driver.stat("/known.txt")).toMatchObject({ type: "file" });
    expect(requests[0]?.headers.authorization).toBe("Bearer vercel-tok");
    await expect(driver.stat("/missing.txt")).rejects.toThrow("File not found");
  });

  it("lists with pagination and groups nested pathnames into folders", async () => {
    let page = 0;
    stubFetch(() => {
      page += 1;
      if (page === 1) {
        return jsonResponse({
          blobs: [
            { url: "u1", pathname: "a.txt" },
            { url: "u2", pathname: "nested/b.txt" },
          ],
          cursor: "c2",
          hasMore: true,
        });
      }
      return jsonResponse({
        blobs: [{ url: "u3", pathname: "nested/deep/c.txt" }],
        hasMore: false,
      });
    });
    const driver = makeDriver();

    const listing = await driver.ls("/");

    expect(Object.keys(listing).sort()).toEqual(["a.txt", "nested"]);
    expect(listing.nested).toEqual({ type: "folder", children: {} });
  });

  it("runs the multipart flow including resume part numbering", async () => {
    const requests = stubFetch((request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/mpu") {
        return jsonResponse({ uploadId: "v-1" });
      }
      if (request.method === "PUT" && url.pathname.startsWith("/mpu/")) {
        return jsonResponse({ etag: `etag-${url.pathname.split("/")[2]}` });
      }
      if (url.pathname.endsWith("/complete")) {
        return jsonResponse({ url: "https://cdn.test/big.bin", pathname: "big.bin" });
      }
      return new Response(null, { status: 500 });
    });
    const driver = makeDriver();

    const upload = await driver.createMultipartUpload!("/big.bin");
    expect(upload.uploadId).toBe("v-1");

    await upload.uploadPart(1, new Blob(["chunk-1"]));
    await driver.resumeMultipartUpload!("v-1", new Blob(["resumed"]));
    await upload.complete([{ partNumber: 1, etag: "etag-1" }]);

    expect(requests.some((request) => request.url.includes("/mpu/v-1/1?pathname="))).toBe(true);
    expect(requests.some((request) => request.url.includes("/mpu/v-1/2?pathname="))).toBe(true);

    const completeRequest = requests.find((request) => request.url.endsWith("/complete"))!;
    const completeBody = JSON.parse(new TextDecoder().decode(completeRequest.body));
    expect(completeBody.parts).toContainEqual({ number: 1, etag: "etag-1" });
  });

  it("aborts multipart uploads", async () => {
    const requests = stubFetch((request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/mpu") {
        return jsonResponse({ uploadId: "v-2" });
      }
      if (url.pathname.endsWith("/abort")) return new Response(null, { status: 200 });
      return new Response(null, { status: 500 });
    });
    const driver = makeDriver();

    const upload = await driver.createMultipartUpload!("/big.bin");
    await upload.abort();

    expect(requests.at(-1)?.url).toBe("https://blob.test/mpu/v-2/abort");
  });

  it("throws when writes fail", async () => {
    stubFetch(() => new Response(null, { status: 403 }));
    const driver = makeDriver();
    await expect(driver.write("/denied.txt", new Blob(["x"]))).rejects.toThrow("403");
  });
});
