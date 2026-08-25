import { normalize } from "pathe";

import pkg from "../package.json" with { type: "json" };
import type {
  AllStat,
  BaseInterface,
  DirectoryListing,
  DriverInterface,
  MultipartUpload,
  WatchContext,
  Watcher,
} from "./types.ts";

interface RoutedPath {
  driver: BaseInterface;
  path: string;
}

export class MultiFS<const Raw> implements BaseInterface {
  private readonly driver: DriverInterface<Raw>;
  private readonly mounts: Record<string, BaseInterface> = {};
  private readonly base?: string;
  private readonly currentMultipartUploads: Record<string, BaseInterface> = {};
  private readonly watchersByPath = new Map<string, Set<Watcher>>();

  readonly raw: Raw;

  constructor(driver: DriverInterface<Raw>);
  constructor(base: string, driver: DriverInterface<Raw>);
  constructor(arg1: DriverInterface<Raw> | string, arg2?: DriverInterface<Raw>) {
    if (typeof arg1 === "string") {
      const unified = arg1.replaceAll("\\", "/");
      const isAbsolute = /^([A-Za-z]:\/|\/)/.test(unified);
      this.base = normalize(isAbsolute ? unified : `/${unified}`);
      this.driver = arg2!;
    } else {
      this.driver = arg1;
    }
    this.raw = this.driver.raw;
  }

  private resolvePath(filePath: string): string {
    const unified = filePath.replaceAll("\\", "/");
    if (unified.startsWith("/")) {
      return normalize(unified);
    }
    return normalize(`${this.base ?? ""}/${unified}`);
  }

  private route(filePath: string): RoutedPath {
    const resolvedPath = this.resolvePath(filePath);

    let best: { driver: BaseInterface; relative: string; mountLength: number } | null = null;
    for (const [mountPath, mountedDriver] of Object.entries(this.mounts)) {
      const isMatch = resolvedPath === mountPath || resolvedPath.startsWith(`${mountPath}/`);
      if (!isMatch) continue;

      const relative = resolvedPath.slice(mountPath.length) || "/";
      if (!best || mountPath.length > best.mountLength) {
        best = { driver: mountedDriver, relative, mountLength: mountPath.length };
      }
    }

    if (!best) {
      return { driver: this.driver, path: resolvedPath };
    }
    return {
      driver: best.driver,
      path: best.relative.startsWith("/") ? best.relative : `/${best.relative}`,
    };
  }

  read(filePath: string, options?: {}): Promise<Blob | undefined> {
    const { driver, path } = this.route(filePath);
    return driver.read(path, options);
  }

  write(filePath: string, contents: Blob, options?: { recursive?: boolean }): Promise<void> {
    const { driver, path } = this.route(filePath);
    return driver.write(path, contents, options);
  }

  delete(filePath: string, options?: { recursive?: boolean }): Promise<void> {
    const { driver, path } = this.route(filePath);
    return driver.delete(path, options);
  }

  ls(dir: string, options?: {}): Promise<DirectoryListing> {
    const { driver, path } = this.route(dir);
    return driver.ls(path, options);
  }

  stat(filePath: string, options?: {}): Promise<AllStat> {
    const { driver, path } = this.route(filePath);
    return driver.stat(path, options);
  }

  watch(
    filePath: string,
    listener: (ctx: WatchContext) => void | Promise<void>,
    options?: {},
  ): Watcher {
    const { driver, path } = this.route(filePath);
    const watcher = driver.watch(path, listener, options);
    let watchers = this.watchersByPath.get(filePath);
    if (!watchers) {
      watchers = new Set();
      this.watchersByPath.set(filePath, watchers);
    }
    watchers.add(watcher);
    return watcher;
  }

  unwatch(filePath: string, options?: {}): void | Promise<void> {
    const { driver, path } = this.route(filePath);
    for (const watcher of this.watchersByPath.get(filePath) ?? []) {
      void watcher.stop();
    }
    this.watchersByPath.delete(filePath);
    return driver.unwatch(path, options);
  }

  mount(path: string, driver: BaseInterface, override = false) {
    const normalizedPath = this.resolvePath(path);

    if (this.mounts[normalizedPath] && !override) {
      throw new Error("Mount already exists!");
    } else {
      this.mounts[normalizedPath] = driver;
    }
  }

  unmount(path: string) {
    const normalizedPath = this.resolvePath(path);

    if (!this.mounts[normalizedPath]) {
      return;
    } else {
      delete this.mounts[normalizedPath];
    }
  }

  async createMultipartUpload(filePath: string, options?: {}): Promise<MultipartUpload> {
    const { driver, path } = this.route(filePath);

    if (!driver.createMultipartUpload || !driver.resumeMultipartUpload) {
      if ("name" in driver && typeof driver.name === "string") {
        throw new Error(`Multipart uploads are not supported by the driver "${driver.name}".`);
      } else {
        throw new Error(
          `The mounted filesystem driver for "${path}" does not support multipart uploads.`,
        );
      }
    }

    const upload = await driver.createMultipartUpload(path, options);
    this.currentMultipartUploads[upload.uploadId] = driver;

    return {
      filePath: upload.filePath,
      uploadId: upload.uploadId,
      uploadPart: (part, value, partOptions) => upload.uploadPart(part, value, partOptions),
      abort: async () => {
        await upload.abort();
        this.clearMultipartUploadReferences(upload.uploadId);
      },
      complete: async (uploadedParts) => {
        await upload.complete(uploadedParts);
        this.clearMultipartUploadReferences(upload.uploadId);
      },
    };
  }

  async resumeMultipartUpload(uploadId: string, content: Blob): Promise<void> {
    const driver = this.currentMultipartUploads[uploadId];

    if (!driver) {
      throw new Error(`ID "${uploadId}" does not match a recorded multipart upload.`);
    }

    await driver.resumeMultipartUpload!(uploadId, content);
  }

  clearMultipartUploadReferences(uploadId: string): void {
    delete this.currentMultipartUploads[uploadId];
  }

  async dispose(): Promise<void> {
    for (const watchers of Array.from(this.watchersByPath.values())) {
      for (const watcher of watchers) {
        await watcher.stop();
      }
    }
    this.watchersByPath.clear();
    await this.driver.dispose();
    for (const m of Object.keys(this.mounts)) {
      await this.mounts[m].dispose();
    }
    for (const r of Object.keys(this.currentMultipartUploads)) {
      this.clearMultipartUploadReferences(r);
    }
  }
}

interface DriverDependencies {
  readonly [driver: string]: {
    readonly [dep: string]: {
      readonly version: string;
      readonly optional?: boolean;
    };
  };
}

export const driverDependencies: DriverDependencies = {
  node: {
    chokidar: {
      version: pkg.peerDependencies.chokidar,
      optional: pkg.peerDependenciesMeta.chokidar.optional,
    },
  },
  memory: {
    memfs: {
      version: pkg.peerDependencies.memfs,
      optional: pkg.peerDependenciesMeta.memfs.optional,
    },
  },
} as const;
