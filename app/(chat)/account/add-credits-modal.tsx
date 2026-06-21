'use client';

import { useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CREDIT_PACKS, SUBSCRIPTION_PLANS } from '@/lib/stripe-config';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export function AddCreditsModal() {
  const [isPending, startTransition] = useTransition();

  function startCheckout(payload: object) {
    startTransition(async () => {
      try {
        const res = await fetch('/api/stripe/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (data.url) {
          window.location.href = data.url;
        } else {
          toast.error(data.error ?? 'Something went wrong');
        }
      } catch {
        toast.error('Failed to start checkout');
      }
    });
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Add Credits
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Get Credits</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="topup" className="mt-2">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="topup">One-time top-up</TabsTrigger>
            <TabsTrigger value="subscribe">Subscribe</TabsTrigger>
          </TabsList>

          {/* ONE-TIME PACKS */}
          <TabsContent value="topup" className="mt-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              Buy a credit pack once — no recurring charge.
            </p>
            <div className="grid grid-cols-2 gap-3">
              {CREDIT_PACKS.map((pack) => (
                <button
                  key={pack.credits}
                  type="button"
                  disabled={isPending}
                  onClick={() =>
                    startCheckout({ type: 'one_time', credits: pack.credits })
                  }
                  className={`relative flex flex-col items-start gap-1 rounded-xl border p-4 text-left transition-colors hover:border-primary hover:bg-primary/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 ${'popular' in pack && pack.popular ? 'border-primary bg-primary/5' : 'border-border'}`}
                >
                  {'popular' in pack && pack.popular && (
                    <span className="absolute right-3 top-3 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground">
                      Popular
                    </span>
                  )}
                  <span className="text-2xl font-bold tabular-nums">{pack.credits}</span>
                  <span className="text-xs text-muted-foreground">credits</span>
                  <span className="mt-2 text-sm font-semibold">{fmt(pack.unitAmount)}</span>
                  <span className="text-xs text-muted-foreground">
                    {fmt(Math.round(pack.unitAmount / pack.credits))}/credit
                  </span>
                </button>
              ))}
            </div>
          </TabsContent>

          {/* SUBSCRIPTION PLANS */}
          <TabsContent value="subscribe" className="mt-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              Get credits every month. Cancel anytime.
            </p>
            <div className="space-y-2">
              {SUBSCRIPTION_PLANS.map((plan) => (
                <button
                  key={plan.id}
                  type="button"
                  disabled={isPending}
                  onClick={() =>
                    startCheckout({ type: 'subscription', planId: plan.id })
                  }
                  className={`relative flex w-full items-center justify-between rounded-xl border p-4 text-left transition-colors hover:border-primary hover:bg-primary/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 ${'popular' in plan && plan.popular ? 'border-primary bg-primary/5' : 'border-border'}`}
                >
                  {'popular' in plan && plan.popular && (
                    <span className="absolute right-3 top-3 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground">
                      Popular
                    </span>
                  )}
                  <div>
                    <p className="font-semibold">{plan.name}</p>
                    <p className="text-sm text-muted-foreground">{plan.description}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {plan.credits} credits/month
                    </p>
                  </div>
                  <div className="ml-4 shrink-0 text-right">
                    <p className="text-lg font-bold">{fmt(plan.unitAmount)}</p>
                    <p className="text-xs text-muted-foreground">/month</p>
                  </div>
                </button>
              ))}
            </div>
          </TabsContent>
        </Tabs>

        {isPending && (
          <p className="mt-2 text-center text-xs text-muted-foreground">
            Redirecting to Stripe checkout…
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
