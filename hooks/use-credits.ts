'use client';

import { useEffect, useState } from 'react';

export function useCredits() {
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetch() {
      try {
        const res = await window.fetch('/api/credits');
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setBalance(data.balance);
      } catch {}
    }

    fetch();
    const id = setInterval(fetch, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return balance;
}
