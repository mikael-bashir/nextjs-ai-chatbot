import Link from 'next/link';
import { ArrowRight, ShieldCheck, Terminal, Coins } from 'lucide-react';

import { Button } from '@/components/ui/button';

const CURL = `curl https://leak.competemath.com/api/v1/problems \\
  -H "Authorization: Bearer leak_sk_…" \\
  -H "Content-Type: application/json" \\
  -d '{"problem": "Prove that √2 is irrational."}'`;

// Static marketing page. The CTA points at /dashboard; middleware handles
// sending signed-out visitors through login first.
export default function LandingPage() {
  const primaryHref = '/dashboard';
  const primaryLabel = 'Get started';

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col px-6">
      {/* Nav */}
      <header className="flex items-center justify-between py-6">
        <span className="font-mono text-sm font-semibold tracking-tight">
          leak<span className="text-amber-500">.</span>
        </span>
        <nav className="flex items-center gap-3">
          <Link
            href="/dashboard"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Dashboard
          </Link>
          <Button asChild size="sm">
            <Link href={primaryHref}>{primaryLabel}</Link>
          </Button>
        </nav>
      </header>

      {/* Hero */}
      <section className="flex flex-1 flex-col justify-center py-16">
        <p className="font-mono text-xs uppercase tracking-[0.25em] text-amber-500">
          Theorem-proving API
        </p>
        <h1 className="mt-4 max-w-2xl text-4xl font-semibold tracking-tight md:text-5xl">
          Send a maths problem. Get a verified proof — or pay nothing.
        </h1>
        <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground">
          One endpoint, one bearer token. We formally prove competition-level
          problems in Lean and only charge when a proof checks out. Failed
          attempts are free, every time.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Button asChild size="lg" className="gap-2">
            <Link href={primaryHref}>
              {primaryLabel}
              <ArrowRight className="size-4" />
            </Link>
          </Button>
          <span className="font-mono text-sm text-muted-foreground">
            Prepay with credits · refunded on failure
          </span>
        </div>

        {/* Terminal sample */}
        <div className="mt-12 overflow-hidden rounded-xl border bg-muted/40">
          <div className="flex items-center gap-2 border-b px-4 py-2">
            <Terminal className="size-3.5 text-muted-foreground" />
            <span className="font-mono text-xs text-muted-foreground">
              POST /api/v1/problems
            </span>
          </div>
          <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed md:text-sm">
            {CURL}
          </pre>
        </div>
      </section>

      {/* How it works */}
      <section className="grid gap-6 border-t py-16 md:grid-cols-3">
        <Step
          icon={<Terminal className="size-5" />}
          n="01"
          title="Get a key"
          body="Sign in and mint a leak_sk_ API key from your dashboard in one click."
        />
        <Step
          icon={<ShieldCheck className="size-5" />}
          n="02"
          title="Submit a problem"
          body="POST the statement with your bearer token. We queue it, prove it in Lean, and verify the proof against the kernel."
        />
        <Step
          icon={<Coins className="size-5" />}
          n="03"
          title="Pay on success only"
          body="Credits are captured when a proof lands. If we can't prove it, you're charged nothing — guaranteed."
        />
      </section>

      <footer className="border-t py-8 text-center font-mono text-xs text-muted-foreground">
        leak · a CompeteMath service
      </footer>
    </main>
  );
}

function Step({
  icon,
  n,
  title,
  body,
}: {
  icon: React.ReactNode;
  n: string;
  title: string;
  body: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="text-muted-foreground">{icon}</span>
        <span className="font-mono text-xs text-muted-foreground">{n}</span>
      </div>
      <h3 className="mt-3 text-sm font-semibold">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        {body}
      </p>
    </div>
  );
}
