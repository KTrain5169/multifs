export interface BaseInterface {
  read(filePath: string, options?: {}): Promise<Blob>;
  write(filePath: string, contents: Blob, options?: {}): Promise<void>;
  ls(dir: string, options?: {}): Promise<DirectoryListing>;
  stat(filePath: string): Promise<AllStat>;
}

export interface DriverInterface<Raw = unknown> extends BaseInterface {
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
