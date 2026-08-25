import { MultiFS } from "../src/index.ts";
import { memory } from "../src/drivers/memory.ts";

const root = new MultiFS(memory({ "/readme.md": "I live at the root." }));

const assets = new MultiFS(memory({ "/logo.png": "PNG-bytes-here" }));
const fonts = new MultiFS(memory({ "/inter.woff2": "WOFF2-bytes-here" }));

root.mount("/assets", assets);
root.mount("/assets/fonts", fonts);

try {
  console.log(`Root file: ${await (await root.read("/readme.md"))!.text()}`);
  console.log(`Served by /assets mount: ${await (await root.read("/assets/logo.png"))!.text()}`);
  console.log(
    `Deepest mount wins: ${await (await root.read("/assets/fonts/inter.woff2"))!.text()}`,
  );

  const assetsListing = await root.ls("/assets");
  console.log(`ls through the parent shows: ${Object.keys(assetsListing).join(", ")}`);

  await root.write("/assets/fonts/mono.woff2", new Blob(["MONO"]));
  console.log(`Writes route too: ${await (await fonts.read("/mono.woff2"))!.text()}`);

  root.unmount("/assets/fonts");
  const afterUnmount = await root.read("/assets/fonts/inter.woff2");
  console.log(`After unmount the path falls back to root: ${String(afterUnmount !== undefined)}`);

  try {
    root.mount("/assets", assets);
  } catch (error) {
    console.log(`Duplicate mounts throw: ${(error as Error).message}`);
  }

  root.mount("/assets", new MultiFS(memory()), true);
  console.log("...unless override=true is passed");
} finally {
  await root.dispose();
}
