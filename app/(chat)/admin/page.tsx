import { redirect } from 'next/navigation';
import { auth } from '@/app/(auth)/auth';
import { isAdminEmail } from '@/lib/admin';
import { AdminPipeline } from '@/components/admin-pipeline';

// Dedicated admin page for the content-generation pipeline. Server-gated: only
// the admin email may view it; everyone else is bounced to the chat home.
export default async function AdminPage() {
  const session = await auth();
  if (!isAdminEmail(session?.user?.email)) {
    redirect('/');
  }
  return (
    <main className="min-h-screen bg-background">
      <AdminPipeline />
    </main>
  );
}
