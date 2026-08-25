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

const key = "/examples/multipart.bin";
try {
  const upload = await fs.createMultipartUpload(key);
  console.log(`Started multipart upload ${upload.uploadId} for ${key}`);

  const parts = ["part-one;", "part-two;", "part-three!"].map((text) => new Blob([text]));
  const uploaded = [];
  for (const [index, part] of parts.entries()) {
    const result = await upload.uploadPart(index + 1, part);
    console.log(`Part ${result.partNumber}: etag ${result.etag}`);
    uploaded.push(result);
  }

  await upload.complete(uploaded);
  const blob = await fs.read(key);
  console.log(`Completed object content: ${(await blob?.text()) ?? "<missing>"}`);
} catch (error) {
  console.error(`Multipart example failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await fs.delete(key, { recursive: false });
  await fs.dispose();
}
