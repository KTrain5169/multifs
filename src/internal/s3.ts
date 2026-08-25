import type {
  AllStat,
  DirectoryListing,
  DriverInterface,
  MultipartUpload,
  UploadedMultiparts,
  Watcher,
} from "../types.ts";
import {
  awsUriEncode,
  decodeXmlEntities,
  signRequest,
  stripQuotes,
  xmlBlocks,
  xmlText,
} from "../utils.ts";

export interface S3DriverOptions {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  endpoint?: string;
}

interface RequestExtras {
  query?: Array<[string, string]>;
  headers?: Record<string, string>;
  body?: Blob | Uint8Array;
}

function encodeS3Key(key: string): string {
  return awsUriEncode(key.replace(/^\/+/, ""));
}

export function createS3Driver(options: S3DriverOptions): DriverInterface<S3DriverOptions> {
  const region = options.region ?? "us-east-1";
  const endpoint = options.endpoint ?? `https://s3.${region}.amazonaws.com`;
  const uploads = new Map<string, { filePath: string; nextPartNumber: number }>();

  async function request(
    method: string,
    key: string,
    extras: RequestExtras = {},
  ): Promise<Response> {
    const cleanKey = key.replace(/^\/+/, "");
    const signed = await signRequest({
      method,
      url: `${endpoint}/${options.bucket}${cleanKey ? `/${encodeS3Key(cleanKey)}` : ""}`,
      query: extras.query,
      headers: extras.headers,
      body: extras.body,
      region,
      service: "s3",
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    });
    return fetch(signed.url, {
      method: signed.method,
      headers: signed.headers,
      body: extras.body,
    });
  }

  function assertOk(response: Response, action: string): void {
    if (!response.ok) {
      throw new Error(`S3 ${action} failed with status ${response.status}: ${response.statusText}`);
    }
  }

  const noopWatcher = (): Watcher => ({
    listener: () => {},
    stop() {},
  });

  return {
    name: "s3",
    raw: options,

    async read(filePath) {
      const response = await request("GET", filePath);
      if (response.status === 404) {
        return undefined;
      }
      assertOk(response, `read "${filePath}"`);
      return new Blob([await response.arrayBuffer()]);
    },
    async write(filePath, contents) {
      const response = await request("PUT", filePath, {
        body: contents,
        headers: { "content-type": contents.type || "application/octet-stream" },
      });
      assertOk(response, `write "${filePath}"`);
    },

    async delete(filePath) {
      const response = await request("DELETE", filePath);
      if (response.status !== 204 && response.status !== 404) {
        assertOk(response, `delete "${filePath}"`);
      }
    },

    async stat(filePath) {
      const response = await request("HEAD", filePath);
      if (response.status === 404) {
        throw new Error(`File not found: ${filePath}`);
      }
      assertOk(response, `stat "${filePath}"`);
      return {
        type: "file",
        checksums: { sha1: "", sha256: "", sha512: "" },
      } satisfies AllStat;
    },

    async ls(dir) {
      const prefix = dir === "/" ? "" : `${dir.replace(/^\//, "").replace(/\/$/, "")}/`;
      const listing: DirectoryListing = {};
      let continuationToken: string | undefined;

      do {
        const query: Array<[string, string]> = [
          ["list-type", "2"],
          ["delimiter", "/"],
          ["max-keys", "1000"],
          ["prefix", prefix],
        ];
        if (continuationToken) {
          query.push(["continuation-token", continuationToken]);
        }
        const response = await request("GET", "", { query });
        assertOk(response, `ls "${dir}"`);
        const xml = await response.text();

        for (const block of xmlBlocks(xml, "Contents")) {
          const key = decodeXmlEntities(xmlText(block, "Key") ?? "");
          if (!key || key === prefix) continue;
          if (key.endsWith("/")) {
            listing[key.slice(prefix.length).replace(/\/$/, "")] = { type: "folder", children: {} };
          } else {
            listing[key.slice(prefix.length)] = {
              type: "file",
              checksums: { sha1: "", sha256: "", sha512: "" },
            };
          }
        }
        for (const block of xmlBlocks(xml, "CommonPrefixes")) {
          const commonPrefix = decodeXmlEntities(xmlText(block, "Prefix") ?? "");
          if (!commonPrefix) continue;
          listing[commonPrefix.slice(prefix.length).replace(/\/$/, "")] = {
            type: "folder",
            children: {},
          };
        }

        continuationToken =
          (xmlText(xml, "IsTruncated") ?? "false") === "true"
            ? decodeXmlEntities(xmlText(xml, "NextContinuationToken") ?? "") || undefined
            : undefined;
      } while (continuationToken);

      return listing;
    },

    watch(_path, _listener): Watcher {
      return noopWatcher();
    },

    unwatch() {},

    async createMultipartUpload(filePath): Promise<MultipartUpload> {
      const response = await request("POST", filePath, { query: [["uploads", ""]] });
      assertOk(response, `create multipart upload for "${filePath}"`);
      const uploadId = decodeXmlEntities(xmlText(await response.text(), "UploadId") ?? "");
      uploads.set(uploadId, { filePath, nextPartNumber: 1 });

      return {
        filePath,
        uploadId,
        async uploadPart(part, value) {
          const partResponse = await request("PUT", filePath, {
            query: [
              ["partNumber", String(part)],
              ["uploadId", uploadId],
            ],
            body: value,
          });
          assertOk(partResponse, `upload part ${part} of "${filePath}"`);
          const record = uploads.get(uploadId);
          if (record) {
            record.nextPartNumber = Math.max(record.nextPartNumber, part + 1);
          }
          return { partNumber: part, etag: stripQuotes(partResponse.headers.get("etag")) };
        },
        async abort() {
          const abortResponse = await request("DELETE", filePath, {
            query: [["uploadId", uploadId]],
          });
          assertOk(abortResponse, `abort multipart upload "${filePath}"`);
        },
        async complete(uploadedParts: UploadedMultiparts[]) {
          const completeBody =
            "<CompleteMultipartUpload>" +
            uploadedParts
              .map(
                ({ partNumber, etag }) =>
                  `<Part><PartNumber>${partNumber}</PartNumber><ETag>${etag.replace(/"/g, "&quot;")}</ETag></Part>`,
              )
              .join("") +
            "</CompleteMultipartUpload>";
          const completeResponse = await request("POST", filePath, {
            query: [["uploadId", uploadId]],
            body: new TextEncoder().encode(completeBody),
          });
          assertOk(completeResponse, `complete multipart upload "${filePath}"`);
          const resultXml = await completeResponse.text();
          if (xmlText(resultXml, "Error")) {
            const code = xmlText(resultXml, "Code");
            const message = decodeXmlEntities(xmlText(resultXml, "Message") ?? "");
            throw new Error(
              `Completing multipart upload "${filePath}" failed${code ? ` (${code})` : ""}: ${message}`,
            );
          }
        },
      };
    },

    async resumeMultipartUpload(uploadId, content) {
      const record = uploads.get(uploadId);
      if (!record) {
        throw new Error(`Unknown multipart upload ID "${uploadId}".`);
      }
      const listPartsResponse = await request("GET", record.filePath, {
        query: [
          ["uploadId", uploadId],
          ["max-parts", "1000"],
        ],
      });
      assertOk(listPartsResponse, `resume multipart upload "${record.filePath}"`);
      const partsXml = await listPartsResponse.text();
      const highestPart = Math.max(
        0,
        ...xmlBlocks(partsXml, "Part").map((block) => Number(xmlText(block, "PartNumber") ?? "0")),
      );
      const partNumber = Math.max(record.nextPartNumber, highestPart + 1);
      record.nextPartNumber = partNumber + 1;

      const partResponse = await request("PUT", record.filePath, {
        query: [
          ["partNumber", String(partNumber)],
          ["uploadId", uploadId],
        ],
        body: content,
      });
      assertOk(partResponse, `resume multipart upload "${record.filePath}"`);
    },

    dispose() {
      uploads.clear();
    },
  };
}
