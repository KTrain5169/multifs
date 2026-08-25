import { netlifyBlobs } from "../src/drivers/netlify.ts";
import { MultiFS } from "../src/index.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Set ${name} (plus MULTIFS_NETLIFY_STORE) to run this example.`);
    process.exit(1);
  }
  return value;
}

const storeName = process.env.MULTIFS_NETLIFY_STORE;
if (!storeName) {
  console.error("Set MULTIFS_NETLIFY_STORE to run this example.");
  process.exit(1);
}

const fs = new MultiFS(
  netlifyBlobs(storeName, {
    siteID: requireEnv("NETLIFY_SITE_ID"),
    token: requireEnv("NETLIFY_TOKEN"),
  }),
);

try {
  await fs.write("/examples/note.txt", new Blob(["Stored in Netlify Blobs."]));
  console.log(`Read back: ${await (await fs.read("/examples/note.txt"))!.text()}`);

  const listing = await fs.ls("/");
  console.log(`Top level: ${Object.keys(listing).join(", ") || "(empty)"}`);

  const stat = await fs.stat("/examples/note.txt");
  console.log(`stat type: ${stat.type}`);
} finally {
  await fs.delete("/examples/note.txt");
  await fs.dispose();
}
