import { cookies, headers } from 'next/headers';
import { Suspense } from 'react';
import Script from 'next/script';

import { AppSidebar } from '@/components/app-sidebar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { auth } from '../(auth)/auth';

// Mirrors resolvePublicOrigin from auth.config.ts
async function getPublicOrigin(): Promise<string> {
  const hdrs = await headers();
  const fwdHost = hdrs.get('x-forwarded-host');
  if (fwdHost) {
    const proto = (hdrs.get('x-forwarded-proto') ?? 'https').split(',')[0].trim();
    return `${proto}://${fwdHost}`;
  }
  if (process.env.AUTH_URL) {
    try { return new URL(process.env.AUTH_URL).origin; } catch {}
  }
  return 'http://localhost:3000';
}

// 1. Extract the dynamic fetching into its own internal async component
async function ChatLayoutContent({ children }: { children: React.ReactNode }) {
  const [session, cookieStore, publicOrigin] = await Promise.all([
    auth(),
    cookies(),
    getPublicOrigin(),
  ]);
  const isCollapsed = cookieStore.get('sidebar:state')?.value !== 'true';

  return (
    <SidebarProvider defaultOpen={!isCollapsed}>
      <AppSidebar user={session?.user} publicOrigin={publicOrigin} />
      <SidebarInset>{children}</SidebarInset>
    </SidebarProvider>
  );
}

// 2. Make the main layout synchronous and wrap the dynamic part in <Suspense>
export default function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Script
        src="https://cdn.jsdelivr.net/pyodide/v0.23.4/full/pyodide.js"
        strategy="beforeInteractive"
      />
      {/* 3. Provide a fallback UI so Next.js can stream the page instantly without blocking */}
      <Suspense fallback={<div className="flex h-screen items-center justify-center">Loading workspace...</div>}>
        <ChatLayoutContent>{children}</ChatLayoutContent>
      </Suspense>
    </>
  );
}