import { cookies } from 'next/headers';
import { Suspense } from 'react';
import Script from 'next/script';

import { AppSidebar } from '@/components/app-sidebar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { auth } from '../(auth)/auth';

// export const experimental_ppr = true;

// 1. Extract the dynamic fetching into its own internal async component
async function ChatLayoutContent({ children }: { children: React.ReactNode }) {
  const [session, cookieStore] = await Promise.all([auth(), cookies()]);
  const isCollapsed = cookieStore.get('sidebar:state')?.value !== 'true';

  return (
    <SidebarProvider defaultOpen={!isCollapsed}>
      <AppSidebar user={session?.user} />
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