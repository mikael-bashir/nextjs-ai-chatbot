'use client';

import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { isAdminEmail } from '@/lib/admin';

// Header entry point to the admin pipeline page. Renders only for the admin.
export function AdminNavButton({ className }: { className?: string }) {
  const { data: session } = useSession();
  if (!isAdminEmail(session?.user?.email)) return null;
  return (
    <Button
      asChild
      variant="outline"
      size="sm"
      className={cn('h-[34px]', className)}
    >
      <Link href="/admin">Admin</Link>
    </Button>
  );
}
