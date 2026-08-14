import type { R2Bucket } from "@cloudflare/workers-types";

export function R2Binding<const TRawBucket extends R2Bucket>(bucket: TRawBucket, options?: {}) {}

export function R2HTTP(
  bucket: string,
  options?: {
    accountId: string;
    apiKey: string;
  },
) {}
