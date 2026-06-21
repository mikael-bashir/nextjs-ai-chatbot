import { redirect } from 'next/navigation';
import { auth } from '@/app/(auth)/auth';
import { getOrCreateCreditBalance, getCreditTransactions } from '@/lib/db/queries';
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

export default async function AccountPage() {
  const session = await auth();
  if (!session?.user?.id || !session.user.hasLeakAccount) {
    redirect('/');
  }

  const userId = session.user.id;

  const [balance, transactions, rateLimit] = await Promise.all([
    getOrCreateCreditBalance({ userId }),
    getCreditTransactions({ userId, limit: 20, offset: 0 }),
    checkRateLimit({ userId }),
  ]);

  return (
    <main className="container mx-auto max-w-3xl px-4 py-8" aria-label="Account">
      <h1 className="mb-6 text-2xl font-bold">Account</h1>

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Credits Balance</CardTitle>
            <CardDescription>
              Last updated:{' '}
              {new Date().toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-between">
            <span className="text-4xl font-bold" aria-label={`${balance} credits`}>
              {balance} <span className="text-lg font-normal text-muted-foreground">credits</span>
            </span>
            <AddCreditsModal />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Rate Limit</CardTitle>
            <CardDescription>
              Resets at{' '}
              {rateLimit.resetAt.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              <span className="text-foreground font-semibold">
                {20 - rateLimit.remaining}
              </span>{' '}
              / 20 messages used this hour
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Usage History</CardTitle>
            <CardDescription>Your 20 most recent transactions</CardDescription>
          </CardHeader>
          <CardContent>
            <UsageHistory transactions={transactions} currentBalance={balance} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
