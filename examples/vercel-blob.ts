import { vercelBlob } from "../src/drivers/vercel.ts";
import { MultiFS } from "../src/index.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Set ${name} to run this example.`);
    process.exit(1);
  }
  return value;
}

const fs = new MultiFS(vercelBlob({ token: requireEnv("BLOB_READ_WRITE_TOKEN") }));

try {
  await fs.write("/examples/hello.txt", new Blob(["Hello from Vercel Blob."]));
  console.log(`Read back: ${await (await fs.read("/examples/hello.txt"))!.text()}`);

  const listing = await fs.ls("/");
  console.log(`Top level: ${Object.keys(listing).join(", ") || "(empty)"}`);

  const stat = await fs.stat("/examples/hello.txt");
  console.log(`stat type: ${stat.type}`);
} finally {
  await fs.delete("/examples/hello.txt");
  await fs.dispose();
}
