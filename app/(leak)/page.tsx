import Link from 'next/link';
import {
  ArrowRight,
  ShieldCheck,
  Terminal,
  Coins,
  FlaskConical,
  Code2,
  LineChart,
  Mail,
} from 'lucide-react';

import { Button } from '@/components/ui/button';

// Where custom / business enquiries land. Swap once the team mailbox is live
// (see the email-domain setup — a custom-domain inbox on competemath.com).
const CONTACT_EMAIL = 'team@competemath.com';

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
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col px-6">
      {/* Nav */}
      <header className="flex items-center justify-between py-6">
        <span className="font-mono text-sm font-semibold tracking-tight">
          leak<span className="text-amber-500">.</span>
        </span>
        <nav className="flex items-center gap-4">
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="hidden text-sm text-muted-foreground transition-colors hover:text-foreground sm:inline"
          >
            Contact
          </a>
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
      <section className="flex flex-col justify-center py-16">
        <p className="font-mono text-xs uppercase tracking-[0.25em] text-amber-500">
          Theorem-proving API
        </p>
        <h1 className="mt-4 max-w-2xl text-4xl font-semibold tracking-tight md:text-5xl">
          Send a maths problem. Get a machine-checked Lean&nbsp;4 proof — pay
          for the compute it takes.
        </h1>
        <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground">
          One endpoint runs an AI prover whose proofs are checked by the
          Lean&nbsp;4 kernel — not a plausible-looking argument. You pay for the
          compute a run uses — its actual cost plus 20% — drawn from prepaid
          credits, whether or not it lands a proof.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Button asChild size="lg" className="gap-2">
            <Link href={primaryHref}>
              {primaryLabel}
              <ArrowRight className="size-4" />
            </Link>
          </Button>
          <span className="font-mono text-sm text-muted-foreground">
            Prepay with credits · billed at 1.2× the compute used
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

      {/* Who it's for */}
      <section className="border-t py-16">
        <p className="font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">
          Who it&rsquo;s for
        </p>
        <div className="mt-8 grid gap-6 md:grid-cols-3">
          <Audience
            icon={<FlaskConical className="size-5" />}
            title="AI labs & researchers"
            body="Ground-truth formal verification for evals, RL reward signals, and synthetic proof data. Every result is checked by the Lean kernel — no false positives, no hallucinated proofs to filter out."
          />
          <Audience
            icon={<Code2 className="size-5" />}
            title="Builders & students"
            body="One bearer token, one POST. Wire proving into your app, generate guaranteed-correct answer keys, or just watch a hard theorem get solved. Cheap to start; you pay for the compute a run actually uses."
          />
          <Audience
            icon={<LineChart className="size-5" />}
            title="Investors & partners"
            body="A metered pay-for-compute proving engine with a self-improving prover + Lean verifier at its core. Want the deeper story or a look under the hood? Talk to us."
          />
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
          title="Pay for the compute"
          body="Credits are drawn as the prover runs — its actual compute cost plus 20% — whether or not it lands a proof. It stops before exceeding your balance, so you're never charged beyond your credits."
        />
      </section>

      {/* Why it's trustworthy */}
      <section className="border-t py-16">
        <div className="max-w-2xl">
          <p className="font-mono text-xs uppercase tracking-[0.25em] text-amber-500">
            Why it&rsquo;s different
          </p>
          <h2 className="mt-4 text-2xl font-semibold tracking-tight">
            A language model can write a convincing wrong proof. We don&rsquo;t
            ship those.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted-foreground">
            Leak only returns a proof the Lean&nbsp;4 kernel accepts — the same
            trusted core that underpins formalised mathematics. &ldquo;Proved&rdquo;
            means proved, not &ldquo;looks right&rdquo;. You pay for the compute
            either way — but when a proof comes back, that kernel check is your
            guarantee it&rsquo;s real, not merely convincing.
          </p>
        </div>
      </section>

      {/* Business / custom enquiries */}
      <section className="border-t py-16">
        <div className="flex flex-col items-start justify-between gap-6 rounded-2xl border bg-muted/30 p-8 md:flex-row md:items-center">
          <div className="max-w-xl">
            <h2 className="text-xl font-semibold tracking-tight">
              Building something bigger?
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              An eval suite, a research collaboration, high-volume proving, a
              custom integration, or an investment conversation — we&rsquo;d love
              to hear from you. For custom &amp; business enquiries, contact the
              team.
            </p>
          </div>
          <Button asChild size="lg" variant="outline" className="gap-2">
            <a href={`mailto:${CONTACT_EMAIL}`}>
              <Mail className="size-4" />
              {CONTACT_EMAIL}
            </a>
          </Button>
        </div>
      </section>

      <footer className="flex flex-col items-center gap-1 border-t py-8 text-center font-mono text-xs text-muted-foreground">
        <span>leak · a CompeteMath service</span>
        <a
          href={`mailto:${CONTACT_EMAIL}`}
          className="transition-colors hover:text-foreground"
        >
          {CONTACT_EMAIL}
        </a>
      </footer>
    </main>
  );
}

function Audience({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-xl border bg-muted/20 p-5">
      <div className="flex items-center gap-3">
        <span className="text-amber-500">{icon}</span>
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{body}</p>
    </div>
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
