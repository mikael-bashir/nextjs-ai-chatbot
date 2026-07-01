import "server-only"

import crypto from "node:crypto"

// Signed token that identifies which user's machine a relay connection belongs
// to. HMAC over AUTH_SECRET — no new dependency, no DB column. The bridge
// presents it when it dials in; the OpenAI relay endpoint trusts the routing
// key derived from it.
const SECRET = process.env.AUTH_SECRET || ""

const THIRTY_DAYS = 60 * 60 * 24 * 30

export function signRelayToken(userId: string, ttlSeconds = THIRTY_DAYS): string {
  const payload = Buffer.from(
    JSON.stringify({ u: userId, e: Date.now() + ttlSeconds * 1000 }),
  ).toString("base64url")
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url")
  return `${payload}.${sig}`
}

// Returns the userId if the token is valid and unexpired, else null.
export function verifyRelayToken(token: string | null | undefined): string | null {
  if (!token) return null
  const [payload, sig] = token.split(".")
  if (!payload || !sig) return null

  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url")
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

  try {
    const { u, e } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    if (typeof u !== "string" || typeof e !== "number" || Date.now() > e) return null
    return u
  } catch {
    return null
  }
}
