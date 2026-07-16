import { redirect } from 'next/navigation';

// The queue resolver now lives in the unified admin/prover console.
export default function QueuePage() {
  redirect('/admin');
}
