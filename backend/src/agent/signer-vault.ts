import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Hex } from "viem";

export type EncryptedSigner = {
  encryptedPrivateKey: string;
  encryptionIv: string;
  encryptionAuthTag: string;
};

function vaultKey(secret: string) {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptSigner(privateKey: Hex, secret: string): EncryptedSigner {
  if (!secret || secret === "64_hex_characters") throw new Error("AGENT_SIGNER_ENCRYPTION_KEY must be replaced with a real secret before provisioning.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", vaultKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  return {
    encryptedPrivateKey: encrypted.toString("base64url"),
    encryptionIv: iv.toString("base64url"),
    encryptionAuthTag: cipher.getAuthTag().toString("base64url"),
  };
}

export function decryptSigner(value: EncryptedSigner, secret: string): Hex {
  if (!secret || secret === "64_hex_characters") throw new Error("AGENT_SIGNER_ENCRYPTION_KEY is not configured.");
  const decipher = createDecipheriv("aes-256-gcm", vaultKey(secret), Buffer.from(value.encryptionIv, "base64url"));
  decipher.setAuthTag(Buffer.from(value.encryptionAuthTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.encryptedPrivateKey, "base64url")),
    decipher.final(),
  ]).toString("utf8") as Hex;
}
