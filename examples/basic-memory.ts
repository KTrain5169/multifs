import { MultiFS } from "../src/index.ts";
import { memory } from "../src/drivers/memory.ts";

const fs = new MultiFS(
  memory({
    "/seeded/readme.md": "# Seeded at construction",
    "/seeded/license": "MIT",
  }),
);

try {
  console.log(`Seeded files: ${Object.keys(await fs.ls("/seeded")).join(", ")}`);

  await fs.write("/notes/today.txt", new Blob(["Buy more RAM."]));
  console.log(`Wrote /notes/today.txt: ${await (await fs.read("/notes/today.txt"))!.text()}`);

  const blob = await fs.read("/notes/today.txt");
  console.log(`Read back: ${(await blob?.text()) ?? "<missing>"}`);

  await fs.delete("/notes", { recursive: true });
  console.log(
    `After delete, /notes is gone: ${String((await fs.read("/notes/today.txt")) === undefined)}`,
  );

  const volume = fs.raw;
  console.log(`The raw memfs Volume exposes ${typeof volume.writeFileSync}`);
} finally {
  await fs.dispose();
}
