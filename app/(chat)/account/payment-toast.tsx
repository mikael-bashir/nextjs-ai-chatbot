'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

export function PaymentSuccessToast() {
  const router = useRouter();
  useEffect(() => {
    toast.success('Payment successful! Credits are being added to your account.');
    router.replace('/account');
  }, [router]);
  return null;
}

export function PaymentCancelledToast() {
  const router = useRouter();
  useEffect(() => {
    toast.info('Payment cancelled.');
    router.replace('/account');
  }, [router]);
  return null;
}
