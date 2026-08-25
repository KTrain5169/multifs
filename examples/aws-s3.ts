import { MultiFS } from "../src/index.ts";
import { s3 } from "../src/drivers/aws.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Set ${name} (and MULTIFS_S3_BUCKET) to run this example.`);
    process.exit(1);
  }
  return value;
}

const bucket = process.env.MULTIFS_S3_BUCKET;
if (!bucket) {
  console.error("Set MULTIFS_S3_BUCKET to run this example.");
  process.exit(1);
}

const fs = new MultiFS(
  s3({
    bucket,
    accessKeyId: requireEnv("AWS_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("AWS_SECRET_ACCESS_KEY"),
    region: process.env.AWS_REGION ?? "us-east-1",
  }),
);

try {
  await fs.write("/examples/hello.txt", new Blob(["Hello from multifs over SigV4!"]));
  console.log(`Uploaded; read back: ${await (await fs.read("/examples/hello.txt"))!.text()}`);

  const listing = await fs.ls("/");
  console.log(`Bucket root now contains: ${Object.keys(listing).join(", ") || "(empty)"}`);

  const stat = await fs.stat("/examples/hello.txt");
  console.log(`stat type: ${stat.type}`);
} finally {
  await fs.delete("/examples/hello.txt");
  await fs.dispose();
}
