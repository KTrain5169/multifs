export interface BaseInterface {
  read(filePath: string, options?: {}): Promise<Blob>;
  write(filePath: string, contents: Blob, options?: {}): Promise<void>;
  ls(dir: string, options?: {}): Promise<DirectoryListing>;
}

export interface DriverInterface<Raw = unknown> extends BaseInterface {
  raw: Raw;
}

export interface DirectoryListing {
  [key: string]: AllStat;
}

interface BaseStat {
  type: string;
}

interface FileStat extends BaseStat {
  type: "file";
  contents: Blob;
}

interface FolderStat extends BaseStat {
  type: "folder";
  contents: {
    [key: string]: AllStat;
  };
}

type AllStat = FileStat | FolderStat;
