import { describe, expect, it } from "vite-plus/test";

import { MultiFS } from "../src/index.ts";
import type { MultipartUpload } from "../src/types.ts";
import { makeRecorder, recordingDriver } from "./helpers.ts";

describe("MultiFS core", () => {
  it("routes unmounted paths to the primary driver", async () => {
    const recorder = makeRecorder();
    const fs = new MultiFS(recordingDriver(recorder));
    await fs.write("/some/file.txt", new Blob(["x"]));
    expect(recorder.writes[0]?.path).toBe("/some/file.txt");
  });

  it("resolves relative paths against the base", async () => {
    const recorder = makeRecorder();
    const fs = new MultiFS("/base/root", recordingDriver(recorder));
    await fs.write("file.txt", new Blob(["x"]));
    expect(recorder.writes[0]?.path).toBe("/base/root/file.txt");
  });

  it("preserves windows drive-letter bases", { skip: process.platform !== "win32" }, async () => {
    const recorder = makeRecorder();
    const fs = new MultiFS("C:\\base\\root", recordingDriver(recorder));
    await fs.write("file.txt", new Blob(["x"]));
    expect(recorder.writes[0]?.path).toBe("C:/base/root/file.txt");
  });

  it("keeps absolute paths anchored at the virtual root", async () => {
    const recorder = makeRecorder();
    const fs = new MultiFS(recordingDriver(recorder));
    fs.mount("/mnt", recordingDriver(makeRecorder()));
    await fs.write("/mnt/../top.txt", new Blob(["x"]));
    expect(recorder.writes[0]?.path).toBe("/top.txt");
  });

  it("routes mounted paths to the mounted driver with a relative path", async () => {
    const primaryRecorder = makeRecorder();
    const mountRecorder = makeRecorder();
    const fs = new MultiFS("/root", recordingDriver(primaryRecorder));
    fs.mount("/mnt/data", recordingDriver(mountRecorder));

    await fs.write("/mnt/data/file.txt", new Blob(["x"]));
    expect(mountRecorder.writes[0]?.path).toBe("/file.txt");
    expect(primaryRecorder.writes).toHaveLength(0);

    await fs.read("/other.txt");
    expect(primaryRecorder.reads[0]).toBe("/other.txt");
  });

  it("prefers the most specific mount regardless of registration order", async () => {
    const parentRecorder = makeRecorder();
    const childRecorder = makeRecorder();
    const fs = new MultiFS(recordingDriver(makeRecorder()));
    fs.mount("/m", recordingDriver(parentRecorder));
    fs.mount("/m/sub/very/deeply/nested/path", recordingDriver(childRecorder));

    await fs.write("/m/sub/very/deeply/nested/path/f.txt", new Blob(["x"]));
    await fs.write("/m/sub/other.txt", new Blob(["x"]));

    expect(childRecorder.writes[0]?.path).toBe("/f.txt");
    expect(parentRecorder.writes[0]?.path).toBe("/sub/other.txt");
  });

  it("does not double-apply the base when resolving mounts", async () => {
    const primaryRecorder = makeRecorder();
    const mountRecorder = makeRecorder();
    const fs = new MultiFS("/base", recordingDriver(primaryRecorder));
    fs.mount("/data", recordingDriver(mountRecorder));

    await fs.write("/data/file.txt", new Blob(["x"]));
    expect(mountRecorder.writes[0]?.path).toBe("/file.txt");
    expect(primaryRecorder.writes).toHaveLength(0);
  });

  it("throws when mounting the same path twice without override", () => {
    const fs = new MultiFS(recordingDriver(makeRecorder()));
    fs.mount("/x", recordingDriver(makeRecorder()));
    expect(() => fs.mount("/x", recordingDriver(makeRecorder()))).toThrow("Mount already exists!");
    fs.mount("/x", recordingDriver(makeRecorder()), true);
  });

  it("unmount removes routing and falls back to the primary driver", async () => {
    const primaryRecorder = makeRecorder();
    const mountRecorder = makeRecorder();
    const fs = new MultiFS(recordingDriver(primaryRecorder));
    fs.mount("/gone", recordingDriver(mountRecorder));
    fs.unmount("/gone");

    await fs.read("/gone/file.txt");
    expect(mountRecorder.reads).toHaveLength(0);
    expect(primaryRecorder.reads[0]).toBe("/gone/file.txt");
  });

  it("throws a descriptive error for unsupported multipart uploads", async () => {
    const fs = new MultiFS(recordingDriver(makeRecorder(), { name: "plain" }));
    await expect(fs.createMultipartUpload("/big.bin")).rejects.toThrow(
      'Multipart uploads are not supported by the driver "plain".',
    );
  });

  it("tracks multipart uploads and clears references on completion or abort", async () => {
    const fs = new MultiFS(recordingDriver(makeRecorder(), { withMultipart: true }));
    const upload: MultipartUpload = await fs.createMultipartUpload("/big.bin");
    await upload.uploadPart(1, new Blob(["part-1"]));
    await fs.resumeMultipartUpload(upload.uploadId, new Blob(["resumed"]));
    await upload.complete([{ partNumber: 1, etag: "e1" }]);
    await expect(fs.resumeMultipartUpload(upload.uploadId, new Blob(["late"]))).rejects.toThrow(
      "does not match a recorded multipart upload",
    );
  });

  it("clears multipart references on abort too", async () => {
    const fs = new MultiFS(recordingDriver(makeRecorder(), { withMultipart: true }));
    const upload = await fs.createMultipartUpload("/big.bin");
    await upload.abort();
    await expect(fs.resumeMultipartUpload(upload.uploadId, new Blob(["x"]))).rejects.toThrow();
  });

  it("resume throws for unknown upload ids", async () => {
    const fs = new MultiFS(recordingDriver(makeRecorder(), { withMultipart: true }));
    await expect(fs.resumeMultipartUpload("bogus-id", new Blob(["x"]))).rejects.toThrow(
      "does not match a recorded multipart upload",
    );
  });

  it("dispose stops watchers and disposes all drivers", async () => {
    const primaryRecorder = makeRecorder();
    const mountRecorder = makeRecorder();
    const primary = recordingDriver(primaryRecorder);
    const mounted = recordingDriver(mountRecorder, { name: "child" });
    const fs = new MultiFS(primary);
    fs.mount("/child", mounted);
    fs.watch("/watched.txt", () => {});

    await fs.dispose();

    expect(primaryRecorder.stoppedWatchers).toHaveLength(1);
    expect(primaryRecorder.disposed).toBe(1);
    expect(mountRecorder.disposed).toBe(1);
  });
});
