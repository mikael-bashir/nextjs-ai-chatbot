// ⚠️  KEEP BYTE-IDENTICAL with compete-math `src/app/lib/certificate.ts`.
// Leak signs the certificate at verify time; CompeteMath rebuilds the SAME
// canonical bytes to serve/verify the signature. Any divergence in the header
// format, toolchain, keys, or fmtCertDate here breaks every signature. Edit both.
//
// Proof certificates ---------------------------------------------------------
// Every practice problem sourced from the Leak prover ships a machine-checked
// Lean proof. We present that proof as a CERTIFICATE: the proof script plus the
// provenance a reader needs to trust it — when it was minted (the moment this
// certificate's signature was first generated), when the proof was enforced
// (machine-checked), the exact toolchain it was enforced against, and a support
// contact. Toolchain/Mathlib/email are hardcoded for now.

export const CERTIFICATE = {
  issuer: "CompeteMath",
  // The prover that searched for and machine-checked (enforced) the proof.
  // NOTE: confirm/adjust proverUrl — set to the public Leak deployment.
  prover: "Leak",
  proverUrl: "https://leak.competemath.com",
  // The Lean toolchain + Mathlib revision every current proof is enforced against.
  toolchain: "Lean 4.29.1",
  mathlib: "Mathlib v4.29.1",
  // Public support contact printed on every certificate.
  supportEmail: "bashir.mikael@outlook.com",
  // Ed25519 PUBLIC key (base64-encoded SPKI PEM) that certificates are signed
  // with. This is public by design — anyone can verify a certificate's signature
  // against it. The matching PRIVATE key lives only in CERT_SIGN_PRIVATE_KEY
  // (server env, never committed); without it, nobody can forge a signature.
  publicKey:
    "LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUNvd0JRWURLMlZ3QXlFQWF1WXJDbitsb2ErTGhadzBJN1QxQkROcEJjMno3VTJ1UDZGaERQNDlVUlU9Ci0tLS0tRU5EIFBVQkxJQyBLRVktLS0tLQo=",
  // Short fingerprint (first 16 hex of SHA-256 of the public-key PEM) for display.
  keyId: "120beb3b40504cca",
} as const;

// Banner that separates the signed certificate content from the appended
// signature block. A verifier splits the pasted text here: everything BEFORE
// the banner is the exact byte sequence the Ed25519 signature covers.
export const SIGNATURE_MARKER = "\n\n───────  CompeteMath signature (Ed25519)  ───────\n";

// Human-readable UTC date, e.g. "5 Jul 2026, 15:19 UTC". Falsy input → "—".
export function fmtCertDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }) + " UTC";
}

export interface CertificateMeta {
  title?: string | null;
  mintedAt?: string | null;
  provedAt?: string | null;
  /** Lean toolchain + Mathlib version that ACTUALLY certified this proof. The
   *  verifier groups are not on the same Lean (Leak XI/XII/XIV run 4.32.0, Leak
   *  I/II/IV run 4.29.1), so a header that always printed the constant would be
   *  making a false claim about half the corpus. Omitted ⇒ falls back to the
   *  CERTIFICATE constant, which keeps every previously-signed certificate
   *  byte-identical (and therefore still verifiable). */
  toolchain?: string | null;
  mathlib?: string | null;
}

// Render a run's toolchain the way the header has always read ("Lean 4.29.1"),
// accepting either the bare version or the full elan string the bridge reports
// ("leanprover/lean4:v4.32.0"). No per-run value ⇒ the constant, so certificates
// signed before toolchain was recorded still hash to the same bytes.
function certToolchain(toolchain?: string | null): string {
  const t = (toolchain ?? "").trim();
  if (!t) return CERTIFICATE.toolchain;
  const v = t.replace(/^leanprover\/lean4:v?/, "").replace(/^v/, "");
  return `Lean ${v}`;
}
function certMathlib(mathlib?: string | null): string {
  const m = (mathlib ?? "").trim();
  if (!m) return CERTIFICATE.mathlib;
  return m.startsWith("Mathlib") ? m : `Mathlib ${m}`;
}

// A Lean block-comment header stamped onto the proof for the copy/download form.
// Being a comment, it never affects compilation — the script still verifies.
export function certificateHeader(meta: CertificateMeta): string {
  const line = "═".repeat(58);
  return [
    "/-",
    `  ${line}`,
    `  ${CERTIFICATE.issuer} — Proof Certificate`,
    `  ${line}`,
    `  Problem   : ${meta.title ?? "—"}`,
    `  Verified  : ${fmtCertDate(meta.provedAt)}  (machine-checked by the Lean kernel)`,
    `  Minted    : ${fmtCertDate(meta.mintedAt)}  (certificate signed)`,
    `  Enforcer  : ${CERTIFICATE.prover} · ${CERTIFICATE.proverUrl}`,
    `  Toolchain : ${certToolchain(meta.toolchain)} · ${certMathlib(meta.mathlib)}`,
    `  Support   : ${CERTIFICATE.supportEmail}`,
    `  ${line}`,
    "-/",
    "",
  ].join("\n");
}

// The full downloadable/copyable certificate: header comment + the proof script.
export function fullCertificate(proof: string, meta: CertificateMeta): string {
  return certificateHeader(meta) + (proof ?? "").trimEnd() + "\n";
}
