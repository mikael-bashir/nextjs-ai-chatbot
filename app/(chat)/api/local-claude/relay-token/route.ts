import { auth } from "@/app/(auth)/auth"
import { signRelayToken } from "@/lib/local-claude/relay-token"

// Mints a relay token for the logged-in user. The Configuration tab bakes this
// into the setup command so the bridge can dial in as this user. Session-authed
// (normal /api protection), unlike the relay data paths which use the token.
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 })
  }
  return Response.json({ token: signRelayToken(session.user.id) })
}
