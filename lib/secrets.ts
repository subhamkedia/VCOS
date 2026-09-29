import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Encryption for connector credentials at rest: AES-256-GCM with a 32-byte
 * key from VCOS_SECRET_KEY (base64). In development, a key is generated
 * once into .data/secret.key; production must set the variable, because
 * losing the key means every firm reconnects its tools.
 *
 * Ciphertext format: "v1:<iv b64>:<tag b64>:<data b64>".
 */

let cached: Buffer | null = null;

export function secretKey(): Buffer {
  if (cached) return cached;
  const env = process.env.VCOS_SECRET_KEY;
  if (env) {
    const k = Buffer.from(env, "base64");
    if (k.length !== 32) throw new Error("VCOS_SECRET_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32).");
    return (cached = k);
  }
  if (process.env.NODE_ENV === "production") throw new Error("Set VCOS_SECRET_KEY in production (openssl rand -base64 32).");
  const file = path.resolve(process.env.PGLITE_DIR ? path.dirname(process.env.PGLITE_DIR) : ".data", "secret.key");
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
  }
  return (cached = Buffer.from(readFileSync(file, "utf8").trim(), "base64"));
}

/** For tests: use a fixed key. */
export function setSecretKeyForTests(key: Buffer) {
  cached = key;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", secretKey(), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}

export function decrypt(ciphertext: string): string {
  const [v, iv, tag, data] = ciphertext.split(":");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Unrecognized ciphertext");
  const d = createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}

export const encryptJson = (v: unknown) => encrypt(JSON.stringify(v));
export const decryptJson = <T>(c: string) => JSON.parse(decrypt(c)) as T;
