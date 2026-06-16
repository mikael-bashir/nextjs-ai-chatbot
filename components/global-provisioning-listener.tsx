// components/GlobalProvisioningListener.tsx
'use client';

import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useEffect } from 'react';
import { ProvisioningModal } from './provisioning-modal';

export function GlobalProvisioningListener() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const { data: session, status } = useSession();

  const showModal = searchParams.get('modal') === 'true';

  useEffect(() => {
    if (showModal && status === 'authenticated' && session?.user?.hasLeakAccount) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete('modal');
      // Silently clean the URL without a hard reload
      router.replace(`${pathname}?${params.toString()}`);
    }
  }, [showModal, status, session, pathname, router, searchParams]);

  if (status === 'loading') return null;

  if (!showModal) return null;

  if (session?.user?.hasLeakAccount) return null;

  return (
    <ProvisioningModal 
      onSuccess={() => {
        // When they finish onboarding, strip the param to close the modal!
        const params = new URLSearchParams(searchParams.toString());
        params.delete('modal');
        router.refresh();
        router.replace(`${pathname}?${params.toString()}`);
      }}
    />
  );
}