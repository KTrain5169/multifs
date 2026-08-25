import { describe, expect, it } from "vite-plus/test";

import type { LocalFsFactory } from "./helpers.ts";
import { MultiFS } from "../src/index.ts";

export const HELLO = "hello world";
export const SHA1_HELLO = "2aae6c35c94fcfb415dbe95f408b9ce91ee846ed";
export const SHA256_HELLO = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

export function runLocalDriverSuite(label: string, factory: LocalFsFactory): void {
  describe(`${label} driver`, () => {
    it("round-trips text content", async () => {
      const { fs, cleanup } = await factory();
      try {
        await fs.write("/dir/hello.txt", new Blob([HELLO]));
        const blob = await fs.read("/dir/hello.txt");
        expect(await blob?.text()).toBe(HELLO);
      } finally {
        await cleanup();
      }
    });

    it("round-trips binary content", async () => {
      const { fs, cleanup } = await factory();
      try {
        const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
        await fs.write("/bin/data.bin", new Blob([bytes]));
        const blob = await fs.read("/bin/data.bin");
        expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(bytes);
      } finally {
        await cleanup();
      }
    });

    it("returns undefined when reading a missing file", async () => {
      const { fs, cleanup } = await factory();
      try {
        expect(await fs.read("/nope.txt")).toBeUndefined();
        expect(await fs.read("/missing/dir/file.txt")).toBeUndefined();
      } finally {
        await cleanup();
      }
    });

    it("overwrites existing files", async () => {
      const { fs, cleanup } = await factory();
      try {
        await fs.write("/file.txt", new Blob(["first"]));
        await fs.write("/file.txt", new Blob(["second"]));
        expect(await (await fs.read("/file.txt"))!.text()).toBe("second");
      } finally {
        await cleanup();
      }
    });

    it("creates parent directories implicitly on write", async () => {
      const { fs, cleanup } = await factory();
      try {
        await fs.write("/a/b/c/file.txt", new Blob([HELLO]), { recursive: true });
        expect(await fs.read("/a/b/c/file.txt")).toBeDefined();
      } finally {
        await cleanup();
      }
    });

    it("deletes files and directories recursively", async () => {
      const { fs, cleanup } = await factory();
      try {
        await fs.write("/tree/one.txt", new Blob(["1"]));
        await fs.write("/tree/sub/two.txt", new Blob(["2"]));
        await fs.delete("/tree", { recursive: true });
        expect(await fs.read("/tree/one.txt")).toBeUndefined();

        await fs.write("/single.txt", new Blob(["x"]));
        await fs.delete("/single.txt");
        expect(await fs.read("/single.txt")).toBeUndefined();
        await expect(fs.stat("/single.txt")).rejects.toThrow();
      } finally {
        await cleanup();
      }
    });

    it("lists nested structures with file and folder stats", async () => {
      const { fs, cleanup } = await factory();
      try {
        await fs.write("/root-file.txt", new Blob([HELLO]));
        await fs.write("/sub/nested.txt", new Blob([HELLO]));
        const root = await fs.ls("/");
        expect(Object.keys(root).sort()).toEqual(["root-file.txt", "sub"]);
        expect(root["root-file.txt"]).toMatchObject({ type: "file" });
        expect(root.sub).toMatchObject({ type: "folder" });
        const sub = await fs.ls("/sub");
        expect(Object.keys(sub)).toEqual(["nested.txt"]);
      } finally {
        await cleanup();
      }
    });

    it("stats files with checksums", async () => {
      const { fs, cleanup } = await factory();
      try {
        await fs.write("/hashed.txt", new Blob([HELLO]));
        const statResult = await fs.stat("/hashed.txt");
        expect(statResult.type).toBe("file");
        if (statResult.type !== "file") return;
        expect(statResult.checksums.sha256).toBe(SHA256_HELLO);
        expect(statResult.checksums.sha1).toBe(SHA1_HELLO);
        expect(statResult.checksums.sha512).toMatch(/^[0-9a-f]{128}$/);
      } finally {
        await cleanup();
      }
    });

    it("stats folders and throws for missing paths", async () => {
      const { fs, cleanup } = await factory();
      try {
        await fs.write("/folder/inner.txt", new Blob([HELLO]));
        expect((await fs.stat("/folder")).type).toBe("folder");
        await expect(fs.stat("/does-not-exist.txt")).rejects.toThrow();
      } finally {
        await cleanup();
      }
    });

    it("watches a directory and stops delivering events after stop", async () => {
      const { fs, cleanup } = await factory();
      try {
        const events: string[] = [];
        fs.watch("/", (ctx) => {
          events.push(ctx.filePath);
        });
        await fs.write("/watched.txt", new Blob(["initial"]));
        const deadline = Date.now() + 4000;
        while (events.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 150));
          await fs.write("/watched.txt", new Blob(["ping"]));
        }
        expect(events.length).toBeGreaterThan(0);
        expect(events[0]).toContain("watched.txt");

        await new Promise((resolve) => setTimeout(resolve, 300));
        const countBeforeStop = events.length;
        await fs.unwatch("/");
        await fs.write("/watched-2.txt", new Blob(["two"]));
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(events.length).toBe(countBeforeStop);
      } finally {
        await cleanup();
      }
    });

    it("supports mounted sub-drivers through MultiFS", async () => {
      const { fs, cleanup } = await factory();
      try {
        const { memory } = await import("../src/drivers/memory.ts");
        const mounted = new MultiFS(memory());
        fs.mount("/mnt", mounted);
        await fs.write("/mnt/from-parent.txt", new Blob([HELLO]));
        expect(await (await mounted.read("/from-parent.txt"))!.text()).toBe(HELLO);
        expect(await fs.read("/mnt/from-parent.txt")).toBeDefined();
        fs.unmount("/mnt");
        expect(await fs.read("/mnt/from-parent.txt")).toBeUndefined();
      } finally {
        await cleanup();
      }
    });
  });
}
