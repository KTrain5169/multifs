import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MultiFS } from "../src/index.ts";
import { node } from "../src/drivers/node.ts";

const root = await mkdtemp(join(tmpdir(), "multifs-watch-"));
const fs = new MultiFS(root, node(root));

try {
  const events: string[] = [];
  fs.watch("/", (ctx) => {
    events.push(`${ctx.filePath} at ${ctx.time.toISOString()}`);
  });
  console.log(`Watching ${root.replaceAll("\\", "/")} for changes...`);

  await writeFile(join(root, "hello.txt"), "written from outside multifs");
  const deadline = Date.now() + 5000;
  let attempt = 1;
  while (events.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await writeFile(join(root, "hello.txt"), `rewrite ${attempt++}`);
  }
  console.log(`External write observed: ${events[0] ?? "<none>"}`);

  events.length = 0;
  await fs.write("/internal.txt", new Blob(["written through the driver"]));
  const internalDeadline = Date.now() + 5000;
  while (events.length === 0 && Date.now() < internalDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.log(`Driver write observed too: ${events[0] ?? "<none>"}`);

  await fs.unwatch("/");
  console.log("unwatch('/') stops all listeners for that path");
} finally {
  await fs.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
