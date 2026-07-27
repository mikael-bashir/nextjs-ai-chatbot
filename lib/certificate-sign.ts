// SERVER-ONLY. Ed25519 signing/verification for proof certificates.
//
// Why a signature and not just a hash: a bare SHA-256 shown next to its own
// content proves nothing against a malicious actor — they edit the proof, hash
// the new text, and swap the digest. A *signature* fixes this: the server signs
// the certificate with a PRIVATE key that only it holds; anyone verifies with
// the PUBLIC key. Change one byte of the content and the signature no longer
// verifies, and a forger can't produce a fresh valid signature without the
// private key. That is what makes tampering detectable.
import crypto from "node:crypto";
import { CERTIFICATE, CERT_KEYS, SIGNATURE_MARKER, publicKeyForKeyId, type CertKeyGroup } from "./certificate";

// Each toolchain group signs with its OWN private key — certificates from
// different groups are independent artifacts by design (see CERT_KEYS). The
// legacy env var name is kept as-is for backward compatibility; only the new
// architect group gets a distinct var.
const PRIVATE_KEY_ENV: Record<CertKeyGroup, string> = {
  legacy: "CERT_SIGN_PRIVATE_KEY",
  architect: "CERT_SIGN_PRIVATE_KEY_ARCHITECT",
};

function loadPrivateKey(group: CertKeyGroup): crypto.KeyObject | null {
  const b64 = process.env[PRIVATE_KEY_ENV[group]];
  if (!b64) return null;
  try {
    const pem = Buffer.from(b64, "base64").toString("utf8");
    return crypto.createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
  } catch {
    return null;
  }
}

export interface CertSignature {
  signature: string; // base64 Ed25519 signature over the canonical content
  keyId: string;
  publicKey: string; // base64 SPKI PEM (same as CERT_KEYS[group].publicKey)
}

// Sign the canonical certificate content (the exact bytes above the signature
// banner) with the key for the given toolchain group. Returns null if that
// group's signing key isn't configured — callers degrade to an unsigned
// certificate rather than failing. Defaults to "legacy" so existing call
// sites that don't pass a group keep behaving exactly as before.
export function signCertificate(canonical: string, group: CertKeyGroup = "legacy"): CertSignature | null {
  const key = loadPrivateKey(group);
  if (!key) return null;
  const signature = crypto
    .sign(null, Buffer.from(canonical, "utf8"), key)
    .toString("base64");
  return { signature, keyId: CERT_KEYS[group].keyId, publicKey: CERT_KEYS[group].publicKey };
}

// The full copyable, self-verifiable artifact: canonical content + a signature
// banner + block. A verifier splits at SIGNATURE_MARKER and checks the sig over
// everything before it.
export function buildSignedText(canonical: string, sig: CertSignature): string {
  const block =
    `Key-ID     : ${sig.keyId}\n` +
    `Algorithm  : Ed25519\n` +
    `Signature  : ${sig.signature}\n` +
    `Public-Key : ${sig.publicKey}\n\n` +
    `To verify: split this file at the banner above; Ed25519-verify the\n` +
    `signature over the exact bytes preceding it, using the public key.\n`;
  return canonical + SIGNATURE_MARKER + block;
}

// Verify a pasted, signed certificate. Recovers the canonical content
// (everything before the banner) and the DECLARED Key-ID from the block, looks
// up which public key that Key-ID actually belongs to (independent of which
// toolchain group this is — the cert is self-describing), and checks the
// embedded signature against that key. Returns { valid, keyId }.
export function verifySignedText(pasted: string): { valid: boolean; keyId: string } {
  const i = pasted.indexOf(SIGNATURE_MARKER);
  if (i === -1) return { valid: false, keyId: CERTIFICATE.keyId };
  const content = pasted.slice(0, i);
  const block = pasted.slice(i);
  const sigMatch = block.match(/Signature\s*:\s*([A-Za-z0-9+/=]+)/);
  const keyIdMatch = block.match(/Key-ID\s*:\s*([0-9a-f]+)/i);
  if (!sigMatch) return { valid: false, keyId: CERTIFICATE.keyId };
  const signature = sigMatch[1];
  const declaredKeyId = keyIdMatch?.[1] ?? CERTIFICATE.keyId;
  const keyInfo = publicKeyForKeyId(declaredKeyId);
  try {
    // 1) The signature must be authentic over the exact certificate content
    //    (header + full proof — everything above the banner), under the key
    //    the certificate itself claims to be signed with.
    const pem = Buffer.from(keyInfo.publicKey, "base64").toString("utf8");
    const sigOk = crypto.verify(
      null,
      Buffer.from(content, "utf8"),
      crypto.createPublicKey({ key: pem, format: "pem", type: "spki" }),
      Buffer.from(signature, "base64"),
    );
    if (!sigOk) return { valid: false, keyId: declaredKeyId };
    // 2) The WHOLE artifact must be byte-identical to one we would emit for this
    //    content + signature. This closes the gap where extra text is appended
    //    after the signature block: a "valid" result now covers the entire
    //    certificate, not merely the region above the banner.
    const rebuilt = buildSignedText(content, {
      signature,
      keyId: keyInfo.keyId,
      publicKey: keyInfo.publicKey,
    });
    return { valid: rebuilt === pasted, keyId: keyInfo.keyId };
  } catch {
    return { valid: false, keyId: declaredKeyId };
  }
}
