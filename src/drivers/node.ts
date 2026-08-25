import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "pathe";
import type { FSWatcher } from "chokidar";

import type {
  AllStat,
  DirectoryListing,
  DriverInterface,
  FileWatchListener,
  Watcher,
} from "../types.ts";
import { computeChecksums } from "../utils.ts";

interface WatchEntry {
  watcherPromise: Promise<FSWatcher>;
  listeners: Set<FileWatchListener>;
}

async function importChokidar(): Promise<typeof import("chokidar")> {
  try {
    return await import("chokidar");
  } catch (error) {
    throw new Error(`Watching files with the node driver requires "chokidar" to be installed.`, {
      cause: error,
    });
  }
}

export function node(root: string): DriverInterface<{ root: string }> {
  const resolvedRoot = resolve(root);
  const watchEntries = new Map<string, WatchEntry>();

  function toAbsolute(filePath: string): string {
    const joined = join(resolvedRoot, filePath);
    return joined.length > 1 ? joined.replace(/[\\/]+$/, "") : joined;
  }

  async function statEntry(absolutePath: string): Promise<AllStat> {
    const entryStat = await stat(absolutePath);
    if (entryStat.isDirectory()) {
      return { type: "folder", children: {} };
    }
    const checksums = await computeChecksums(new Uint8Array(await readFile(absolutePath)));
    return { type: "file", checksums };
  }

  function removeEntryIfEmpty(path: string): void {
    const entry = watchEntries.get(path);
    if (entry && entry.listeners.size === 0) {
      watchEntries.delete(path);
      void entry.watcherPromise.then((watcher) => watcher.close());
    }
  }

  return {
    name: "node",
    raw: { root: resolvedRoot },

    async read(filePath) {
      try {
        return new Blob([await readFile(toAbsolute(filePath))]);
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
        await mkdir(dirname(absolutePath), { recursive: true });
      }
      await writeFile(absolutePath, Buffer.from(await contents.arrayBuffer()));
    },

    async delete(filePath, deleteOptions) {
      await rm(toAbsolute(filePath), {
        force: true,
        recursive: deleteOptions?.recursive ?? false,
      });
    },

    async ls(dir) {
      let dirents;
      try {
        dirents = await readdir(toAbsolute(dir), { withFileTypes: true });
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
      let entry = watchEntries.get(path);
      if (!entry) {
        entry = {
          watcherPromise: importChokidar().then(({ watch }) =>
            watch(toAbsolute(path), { ignoreInitial: true }),
          ),
          listeners: new Set(),
        };
        watchEntries.set(path, entry);
      }
      entry.listeners.add(listener);

      const watchedPath = path;
      void entry.watcherPromise.then((watcher) => {
        if (!watchEntries.has(watchedPath)) return;
        watcher.on("all", (event, eventPath) => {
          if (event !== "add" && event !== "addDir" && event !== "change") return;
          const watched = toAbsolute(watchedPath);
          const posixEventPath = eventPath.replaceAll("\\", "/");
          if (posixEventPath !== watched && !posixEventPath.startsWith(`${watched}/`)) return;
          const relative = posixEventPath.slice(watched.length);
          for (const registered of watchEntries.get(watchedPath)?.listeners ?? []) {
            void registered({
              filePath: `/${relative.replace(/^\//, "")}`.replace("//", "/"),
              time: new Date(),
            });
          }
        });
      });

      return {
        listener,
        stop() {
          const current = watchEntries.get(watchedPath);
          if (!current) return;
          current.listeners.delete(listener);
          removeEntryIfEmpty(watchedPath);
        },
      };
    },

    unwatch(path) {
      const entry = watchEntries.get(path);
      if (!entry) return;
      entry.listeners.clear();
      watchEntries.delete(path);
      void entry.watcherPromise.then((watcher) => watcher.close());
    },

    dispose() {
      for (const [path, entry] of watchEntries) {
        entry.listeners.clear();
        watchEntries.delete(path);
        void entry.watcherPromise.then((watcher) => watcher.close());
      }
    },
  };
}
