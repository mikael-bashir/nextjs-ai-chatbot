'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { addCreditsAction } from './actions';

const PRESET_AMOUNTS = [10, 50, 100, 500];

export function AddCreditsModal() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [custom, setCustom] = useState('');
  const [isPending, startTransition] = useTransition();

  const effectiveAmount = custom !== '' ? Number(custom) : selected;

  function handleSubmit() {
    if (!effectiveAmount || effectiveAmount < 1 || effectiveAmount > 10_000) {
      toast.error('Enter a valid amount between 1 and 10,000');
      return;
    }

    const formData = new FormData();
    formData.set('amount', String(effectiveAmount));

    startTransition(async () => {
      try {
        await addCreditsAction(formData);
        toast.success('Credits added');
        setOpen(false);
        setSelected(null);
        setCustom('');
      } catch {
        toast.error('Failed to add credits');
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button aria-label="Add credits to your account">Add Credits</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Credits</DialogTitle>
          <DialogDescription>
            Select a preset amount or enter a custom amount.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div
            className="grid grid-cols-4 gap-2"
            role="group"
            aria-label="Preset credit amounts"
          >
            {PRESET_AMOUNTS.map((amount) => (
              <Button
                key={amount}
                variant={selected === amount && custom === '' ? 'default' : 'outline'}
                onClick={() => {
                  setSelected(amount);
                  setCustom('');
                }}
                aria-pressed={selected === amount && custom === ''}
              >
                {amount}
              </Button>
            ))}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="custom-amount">Custom amount (1–10,000)</Label>
            <Input
              id="custom-amount"
              type="number"
              min={1}
              max={10000}
              placeholder="Enter amount"
              value={custom}
              onChange={(e) => {
                setCustom(e.target.value);
                setSelected(null);
              }}
              aria-describedby="custom-amount-hint"
            />
            <span id="custom-amount-hint" className="sr-only">
              Integer between 1 and 10000
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button
            onClick={handleSubmit}
            disabled={isPending || !effectiveAmount}
            aria-busy={isPending}
          >
            {isPending ? 'Adding…' : 'Add Credits'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
