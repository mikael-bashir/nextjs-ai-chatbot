'use client';

import type { CreditTransaction } from '@/lib/db/schema';

interface Props {
  transactions: Array<CreditTransaction>;
  currentBalance: number;
}

export function UsageHistory({ transactions, currentBalance }: Props) {
  if (transactions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No transactions yet.</p>
    );
  }

  let runningBalance = currentBalance;
  const rows = transactions.map((tx) => {
    const balanceAfter = runningBalance;
    runningBalance -= tx.amount;
    return { ...tx, balanceAfter };
  });

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" aria-label="Transaction history">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="pb-2 pr-4 font-medium">Date</th>
            <th className="pb-2 pr-4 font-medium">Description</th>
            <th className="pb-2 pr-4 font-medium text-right">Amount</th>
            <th className="pb-2 font-medium text-right">Balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((tx) => (
            <tr key={tx.id} className="border-b last:border-0">
              <td className="py-2 pr-4 text-muted-foreground whitespace-nowrap">
                {new Date(tx.createdAt).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </td>
              <td className="py-2 pr-4">{tx.description}</td>
              <td
                className={`py-2 pr-4 text-right font-medium tabular-nums ${
                  tx.amount > 0 ? 'text-green-600' : 'text-red-600'
                }`}
              >
                {tx.amount > 0 ? `+${tx.amount}` : tx.amount}
              </td>
              <td className="py-2 text-right tabular-nums">{tx.balanceAfter}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
