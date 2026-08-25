import { createS3Driver } from "../internal/s3.ts";
import type { DriverInterface } from "../types.ts";

export interface S3DriverConfig {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  endpoint?: string;
}

export function s3(config: S3DriverConfig): DriverInterface<S3DriverConfig> {
  const driver = createS3Driver(config);
  return { ...driver, name: "aws-s3", raw: config };
}
