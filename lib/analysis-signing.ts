export type MediaPurpose = "source" | "proxy";

export type MediaGrant = {
  method: "GET" | "PUT";
  videoId: string;
  analysisRunId: string;
  purpose: MediaPurpose;
  expires: number;
};

function messageFor(grant: MediaGrant) {
  return [grant.method, grant.videoId, grant.analysisRunId, grant.purpose, grant.expires].join("\n");
}

function toHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  return bytes;
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signMediaGrant(secret: string, grant: MediaGrant) {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(messageFor(grant)));
  return toHex(signature);
}

export async function verifyMediaGrant(secret: string, grant: MediaGrant, signature: string) {
  const bytes = fromHex(signature);
  if (!bytes || grant.expires < Math.floor(Date.now() / 1000)) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret), bytes, new TextEncoder().encode(messageFor(grant)));
}

export async function signedMediaUrl(origin: string, secret: string, grant: MediaGrant) {
  const url = new URL(`/api/analysis-media/${encodeURIComponent(grant.videoId)}`, origin);
  url.searchParams.set("run", grant.analysisRunId);
  url.searchParams.set("purpose", grant.purpose);
  url.searchParams.set("expires", String(grant.expires));
  url.searchParams.set("sig", await signMediaGrant(secret, grant));
  return url.toString();
}
