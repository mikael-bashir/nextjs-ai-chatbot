'use client';

import type { CreditTransaction } from '@/lib/db/schema';

const TYPE_LABELS: Record<string, string> = {
  grant: 'Grant',
  purchase: 'Purchase',
  usage: 'Usage',
  refund: 'Refund',
};

const TYPE_COLORS: Record<string, string> = {
  grant: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  purchase: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  usage: 'bg-muted text-muted-foreground',
  refund: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
};

interface Props {
  transactions: Array<CreditTransaction>;
  currentBalance: number;
}

export function UsageHistory({ transactions, currentBalance }: Props) {
  if (transactions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground px-6">
        <p className="text-sm">No transactions yet.</p>
      </div>
    );
  }

  let runningBalance = currentBalance;
  const rows = transactions.map((tx) => {
    const balanceAfter = runningBalance;
    runningBalance -= tx.amount;
    return { ...tx, balanceAfter };
  });

  return (
    <div className="overflow-x-auto rounded-b-lg">
      <table className="w-full text-sm" aria-label="Transaction history">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="px-6 py-3 text-left font-medium text-muted-foreground">
              Date
            </th>
            <th className="px-6 py-3 text-left font-medium text-muted-foreground">
              Description
            </th>
            <th className="px-6 py-3 text-left font-medium text-muted-foreground">
              Type
            </th>
            <th className="px-6 py-3 text-right font-medium text-muted-foreground">
              Amount
            </th>
            <th className="px-6 py-3 text-right font-medium text-muted-foreground">
              Balance
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((tx, i) => (
            <tr
              key={tx.id}
              className={`transition-colors hover:bg-muted/30 ${i % 2 === 0 ? '' : 'bg-muted/10'}`}
            >
              <td className="px-6 py-3 text-muted-foreground whitespace-nowrap">
                {new Date(tx.createdAt).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </td>
              <td className="px-6 py-3 max-w-[180px] truncate">{tx.description}</td>
              <td className="px-6 py-3">
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                    TYPE_COLORS[tx.type] ?? TYPE_COLORS.usage
                  }`}
                >
                  {TYPE_LABELS[tx.type] ?? tx.type}
                </span>
              </td>
              <td
                className={`px-6 py-3 text-right font-semibold tabular-nums ${
                  tx.amount > 0 ? 'text-green-600' : 'text-muted-foreground'
                }`}
              >
                {tx.amount > 0 ? `+${tx.amount}` : tx.amount}
              </td>
              <td className="px-6 py-3 text-right tabular-nums text-muted-foreground">
                {tx.balanceAfter}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
