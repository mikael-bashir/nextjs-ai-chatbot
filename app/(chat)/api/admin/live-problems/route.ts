import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';

// Titles/subtitles of problems already published on CompeteMath, fetched from
// its public archives API (server-side, so no CORS). Used only to feed the
// generator an "avoid these" list. Best-effort: returns [] on any failure.
const COMPETEMATH_PROBLEMS_URL = `${(
  process.env.COMPETEMATH_BASE_URL || 'https://www.competemath.com'
).replace(/\/$/, '')}/api/problems`;

export async function GET() {
  const session = await auth();
  if (!isAdminEmail(session?.user?.email)) {
    return new Response('Forbidden', { status: 403 });
  }
  try {
    const r = await fetch(COMPETEMATH_PROBLEMS_URL, {
      // Cache for an hour — the live set changes slowly.
      next: { revalidate: 3600 },
    });
    if (!r.ok) return Response.json({ problems: [] });
    const rows = await r.json();
    const problems = Array.isArray(rows)
      ? rows
          .map((x: any) => ({
            title: x?.title,
            subtitle: x?.subtitle ?? undefined,
            difficulty: x?.difficulty ?? undefined,
          }))
          .filter((x: { title?: string }) => !!x.title)
      : [];
    return Response.json({ problems });
  } catch (error) {
    console.error('Error fetching live CompeteMath problems:', error);
    return Response.json({ problems: [] });
  }
}
