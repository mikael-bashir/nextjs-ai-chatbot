import { NextResponse } from 'next/server';
import { auth } from '@/app/(auth)/auth';
import { provisionLeakUser } from '@/lib/db/queries';

export async function POST(req: Request) {
  try {
    // 1. Securely grab the session from the encrypted HttpOnly cookie
    const session = await auth();

    // 2. Gatekeeper: Are they actually logged in?
    if (!session?.user?.id || !session?.user?.email) {
      return NextResponse.json(
        { error: 'Unauthorized: Valid session required' },
        { status: 401 }
      );
    }

    // 3. Gatekeeper: Do they already have an account?
    if (session.user.hasLeakAccount) {
      return NextResponse.json(
        { message: 'Account already provisioned!' },
        { status: 402 }
      );
    }

    // 4. Create the Postgres Row
    await provisionLeakUser({
      id: session.user.id,
      email: session.user.email,
    });

    // 5. Return success so the frontend knows it's safe to call update()
    return NextResponse.json(
      { success: true, message: 'Account successfully provisioned' },
      { status: 200 }
    );

  } catch (error) {
    console.error('Provisioning API Error:', error);
    return NextResponse.json(
      { error: 'Internal Server Error during provisioning' },
      { status: 500 }
    );
  }
}
