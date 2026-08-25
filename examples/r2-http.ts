import { MultiFS } from "../src/index.ts";
import { s3 } from "../src/drivers/aws.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Set ${name} (plus MULTIFS_R2_BUCKET) to run this example.`);
    process.exit(1);
  }
  return value;
}

const bucket = process.env.MULTIFS_R2_BUCKET;
if (!bucket) {
  console.error("Set MULTIFS_R2_BUCKET to run this example.");
  process.exit(1);
}

const accountId = requireEnv("R2_ACCOUNT_ID");
const fs = new MultiFS(
  s3({
    bucket,
    accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  }),
);

try {
  await fs.write("/examples/r2.txt", new Blob(["Hello R2 via the S3-compatible endpoint."]));
  console.log(`Read back: ${await (await fs.read("/examples/r2.txt"))!.text()}`);
  console.log(`Listing: ${Object.keys(await fs.ls("/")).join(", ") || "(empty)"}`);
} finally {
  await fs.delete("/examples/r2.txt");
  await fs.dispose();
}
