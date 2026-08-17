export interface BaseInterface {
  read(filePath: string, options?: {}): Promise<Blob>;
  write(filePath: string, contents: Blob, options?: {}): Promise<void>;
  delete(filePath: string, options?: { recursive?: boolean }): Promise<void>;
  ls(dir: string, options?: {}): Promise<DirectoryListing>;
  stat(filePath: string, options?: {}): Promise<AllStat>;
  watch(path: string, listener: (ctx: WatchContext) => void | Promise<void>, options?: {}): Watcher;
  unwatch(path: string, options?: {}): void | Promise<void>;
  createMultipartUpload?(filePath: string, options?: {}): Promise<MultipartUpload>;
  resumeMultipartUpload?(uploadId: string, content: Blob): Promise<void>;
  dispose(): void | Promise<void>;
}

export interface Watcher {
  readonly listener: (ctx: WatchContext) => void | Promise<void>;
  stop(): void | Promise<void>;
}

export interface WatchContext {
  readonly filePath: string;
  readonly time: Date;
}

export interface MultipartUpload {
  readonly filePath: string;
  readonly uploadId: string;
  uploadPart(part: number, value: Blob, options?: {}): Promise<UploadedMultiparts>;
  abort(): Promise<void>;
  complete(uploadedParts: UploadedMultiparts[]): Promise<void>;
}

export interface UploadedMultiparts {
  partNumber: number;
  etag: string;
}

export interface DriverInterface<Raw = unknown> extends BaseInterface {
  name: string;
  raw: Raw;
}

export interface DirectoryListing {
  [key: string]: AllStat;
}

export interface BaseStat {
  type: string;
}

export interface FileStat extends BaseStat {
  type: "file";
  checksums: {
    sha1: string;
    sha256: string;
    sha512: string;
  };
}

export interface FolderStat extends BaseStat {
  type: "folder";
  children: {
    [key: string]: AllStat;
  };
}

export type AllStat = FileStat | FolderStat;
