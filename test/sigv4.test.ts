import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";

import { amzDateFormat, awsUriEncode, computeChecksums, signRequest } from "../src/utils.ts";

const DOCS_SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const DOCS_ACCESS_KEY = "AKIDEXAMPLE";

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

describe("SigV4 signing", () => {
  it("matches the AWS documentation GET example end-to-end", async () => {
    const canonicalRequest = [
      "GET",
      "/test.txt",
      "",
      "host:examplebucket.s3.amazonaws.com\nrange:bytes=0-9\nx-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nx-amz-date:20130524T000000Z\n",
      "host;range;x-amz-content-sha256;x-amz-date",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ].join("\n");

    const scope = "20130524/us-east-1/s3/aws4_request";
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      "20130524T000000Z",
      scope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");

    const kSigning = hmac(
      hmac(hmac(hmac(`AWS4${DOCS_SECRET}`, "20130524"), "us-east-1"), "s3"),
      "aws4_request",
    );
    const expectedSignature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

    const signed = await signRequest({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      headers: { range: "bytes=0-9" },
      accessKeyId: DOCS_ACCESS_KEY,
      secretAccessKey: DOCS_SECRET,
      region: "us-east-1",
      service: "s3",
      now: new Date("2013-05-24T00:00:00Z"),
    });

    expect(signed.headers["x-amz-date"]).toBe("20130524T000000Z");
    expect(signed.headers.authorization).toContain(`Credential=${DOCS_ACCESS_KEY}/${scope}`);
    expect(signed.headers.authorization).toContain(
      "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date",
    );
    expect(signed.headers.authorization).toContain(`Signature=${expectedSignature}`);
  });

  it("signs request payloads with their sha256 hash", async () => {
    const payload = new TextEncoder().encode("payload-bytes");
    const payloadHash = createHash("sha256").update(payload).digest("hex");
    const signed = await signRequest({
      method: "PUT",
      url: "https://bucket.s3.local/key.bin",
      body: payload,
      accessKeyId: "AK",
      secretAccessKey: "SK",
      region: "auto",
      service: "s3",
      now: new Date("2024-01-02T03:04:05Z"),
    });
    expect(signed.headers["x-amz-content-sha256"]).toBe(payloadHash);
    expect(signed.url).toBe("https://bucket.s3.local/key.bin");
  });

  it("builds sorted canonical queries", async () => {
    const signed = await signRequest({
      method: "GET",
      url: "https://s3.example/bucket/",
      query: [
        ["zebra", "last"],
        ["prefix", "a/b"],
        ["list-type", "2"],
      ],
      accessKeyId: "AK",
      secretAccessKey: "SK",
      region: "us-east-1",
      service: "s3",
    });
    const query = signed.url.slice(signed.url.indexOf("?") + 1);
    expect(query).toBe("list-type=2&prefix=a%2Fb&zebra=last");
  });
});

describe("utils", () => {
  it("encodes S3 keys per segment while preserving slashes", () => {
    expect(awsUriEncode("hello world/file+name.txt")).toBe("hello%20world/file%2Bname.txt");
    expect(awsUriEncode("a/b c", false)).toBe("a/b%20c");
    expect(awsUriEncode("safe-key._~")).toBe("safe-key._~");
  });

  it("formats amz dates", () => {
    expect(amzDateFormat(new Date("2013-05-24T00:00:00Z"))).toBe("20130524T000000Z");
  });

  it("computes all three checksums", async () => {
    const bytes = new TextEncoder().encode("hello world");
    const checksums = await computeChecksums(bytes);
    expect(checksums.sha256).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
    expect(checksums.sha1).toBe("2aae6c35c94fcfb415dbe95f408b9ce91ee846ed");
    expect(checksums.sha512).toMatch(/^[0-9a-f]{128}$/);
  });
});
