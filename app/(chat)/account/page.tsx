import Image from 'next/image';
import { redirect } from 'next/navigation';
import { auth } from '@/app/(auth)/auth';
import {
  getOrCreateCreditBalance,
  getCreditTransactions,
  getEarliestCreditTransaction,
} from '@/lib/db/queries';
import { checkRateLimit } from '@/lib/ratelimit';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { AddCreditsModal } from './add-credits-modal';
import { UsageHistory } from './usage-history';

const RATE_LIMIT = 20;

function RateLimitBar({ used, total }: { used: number; total: number }) {
  const pct = Math.min(100, Math.round((used / total) * 100));
  const color =
    pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all ${color}`}
        style={{ width: `${pct}%` }}
        role="progressbar"
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={total}
      />
    </div>
  );
}

export default async function AccountPage() {
  const session = await auth();
  if (!session?.user?.id || !session.user.hasLeakAccount) {
    redirect('/');
  }

  const userId = session.user.id;
  const user = session.user;

  const [balance, transactions, rateLimit, firstTx] = await Promise.all([
    getOrCreateCreditBalance({ userId }),
    getCreditTransactions({ userId, limit: 20, offset: 0 }),
    checkRateLimit({ userId }),
    getEarliestCreditTransaction({ userId }),
  ]);

  const used = RATE_LIMIT - rateLimit.remaining;
  const memberSince = firstTx
    ? new Date(firstTx.createdAt).toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
      })
    : null;

  const displayName = user.name ?? user.email?.split('@')[0] ?? 'User';
  const avatarSrc =
    user.image ?? `https://avatar.vercel.sh/${encodeURIComponent(user.email ?? '')}`;

  return (
    <main className="min-h-screen bg-background">
      {/* Profile hero */}
      <div className="border-b bg-gradient-to-b from-muted/40 to-background">
        <div className="container mx-auto max-w-4xl px-6 py-10">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-5">
            <div className="relative">
              <Image
                src={avatarSrc}
                alt={displayName}
                width={80}
                height={80}
                className="rounded-full ring-2 ring-border"
              />
              <span
                className="absolute bottom-0 right-0 h-4 w-4 rounded-full bg-green-500 ring-2 ring-background"
                aria-label="Online"
              />
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <h1 className="text-2xl font-bold truncate">{displayName}</h1>
                <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary ring-1 ring-inset ring-primary/20">
                  Free Plan
                </span>
              </div>
              <p className="text-sm text-muted-foreground truncate">{user.email}</p>
              {memberSince && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Member since {memberSince}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="container mx-auto max-w-4xl px-6 py-8 space-y-6">
        {/* Stat strip */}
        <div className="grid grid-cols-3 gap-4">
          <Card>
            <CardContent className="pt-6">
              <p className="text-3xl font-bold tabular-nums">{balance}</p>
              <p className="text-xs text-muted-foreground mt-1">Available credits</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-3xl font-bold tabular-nums">
                {used}
                <span className="text-lg font-normal text-muted-foreground">
                  /{RATE_LIMIT}
                </span>
              </p>
              <p className="text-xs text-muted-foreground mt-1">Messages this hour</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-3xl font-bold text-green-600">Active</p>
              <p className="text-xs text-muted-foreground mt-1">Account status</p>
            </CardContent>
          </Card>
        </div>

        {/* Credits + rate limit side-by-side on large screens */}
        <div className="grid gap-4 md:grid-cols-2">
          {/* Credits card */}
          <Card>
            <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
              <div>
                <CardTitle className="text-base">Credits</CardTitle>
                <CardDescription className="text-xs">
                  Used for AI chat messages
                </CardDescription>
              </div>
              <AddCreditsModal />
            </CardHeader>
            <CardContent>
              <p
                className="text-5xl font-bold tabular-nums"
                aria-label={`${balance} credits`}
              >
                {balance}
              </p>
              <p className="text-sm text-muted-foreground mt-1">credits available</p>
              {balance === 0 && (
                <p className="mt-3 text-sm text-destructive font-medium">
                  You&#39;re out of credits — add more to continue chatting.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Rate limit card */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Message Rate Limit</CardTitle>
              <CardDescription className="text-xs">
                Resets at{' '}
                {rateLimit.resetAt.toLocaleTimeString('en-US', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <RateLimitBar used={used} total={RATE_LIMIT} />
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  <span className="font-semibold text-foreground">{used}</span> of{' '}
                  {RATE_LIMIT} messages used
                </span>
                <span className="text-muted-foreground">
                  {rateLimit.remaining} remaining
                </span>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Account details */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Account Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-border">
              {[
                { label: 'Email', value: user.email },
                {
                  label: 'User ID',
                  value: userId.slice(0, 8) + '…',
                  mono: true,
                },
                { label: 'Plan', value: 'Free' },
                ...(memberSince ? [{ label: 'Member since', value: memberSince }] : []),
              ].map(({ label, value, mono }) => (
                <div
                  key={label}
                  className="flex items-center justify-between py-3 text-sm"
                >
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className={mono ? 'font-mono text-xs' : 'font-medium'}>{value}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>

        {/* Transaction history */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Transaction History</CardTitle>
            <CardDescription className="text-xs">
              Your 20 most recent credit events
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <UsageHistory transactions={transactions} currentBalance={balance} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
