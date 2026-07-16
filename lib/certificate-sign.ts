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
import { CERTIFICATE, SIGNATURE_MARKER } from "./certificate";

function loadPrivateKey(): crypto.KeyObject | null {
  const b64 = process.env.CERT_SIGN_PRIVATE_KEY;
  if (!b64) return null;
  try {
    const pem = Buffer.from(b64, "base64").toString("utf8");
    return crypto.createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
  } catch {
    return null;
  }
}

function publicKeyObject(): crypto.KeyObject {
  const pem = Buffer.from(CERTIFICATE.publicKey, "base64").toString("utf8");
  return crypto.createPublicKey({ key: pem, format: "pem", type: "spki" });
}

export interface CertSignature {
  signature: string; // base64 Ed25519 signature over the canonical content
  keyId: string;
  publicKey: string; // base64 SPKI PEM (same as CERTIFICATE.publicKey)
}

// Sign the canonical certificate content (the exact bytes above the signature
// banner). Returns null if no signing key is configured — callers degrade to an
// unsigned certificate rather than failing.
export function signCertificate(canonical: string): CertSignature | null {
  const key = loadPrivateKey();
  if (!key) return null;
  const signature = crypto
    .sign(null, Buffer.from(canonical, "utf8"), key)
    .toString("base64");
  return { signature, keyId: CERTIFICATE.keyId, publicKey: CERTIFICATE.publicKey };
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

// Verify a pasted, signed certificate against the published public key.
// Recovers the canonical content (everything before the banner) and checks the
// embedded signature over it. Returns { valid, keyId }.
export function verifySignedText(pasted: string): { valid: boolean; keyId: string } {
  const i = pasted.indexOf(SIGNATURE_MARKER);
  if (i === -1) return { valid: false, keyId: CERTIFICATE.keyId };
  const content = pasted.slice(0, i);
  const block = pasted.slice(i);
  const m = block.match(/Signature\s*:\s*([A-Za-z0-9+/=]+)/);
  if (!m) return { valid: false, keyId: CERTIFICATE.keyId };
  const signature = m[1];
  try {
    // 1) The signature must be authentic over the exact certificate content
    //    (header + full proof — everything above the banner).
    const sigOk = crypto.verify(
      null,
      Buffer.from(content, "utf8"),
      publicKeyObject(),
      Buffer.from(signature, "base64"),
    );
    if (!sigOk) return { valid: false, keyId: CERTIFICATE.keyId };
    // 2) The WHOLE artifact must be byte-identical to one we would emit for this
    //    content + signature. This closes the gap where extra text is appended
    //    after the signature block: a "valid" result now covers the entire
    //    certificate, not merely the region above the banner.
    const rebuilt = buildSignedText(content, {
      signature,
      keyId: CERTIFICATE.keyId,
      publicKey: CERTIFICATE.publicKey,
    });
    return { valid: rebuilt === pasted, keyId: CERTIFICATE.keyId };
  } catch {
    return { valid: false, keyId: CERTIFICATE.keyId };
  }
}
