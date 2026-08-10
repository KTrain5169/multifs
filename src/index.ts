import type { AllStat, BaseInterface, DirectoryListing, DriverInterface } from "./types.ts";

export class FS<const Raw> implements BaseInterface {
  private readonly driver: DriverInterface<Raw>;
  readonly base?: string;

  constructor(driver: DriverInterface<Raw>);
  constructor(base: string, driver: DriverInterface<Raw>);
  constructor(arg1: DriverInterface<Raw> | string, arg2?: DriverInterface<Raw>) {
    if (typeof arg1 === "string") {
      this.base = arg1;
      this.driver = arg2!;
      this.raw = this.driver.raw;
    } else {
      this.driver = arg1;
      this.raw = this.driver.raw;
    }
  }

  readonly raw: Raw;

  read(filePath: string, options?: {}): Promise<Blob> {
    return this.driver.read(filePath, options);
  }

  write(filePath: string, contents: Blob, options?: {}): Promise<void> {
    return this.driver.write(filePath, contents, options);
  }

  ls(dir: string, options?: {}): Promise<DirectoryListing> {
    return this.driver.ls(dir, options);
  }

  stat(filePath: string): Promise<AllStat> {
    return this.driver.stat(filePath);
  }
}
