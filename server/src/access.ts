import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { ACCESS_TOKEN_LIMIT } from "@plan-quotas/shared";

export const API_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{43}$/;
const aad = Buffer.from("plan-quotas-api-access-v1");
export const AccessSchema = z
  .strictObject({
    version: z.literal(1),
    require_apikey: z.boolean(),
    tokens: z
      .array(
        z.strictObject({
          id: z.string().uuid(),
          created_at: z.string().datetime(),
          apikey: z.string().regex(API_KEY_PATTERN),
        }),
      )
      .max(ACCESS_TOKEN_LIMIT),
  })
  .refine(
    (value) =>
      new Set(value.tokens.map((row) => row.id)).size === value.tokens.length &&
      new Set(value.tokens.map((row) => row.apikey)).size ===
        value.tokens.length,
  );
export type StoredAccess = z.infer<typeof AccessSchema>;

/** Encrypt access mode and revealable keys with a domain distinct from provider credentials. */
export function encryptAccess(key: Buffer, access: StoredAccess): Buffer {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const bytes = Buffer.concat([
    cipher.update(JSON.stringify(AccessSchema.parse(access)), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return Buffer.from(
    JSON.stringify({
      v: 1,
      nonce: nonce.toString("hex"),
      ciphertext: bytes.toString("hex"),
    }),
  );
}

/** Authenticate and validate the entire access envelope before exposing any stored key. */
export function decryptAccess(key: Buffer, envelope: Buffer): StoredAccess {
  const value = z
    .strictObject({
      v: z.literal(1),
      nonce: z.string().regex(/^[a-f0-9]{24}$/),
      ciphertext: z.string().regex(/^(?:[a-f0-9]{2}){16,}$/),
    })
    .parse(JSON.parse(envelope.toString()));
  const bytes = Buffer.from(value.ciphertext, "hex"),
    decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(value.nonce, "hex"),
    );
  decipher.setAAD(aad);
  decipher.setAuthTag(bytes.subarray(-16));
  return AccessSchema.parse(
    JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(0, -16)),
        decipher.final(),
      ]).toString(),
    ),
  );
}
