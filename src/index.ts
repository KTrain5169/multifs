import { resolve } from "pathe";

import type { AllStat, BaseInterface, DirectoryListing, DriverInterface } from "./types.ts";

export class FS<const Raw> implements BaseInterface {
  private readonly driver: DriverInterface<Raw>;
  private readonly mounts: Record<string, BaseInterface> = {};
  private readonly base?: string;

  constructor(driver: DriverInterface<Raw>);
  constructor(base: string, driver: DriverInterface<Raw>);
  constructor(arg1: DriverInterface<Raw> | string, arg2?: DriverInterface<Raw>) {
    if (typeof arg1 === "string") {
      this.base = resolve(arg1);
      this.driver = arg2!;
    } else {
      this.driver = arg1;
    }
    this.raw = this.driver.raw;
  }

  readonly raw: Raw;

  private resolveMountedPath(filePath: string): { driver: BaseInterface; path: string } | null {
    const resolvedPath = this.base ? resolve(this.base, filePath) : resolve(filePath);

    const matches = Object.entries(this.mounts)
      .map(([mountPath, driver]) => {
        const normalizedMount = this.base ? resolve(this.base, mountPath) : resolve(mountPath);
        const isMatch =
          resolvedPath === normalizedMount || resolvedPath.startsWith(`${normalizedMount}/`);

        if (!isMatch) {
          return null;
        }

        const relativePath = resolvedPath.slice(normalizedMount.length) || "/";

        return {
          driver,
          path: relativePath.startsWith("/") ? relativePath : `/${relativePath}`,
        };
      })
      .filter(Boolean) as { driver: BaseInterface; path: string }[];

    if (matches.length === 0) {
      return null;
    }

    return matches.sort((a, b) => b.path.length - a.path.length)[0];
  }

  read(filePath: string, options?: {}): Promise<Blob> {
    const mounted = this.resolveMountedPath(filePath);
    const driver = mounted?.driver ?? this.driver;

    let path: string;
    if (mounted) {
      path = mounted.path;
    } else if (this.base) {
      path = resolve(this.base, filePath);
    } else {
      path = resolve(filePath);
    }

    return driver.read(path, options);
  }

  write(filePath: string, contents: Blob, options?: {}): Promise<void> {
    const mounted = this.resolveMountedPath(filePath);
    const driver = mounted?.driver ?? this.driver;

    let path: string;
    if (mounted) {
      path = mounted.path;
    } else if (this.base) {
      path = resolve(this.base, filePath);
    } else {
      path = resolve(filePath);
    }

    return driver.write(path, contents, options);
  }

  delete(filePath: string, options?: { recursive?: boolean }): Promise<void> {
    const mounted = this.resolveMountedPath(filePath);
    const driver = mounted?.driver ?? this.driver;

    let path: string;
    if (mounted) {
      path = mounted.path;
    } else if (this.base) {
      path = resolve(this.base, filePath);
    } else {
      path = resolve(filePath);
    }

    return driver.delete(path, options);
  }

  ls(dir: string, options?: {}): Promise<DirectoryListing> {
    const mounted = this.resolveMountedPath(dir);
    const driver = mounted?.driver ?? this.driver;

    let path: string;
    if (mounted) {
      path = mounted.path;
    } else if (this.base) {
      path = resolve(this.base, dir);
    } else {
      path = resolve(dir);
    }

    return driver.ls(path, options);
  }

  stat(filePath: string): Promise<AllStat> {
    const mounted = this.resolveMountedPath(filePath);
    const driver = mounted?.driver ?? this.driver;

    let path: string;
    if (mounted) {
      path = mounted.path;
    } else if (this.base) {
      path = resolve(this.base, filePath);
    } else {
      path = resolve(filePath);
    }

    return driver.stat(path);
  }

  mount(path: string, driver: BaseInterface, override = false) {
    const normalizedPath = this.base ? resolve(this.base, path) : resolve(path);

    if (this.mounts[normalizedPath] && !override) {
      throw new Error("Mount already exists!");
    } else {
      this.mounts[normalizedPath] = driver;
    }
  }
}
