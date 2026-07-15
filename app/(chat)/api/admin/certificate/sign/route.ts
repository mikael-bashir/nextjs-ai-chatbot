import type { NextRequest } from 'next/server';
import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import { fullCertificate } from '@/lib/certificate';
import { signCertificate } from '@/lib/certificate-sign';

// Sign a proof certificate RIGHT AFTER the kernel verifies it, from the admin
// panel — so the certificate is minted as close as possible to the moment the
// proof was checked (semantic assurance that the signed bytes are exactly what
// the kernel saw). Server-side only: the Ed25519 private key
// (CERT_SIGN_PRIVATE_KEY) never touches the browser or the bridge.
//
// Returns { signature, keyId, certMintedAt } — `certMintedAt` is the signing
// moment. The signature covers the canonical certificate (header + proof) built
// from the SAME fields CompeteMath stores, so CompeteMath rebuilds identical
// bytes and serves this exact signature. If no key is configured, returns
// { signature: null } and the caller ships an unsigned cert (unchanged behaviour).
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!isAdminEmail(session?.user?.email)) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  const proof = typeof body?.proof === 'string' ? body.proof : '';
  const title = typeof body?.title === 'string' ? body.title : null;
  const verifiedAt =
    typeof body?.verifiedAt === 'string' ? body.verifiedAt : null;
  if (!proof.trim()) {
    return Response.json({ error: 'proof required' }, { status: 400 });
  }

  const certMintedAt = new Date().toISOString();
  const canonical = fullCertificate(proof, {
    title,
    mintedAt: certMintedAt, // signing moment (this call)
    provedAt: verifiedAt, // real kernel-verify moment
  }).trimEnd();
  const sig = signCertificate(canonical);
  if (!sig) {
    // No signing key on this host — caller degrades to an unsigned certificate.
    return Response.json({ signature: null, keyId: null, certMintedAt: null });
  }
  return Response.json({
    signature: sig.signature,
    keyId: sig.keyId,
    certMintedAt,
  });
}
