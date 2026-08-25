import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MultiFS } from "../src/index.ts";
import { node } from "../src/drivers/node.ts";

const root = await mkdtemp(join(tmpdir(), "multifs-example-"));
const fs = new MultiFS(root, node(root));

try {
  console.log(`Working inside temporary root ${root.replaceAll("\\", "/")}`);

  await fs.write("/greeting.txt", new Blob(["Hello, multifs!"]));
  console.log("Wrote /greeting.txt");

  const blob = await fs.read("/greeting.txt");
  console.log(`Read back: ${(await blob?.text()) ?? "<missing>"}`);

  const missing = await fs.read("/does-not-exist.txt");
  console.log(`Missing files read as: ${missing === undefined ? "undefined" : "defined"}`);

  const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await fs.write("/assets/images/logo.png", new Blob([pngBytes], { type: "image/png" }));
  console.log("Wrote nested /assets/images/logo.png (parents created automatically)");

  const listing = await fs.ls("/");
  for (const [name, entry] of Object.entries(listing)) {
    console.log(`  ${entry.type === "folder" ? "[dir] " : "[file]"}${name}`);
  }

  const stat = await fs.stat("/greeting.txt");
  if (stat.type === "file") {
    console.log(`sha256(/greeting.txt) = ${stat.checksums.sha256}`);
  }

  await fs.delete("/assets", { recursive: true });
  const afterDelete = await fs.read("/assets/images/logo.png");
  console.log(`Recursive delete worked: ${String(afterDelete === undefined)}`);
} finally {
  await fs.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
