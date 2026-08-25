export interface Checksums {
  sha1: string;
  sha256: string;
  sha512: string;
}

export type BinaryData = Blob | Uint8Array | string;

const textEncoder = new TextEncoder();

export function toHex(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

export async function toBytes(value: BinaryData): Promise<Uint8Array> {
  if (typeof value === "string") {
    return textEncoder.encode(value);
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  return new Uint8Array(await value.arrayBuffer());
}

export function blobFromBytes(bytes: Uint8Array): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer]);
}

function viewToArrayBuffer(view: ArrayBufferView<ArrayBufferLike>): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

async function digest(
  algorithm: "SHA-1" | "SHA-256" | "SHA-512",
  data: ArrayBufferView,
): Promise<ArrayBuffer> {
  return crypto.subtle.digest(algorithm, viewToArrayBuffer(data));
}

export async function computeChecksums(bytes: Uint8Array): Promise<Checksums> {
  const [sha1, sha256, sha512] = await Promise.all([
    digest("SHA-1", bytes),
    digest("SHA-256", bytes),
    digest("SHA-512", bytes),
  ]);
  return {
    sha1: toHex(sha1),
    sha256: toHex(sha256),
    sha512: toHex(sha512),
  };
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return toHex(await digest("SHA-256", typeof data === "string" ? textEncoder.encode(data) : data));
}

const EMPTY_PAYLOAD_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function hmacKey(rawKey: ArrayBuffer | Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(rawKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function hmac(
  key: ArrayBuffer | Uint8Array,
  data: Uint8Array | string,
): Promise<ArrayBuffer> {
  const keyPromise = hmacKey(key);
  const bytes = typeof data === "string" ? textEncoder.encode(data) : data;
  return crypto.subtle.sign("HMAC", await keyPromise, viewToArrayBuffer(bytes));
}

const AWS_URI_UNRESERVED = /[A-Za-z0-9\-._~]/;

export function awsUriEncode(value: string, encodeSlash = false): string {
  let out = "";
  for (const char of value) {
    if (AWS_URI_UNRESERVED.test(char)) {
      out += char;
    } else if (char === "/") {
      out += encodeSlash ? "%2F" : "/";
    } else {
      const bytes = textEncoder.encode(char);
      for (const byte of bytes) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    }
  }
  return out;
}

export function amzDateFormat(date: Date): string {
  return `${date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "")}`;
}

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SignedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export interface SignRequestOptions extends SigV4Credentials {
  method: string;
  url: string;
  query?: Array<[string, string]>;
  headers?: Record<string, string>;
  body?: BinaryData;
  region: string;
  service: string;
  now?: Date;
}

export async function signRequest(options: SignRequestOptions): Promise<SignedRequest> {
  const { method, url, region, service } = options;
  const credentials: SigV4Credentials = {
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
  };
  const now = options.now ?? new Date();
  const amzDate = amzDateFormat(now);
  const dateStamp = amzDate.slice(0, 8);

  const urlObj = new URL(url);
  const queryPairs = options.query ?? [...urlObj.searchParams.entries()];
  const canonicalQuery = [...queryPairs]
    .map(([k, v]) => `${awsUriEncode(k, true)}=${awsUriEncode(v, true)}`)
    .sort()
    .join("&");

  const finalUrl = `${urlObj.origin}${urlObj.pathname}${canonicalQuery ? `?${canonicalQuery}` : ""}`;

  const bodyBytes = options.body === undefined ? undefined : await toBytes(options.body);
  const payloadHash = bodyBytes ? await sha256Hex(bodyBytes) : EMPTY_PAYLOAD_HASH;

  const allHeaders: Record<string, string> = {
    host: urlObj.host,
    ...Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()]),
    ),
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
  };
  const sortedHeaderNames = Object.keys(allHeaders)
    .map((name) => name.toLowerCase())
    .sort();
  const signedHeaders = sortedHeaderNames.join(";");
  const canonicalHeaders = sortedHeaderNames
    .map((name) => `${name}:${allHeaders[name].replace(/\s+/g, " ").trim()}\n`)
    .join("");

  const canonicalRequest = [
    method.toUpperCase(),
    awsUriEncode(urlObj.pathname),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(textEncoder.encode(canonicalRequest)),
  ].join("\n");

  const kDate = await hmac(textEncoder.encode(`AWS4${credentials.secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex(await hmac(kSigning, stringToSign));

  return {
    method: method.toUpperCase(),
    url: finalUrl,
    headers: {
      ...allHeaders,
      authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

export function xmlText(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return match?.[1];
}

export function xmlBlocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))].map(
    (m) => m[1],
  );
}

export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function stripQuotes(value: string | undefined | null): string {
  return (value ?? "").replace(/^"(.*)"$/s, "$1");
}
