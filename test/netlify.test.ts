import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { netlifyBlobs } from "../src/drivers/netlify.ts";
import { jsonResponse, stubFetch, textResponse } from "./helpers.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NETLIFY_BLOBS_CONTEXT;
});

function makeDriver() {
  return netlifyBlobs("my-store", { siteID: "site-1", token: "tok" });
}

describe("Netlify Blobs driver (fetch mocked)", () => {
  it("writes blobs with bearer auth to the site-scoped base URL", async () => {
    const requests = stubFetch(() => new Response(null, { status: 200 }));
    const driver = makeDriver();

    await driver.write("/dir/file.txt", new Blob(["netlify!"]));

    const request = requests[0]!;
    expect(request.method).toBe("PUT");
    expect(request.url).toBe(
      "https://api.netlify.com/api/v1/blobs/site-site-1/my-store/dir/file.txt",
    );
    expect(request.headers.authorization).toBe("Bearer tok");
    expect(new TextDecoder().decode(request.body)).toBe("netlify!");
  });

  it("reads blobs, mapping 404 to undefined", async () => {
    stubFetch((request) =>
      request.url.endsWith("/here.txt")
        ? textResponse("body")
        : new Response(null, { status: 404 }),
    );
    const driver = makeDriver();

    expect(await (await driver.read("/here.txt"))!.text()).toBe("body");
    expect(await driver.read("/gone.txt")).toBeUndefined();
  });

  it("stats via the metadata endpoint and throws on missing keys", async () => {
    const requests = stubFetch((request) =>
      request.url.includes("/known.txt?metadata=true")
        ? jsonResponse({ metadata: {}, etag: "e1", last_modified: "2024-01-01T00:00:00Z" })
        : new Response(null, { status: 404 }),
    );
    const driver = makeDriver();

    expect(await driver.stat("/known.txt")).toMatchObject({
      type: "file",
      checksums: { sha1: "", sha256: "", sha512: "" },
    });
    expect(requests[0]?.url).toContain("?metadata=true");
    await expect(driver.stat("/unknown.txt")).rejects.toThrow("File not found");
  });

  it("lists blobs and directories with cursor pagination", async () => {
    let page = 0;
    const requests = stubFetch(() => {
      page += 1;
      if (page === 1) {
        return jsonResponse({
          blobs: [{ key: "a.txt", etag: "e" }],
          directories: ["sub/"],
          next_cursor: "cursor-2",
        });
      }
      return jsonResponse({ blobs: [{ key: "sub/b.txt" }], directories: [] });
    });
    const driver = makeDriver();

    const listing = await driver.ls("/");

    expect(page).toBe(2);
    expect(requests[1]?.url).toContain("cursor=cursor-2");
    expect(Object.keys(listing).sort()).toEqual(["a.txt", "sub", "sub/b.txt"]);
    expect(listing.sub).toEqual({ type: "folder", children: {} });
  });

  it("deletes blobs tolerantly", async () => {
    const requests = stubFetch((request) =>
      request.url.endsWith("/doomed.txt")
        ? new Response(null, { status: 204 })
        : new Response(null, { status: 404 }),
    );
    const driver = makeDriver();
    await driver.delete("/doomed.txt");
    await driver.delete("/never.txt");
    expect(requests[0]?.method).toBe("DELETE");
  });

  it("uses the runtime context when NETLIFY_BLOBS_CONTEXT is present", async () => {
    process.env.NETLIFY_BLOBS_CONTEXT = JSON.stringify({
      url: "https://blobs.example/context",
      token: "ctx-tok",
    });
    const requests = stubFetch(() => new Response(null, { status: 200 }));
    const driver = netlifyBlobs("edge-store");

    await driver.write("/f.txt", new Blob(["x"]));

    expect(requests[0]?.url).toBe("https://blobs.example/context/edge-store/f.txt");
    expect(requests[0]?.headers.authorization).toBe("Bearer ctx-tok");
  });

  it("throws when no configuration is available", () => {
    expect(() => netlifyBlobs("lonely")).toThrow(/requires either a Netlify runtime context/);
  });
});
