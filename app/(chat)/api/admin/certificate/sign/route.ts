import type { NextRequest } from 'next/server';
import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import { fullCertificate, certKeyGroup } from '@/lib/certificate';
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
  // The toolchain that actually certified this proof. Signed INTO the canonical
  // bytes, so the toolchain claim is covered by the signature and can't be
  // swapped afterwards. Absent ⇒ the certificate constant, which reproduces the
  // exact bytes of every certificate signed before this field existed.
  const toolchain = typeof body?.toolchain === 'string' ? body.toolchain : null;
  const mathlib = typeof body?.mathlib === 'string' ? body.mathlib : null;
  // Which specific strategy enforced this proof (e.g. "Leak Ultra Fleeting"),
  // for the certificate's Enforcer line. Absent ⇒ the bland "Leak" constant,
  // matching every certificate signed before this field existed.
  const enforcer = typeof body?.enforcer === 'string' ? body.enforcer : null;
  if (!proof.trim()) {
    return Response.json({ error: 'proof required' }, { status: 400 });
  }

  const certMintedAt = new Date().toISOString();
  const canonical = fullCertificate(proof, {
    title,
    mintedAt: certMintedAt, // signing moment (this call)
    provedAt: verifiedAt, // real kernel-verify moment
    toolchain,
    mathlib,
    enforcer,
  }).trimEnd();
  // Different toolchain groups sign with different keys — certificates are
  // independent artifacts even for the same problem (see CERT_KEYS).
  const sig = signCertificate(canonical, certKeyGroup(toolchain));
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
