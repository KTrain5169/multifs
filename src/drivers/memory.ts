import { Volume } from "memfs";
import { dirname, join } from "pathe";

import type {
  AllStat,
  DirectoryListing,
  DriverInterface,
  FileWatchListener,
  Watcher,
} from "../types.ts";
import { blobFromBytes, computeChecksums } from "../utils.ts";

interface WatchEntry {
  watcher: { close(): void };
  listeners: Set<FileWatchListener>;
}

interface DirentLike {
  name: string;
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return new TextEncoder().encode(value);
  throw new TypeError("Unexpected memfs file contents type.");
}

export function memory(initialFiles: Record<string, string> = {}): DriverInterface<Volume> {
  const vol = new Volume();
  const promises = vol.promises;
  for (const [filePath, contents] of Object.entries(initialFiles)) {
    vol.mkdirSync(dirname(join("/", filePath)), { recursive: true });
    vol.writeFileSync(join("/", filePath), contents);
  }

  const watchEntries = new Map<string, WatchEntry>();

  function toAbsolute(filePath: string): string {
    return join("/", filePath);
  }

  async function statEntry(absolutePath: string): Promise<AllStat> {
    const entryStat = await promises.stat(absolutePath);
    if (entryStat.isDirectory()) {
      return { type: "folder", children: {} };
    }
    const checksums = await computeChecksums(asBytes(await promises.readFile(absolutePath)));
    return { type: "file", checksums };
  }

  return {
    name: "memory",
    raw: vol,

    async read(filePath) {
      try {
        const value = await promises.readFile(toAbsolute(filePath));
        return blobFromBytes(asBytes(value));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    },

    async write(filePath, contents, writeOptions) {
      const absolutePath = toAbsolute(filePath);
      if (writeOptions?.recursive !== false) {
        await promises.mkdir(dirname(absolutePath), { recursive: true });
      }
      await promises.writeFile(absolutePath, Buffer.from(await contents.arrayBuffer()));
    },

    async delete(filePath, deleteOptions) {
      await promises.rm(toAbsolute(filePath), {
        force: true,
        recursive: deleteOptions?.recursive ?? false,
      });
    },

    async ls(dir) {
      let dirents;
      try {
        dirents = (await promises.readdir(toAbsolute(dir), {
          withFileTypes: true,
        })) as unknown as DirentLike[];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return {};
        }
        throw error;
      }
      const listing: DirectoryListing = {};
      for (const dirent of dirents) {
        listing[dirent.name] = await statEntry(join(toAbsolute(dir), dirent.name));
      }
      return listing;
    },

    async stat(filePath) {
      try {
        return await statEntry(toAbsolute(filePath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`No such file or directory: ${filePath}`);
        }
        throw error;
      }
    },

    watch(path, listener): Watcher {
      const absolutePath = toAbsolute(path);
      let entry = watchEntries.get(absolutePath);
      if (!entry) {
        const fire = (_event: string, filename: string | null) => {
          const relative = typeof filename === "string" ? filename : "";
          for (const registered of watchEntries.get(absolutePath)?.listeners ?? []) {
            void registered({
              filePath: `/${relative.replace(/^\//, "")}`.replace("//", "/"),
              time: new Date(),
            });
          }
        };
        const watcher = vol.watch(absolutePath, fire);
        entry = { watcher, listeners: new Set() };
        watchEntries.set(absolutePath, entry);
      }
      entry.listeners.add(listener);

      const watchedPath = absolutePath;
      return {
        listener,
        stop() {
          const current = watchEntries.get(watchedPath);
          if (!current) return;
          current.listeners.delete(listener);
          if (current.listeners.size === 0) {
            current.watcher.close();
            watchEntries.delete(watchedPath);
          }
        },
      };
    },

    unwatch(path) {
      const absolutePath = toAbsolute(path);
      const entry = watchEntries.get(absolutePath);
      if (!entry) return;
      entry.watcher.close();
      watchEntries.delete(absolutePath);
    },

    dispose() {
      for (const entry of Array.from(watchEntries.values())) {
        entry.watcher.close();
      }
      watchEntries.clear();
      vol.reset();
    },
  };
}
