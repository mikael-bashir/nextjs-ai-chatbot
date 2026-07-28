'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import {
  fetchProverMcpServers,
  type ProverMcpServer,
} from '@/lib/mcp/fetch-prover-servers';
import {
  runProverStream,
  extendProverRun,
} from '@/lib/prover/run-prover-stream';
import { ProverConsole } from '@/components/prover/prover-console';
import type {
  ProverEvent,
  ProverEventKind,
  ProverMetrics,
} from '@/lib/prover/types';
import {
  estimateCost,
  extractFeatures,
  type EstimateResult,
} from '@/lib/cost/estimator';
import {
  GAUNTLET_JUDGE_SYSTEM_PROMPT,
  GAUNTLET_MODEL,
  GAUNTLET_SAMPLES,
  GAUNTLET_SOLVER_SYSTEM_PROMPT,
  GAUNTLET_TIMEOUT_MS,
  LEVEL_ASSESSOR_SYSTEM_PROMPT,
  gauntletJudgePrompt,
  gauntletSolverPrompt,
  levelAssessorPrompt,
  normalizeIntString,
  parseAssessedLevel,
  parseJudgeVerdict,
  sampleChain,
  trapdoorPrompt,
  type GauntletMeta,
} from '@/lib/generation/trapdoor';
import {
  ElaborationUnavailableError,
  MAX_REFORMALIZE_ATTEMPTS,
  REFORMALIZER_SYSTEM_PROMPT,
  checkStatementElaborates,
  parseReformalized,
  reformalizePrompt,
} from '@/lib/generation/elaboration';
import {
  INTEGRAL_VERIFIER_SYSTEM_PROMPT,
  integralSetterPrompt,
  integralVerifierPrompt,
  parseIntegralVerdict,
  prefilterProblem,
  sampleIntegralRecipe,
  type IntegralCertificate,
} from '@/lib/generation/integral';
import {
  MIRAGE_SETTER_SYSTEM_PROMPT,
  mirageExactFields,
  mirageSetterPrompt,
  sampleThresholdMirage,
  type MirageInstance,
} from '@/lib/generation/mirage';

// Per-item cost state (session-scoped): the estimate made on enqueue and the
// actual recorded once the proof finishes. Persisted rows live in
// proof_cost_history; this map drives the live per-card display.
// What the bridge's /run returns (and /run-stream's terminal `result` event
// carries) — the shape every generation-phase caller consumes.
interface BridgeRunResult {
  ok?: boolean;
  text?: string;
  usage?: unknown;
  costUsd?: number | null;
  exitCode?: number | null;
  durationMs?: number;
  timedOut?: boolean;
  aborted?: boolean;
  stderr?: string;
}

interface ItemCost {
  estimating?: boolean;
  estFailed?: boolean;
  estUsd?: number;
  estLow?: number;
  estHigh?: number;
  estRationale?: string;
  costHistoryId?: string;
  actualUsd?: number;
}

// Estimator scoreboard shape (mirrors AccuracyStats in cost-history-queries; kept
// local so this client module doesn't import the server-only DB layer).
interface EstStats {
  n: number;
  mape: number | null;
  biasRel: number | null;
  biasAbs: number | null;
  byDifficulty: { difficulty: string; n: number; mape: number | null }[];
}

const fmtUsd = (n: number | null | undefined) =>
  n == null ? '—' : `$${n.toFixed(n < 1 ? 3 : 2)}`;
const fmtPct = (n: number | null | undefined) =>
  n == null ? '—' : `${(n * 100).toFixed(0)}%`;
import { MathMarkdown } from '@/components/math-markdown';

// Lean pins per verifier group. These are NOT interchangeable: the original Leak
// group (I/II/IV, gate = verify_full_script) runs 4.29.1, while the architect
// group (XI/XII/XIV, gate = Leak XIV) runs 4.32.0. A proof certified by one does
// not carry a claim about the other, so a run's toolchain is taken from the
// bridge's own report (metrics.lean_toolchain) and only falls back to these when
// an older bridge didn't send it. Keep in sync with TOOLCHAINS in the bridge.
const TOOLCHAIN = 'leanprover/lean4:v4.29.1';
const MATHLIB_VERSION = 'v4.29.1';
const ARCHITECT_TOOLCHAIN = 'leanprover/lean4:v4.32.0';
const ARCHITECT_MATHLIB_VERSION = 'v4.32.0';

// Generation needs no tools/MCP — run claude lean so each call carries ~4k
// tokens of context instead of ~17k (default system prompt + tool schemas),
// which drastically cuts subscription rate-limit pressure when looping.
const GEN_RUN_OPTIONS = {
  // No cap (0): hard/nested problems can take a long time to reason through, and
  // the "Terminate" button now controls it (which kills claude server-side via
  // the bridge's disconnect handler, so an uncapped run can't run away).
  timeoutMs: 0,
  systemPrompt:
    'You are a creative competition-math problem setter. Follow the user instructions exactly and respond with ONLY the requested JSON object.',
  disallowedTools:
    'Bash Read Edit Write Glob Grep WebFetch WebSearch Task TodoWrite NotebookEdit',
  strictMcpConfig: true,
  excludeDynamicSections: true,
  // Hard/nested reasoning can blow past Claude Code's default 32k output-token
  // cap (which counts thinking) and error out. Raise it to the model max.
  maxOutputTokens: 64000,
};

// Reverse and trapdoor modes build problems from exact arithmetic (products,
// modular exponentiation, chain walks) that a tool-less model would otherwise
// grind out by hand — slow (10-20 min of thinking) AND error-prone, so the
// answer often ends up wrong. Give those modes a python tool so they compute
// the construction exactly, in seconds. The other modes stay tool-free (lean
// context = less rate-limit pressure when looping).
// Drop Bash from the denylist; keep everything else blocked. Headless run on
// the user's own local bridge — auto-approve the tool so it can actually
// execute python without an interactive prompt.
const BASH_TOOL_OPTIONS = {
  disallowedTools:
    'Read Edit Write Glob Grep WebFetch WebSearch Task TodoWrite NotebookEdit',
  allowedTools: 'Bash',
  permissionMode: 'bypassPermissions',
};

function genRunOptionsFor(mode: GenMode, model?: string) {
  // Trapdoor defaults the GENERATOR to Opus 4.8: the gauntlet adversary is
  // Sonnet 5 + tools, and a generator of equal strength to its adversary
  // produces problems the adversary solves (measured live: 3/3 cracked with
  // full derivations). The asymmetry is the point — an explicit model pick
  // in the UI still overrides this. Integral mode doesn't need it: its
  // difficulty comes from the backward construction, and the gauntlet tiers
  // it honestly either way.
  const effective =
    model || (mode === 'trapdoor' ? 'claude-opus-4-8' : undefined);
  const withModel = effective
    ? { ...GEN_RUN_OPTIONS, model: effective }
    : GEN_RUN_OPTIONS;
  if (mode !== 'reverse' && mode !== 'trapdoor' && mode !== 'integral')
    return withModel;
  return { ...withModel, ...BASH_TOOL_OPTIONS };
}

// The integral hard verifier (VHG Appendix E.3): an independent run whose
// verdict comes from executed sympy, never from the setter's own transcript.
const INTEGRAL_VERIFIER_RUN_OPTIONS = {
  ...GEN_RUN_OPTIONS,
  ...BASH_TOOL_OPTIONS,
  model: GAUNTLET_MODEL,
  systemPrompt: INTEGRAL_VERIFIER_SYSTEM_PROMPT,
  timeoutMs: 10 * 60 * 1000,
};

// Mirage: the LLM only writes prose around a TS-solved instance — no tools, no
// math, so this is a short completion. Opus for the quality of the disguise.
const MIRAGE_RUN_OPTIONS = {
  ...GEN_RUN_OPTIONS,
  model: 'claude-opus-4-8',
  systemPrompt: MIRAGE_SETTER_SYSTEM_PROMPT,
  timeoutMs: 5 * 60 * 1000,
};

// The gauntlet solver: a mid-tier Claude attacking the problem cold, WITH a
// Bash/python tool (denying it would test mental arithmetic, not insight —
// see lib/generation/trapdoor.ts) and no forced output format. Timeout is
// generation-side only (a solver that can't crack it in time has failed to
// crack it, which is the pass condition).
const GAUNTLET_RUN_OPTIONS = {
  ...GEN_RUN_OPTIONS,
  ...BASH_TOOL_OPTIONS,
  model: GAUNTLET_MODEL,
  systemPrompt: GAUNTLET_SOLVER_SYSTEM_PROMPT,
  timeoutMs: GAUNTLET_TIMEOUT_MS,
};

// The gauntlet judge: also tool-equipped, so it can RUN any code the solver
// produced and verify what it actually prints rather than trust the
// transcript.
const GAUNTLET_JUDGE_RUN_OPTIONS = {
  ...GEN_RUN_OPTIONS,
  ...BASH_TOOL_OPTIONS,
  model: GAUNTLET_MODEL,
  systemPrompt: GAUNTLET_JUDGE_SYSTEM_PROMPT,
  timeoutMs: GAUNTLET_TIMEOUT_MS,
};

// Re-formalization: rewrite a Lean statement that failed to compile, keeping
// the problem. Pure formalization work against a concrete compiler error, so a
// mid-tier model is enough and no tools are needed — the daemon re-checks the
// result anyway, which is the real verdict.
const REFORMALIZER_RUN_OPTIONS = {
  ...GEN_RUN_OPTIONS,
  model: GAUNTLET_MODEL,
  systemPrompt: REFORMALIZER_SYSTEM_PROMPT,
  timeoutMs: 5 * 60 * 1000,
};

// Post-hoc level assessment: one cheap classification call per problem.
const ASSESSOR_RUN_OPTIONS = {
  ...GEN_RUN_OPTIONS,
  model: GAUNTLET_MODEL,
  systemPrompt: LEVEL_ASSESSOR_SYSTEM_PROMPT,
  timeoutMs: 5 * 60 * 1000,
};

// Models selectable for the local `claude` runs (available on the Claude Max
// plan). '' = the CLI/bridge default. Generation and verification pick one each,
// independently.
const PROVER_MODELS: { value: string; label: string }[] = [
  { value: '', label: 'Default' },
  { value: 'claude-opus-5', label: 'Opus 5' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { value: 'claude-fable-5', label: 'Fable 5' },
];

// The model's context window, for a rough "% of context used" readout.
const CONTEXT_WINDOW = 200000;

function fmtElapsed(startMs: number | null): string {
  if (startMs == null) return '';
  const s = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

// Compute the next timestamp for a wall-clock time like "8:30pm" in the viewer's
// local timezone (best effort — assumes the browser tz matches the reset tz).
function nextTimeToday(hour12: number, minute: number, ampm?: string): number {
  let hour = hour12;
  if (ampm) {
    const pm = /p/i.test(ampm);
    if (pm && hour < 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  }
  const now = new Date();
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// Detect Claude's usage/session-limit message (e.g. "You've hit your session
// limit · resets 8:30pm (Europe/London)") in stdout/stderr, and parse the reset
// time so the worker can pause and auto-resume.
function detectSessionLimit(text: string): {
  hit: boolean;
  message?: string;
  resetText?: string;
  resetAt?: number;
} {
  const t = (text || '').trim();
  if (!/limit/i.test(t)) return { hit: false };
  if (
    !/(session|usage|rate)\s*limit|hit your|limit (reached|exceeded)/i.test(t)
  )
    return { hit: false };
  const m = t.match(/reset[s]?\b[^0-9]*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  const resetAt = m
    ? nextTimeToday(Number(m[1]), m[2] ? Number(m[2]) : 0, m[3])
    : undefined;
  return {
    hit: true,
    message: t.slice(0, 200),
    resetText: m?.[0]?.trim(),
    resetAt,
  };
}

function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

type GenMode =
  | 'easy'
  | 'medium'
  | 'hard'
  | 'insane'
  | 'reverse'
  | 'trapdoor'
  | 'integral'
  | 'mirage';

// Whether a generated Lean statement is compiled before we spend anything on
// it. 'leak' runs it on the connected Lean daemon via the MCP connection
// manager; 'off' skips the check entirely, for generating problems without any
// verification. See lib/generation/elaboration.ts for why this gate exists.
type StatementCheck = 'leak' | 'off';

const STATEMENT_CHECK_LABEL: Record<StatementCheck, string> = {
  leak: 'Leak IV',
  off: 'Off',
};

const MODE_LABEL: Record<GenMode, string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
  insane: 'Insane',
  reverse: 'Reverse-built',
  trapdoor: 'Trapdoor',
  integral: 'Integral',
  mirage: 'Mirage',
};

const BASE_REQS = `You are a creative competition-math problem setter. Invent ONE original problem.

Work EFFICIENTLY. Commit to ONE idea and derive its answer directly — do not
explore many candidates or exhaustively re-verify in your head. Your Lean theorem
will be MACHINE-CHECKED by a Lean prover afterward, so you do NOT need to prove it
yourself; a best-effort answer that turns out wrong is caught cheaply downstream.
Keep your reasoning brief and get to the JSON.

Core requirements:
- Creative and NON-standard: not a textbook exercise, not a famous/known competition problem, not a classic named result. Fresh setup and phrasing.
- The answer is a specific INTEGER.
- TITLE — make it genuinely curious and alluring, a hook that makes someone want to click. VARY THE SHAPE every single time; never settle into a template:
  · an intriguing question — "Isn't this impossible?", "How is π hiding in here?", "Why won't it stop?"
  · a vivid scenario or stakes — "Defending the Earth", "The last coin standing", "Escape the grid"
  · a provocative teaser or claim — "Nothing adds up", "A number that shouldn't exist"
  · playful, wry, or surprising is welcome.
  HARD BAN: the formulaic "The <Adjective> <Noun>" pattern (e.g. "The Cubic Sentinel", "The Stubborn Remainder") — it is boring and overused; do not use it, and do not start most titles with "The". Keep it short (~2-6 words), specific to THIS problem's flavour.
  HARD BAN #2 — the title must NEVER reveal or hint at the answer. Do not put the numeric answer in it as a digit ("… = 1", "Sum is 144") OR spelled out ("… Equal One", "… Is Unity", "Always Zero", "Exactly Seven"), and do not paraphrase its value ("… is a perfect square", "… must be prime"). The title poses the mystery; the number stays hidden until they solve it. (E.g. for a sum that equals 1, "Why Must This Sum Equal One?" is BANNED — use "What Does This Stubborn Sum Collapse To?" instead.)
- Also give a 1-3 word subtitle (a small tagline). The "difficulty" and "points" are DICTATED by the mode below — emit exactly the values it specifies (do not choose your own).
- Also assign a "level" as an INTEGER 1-5 = the prerequisite mathematical KNOWLEDGE required to attempt it (this is about background needed, NOT how hard the puzzle is — a level-1 problem can still be a tough puzzle):
  1 = a first-year primary school student would technically have the base knowledge to attempt it;
  2 = knowledge content up to early high / secondary school;
  3 = knowledge up to the end of sixth form / college;
  4 = built around a single advanced, university-level concept;
  5 = several advanced concepts combined together.`;

// Trapdoor, Integral and Mirage modes have no static block — their prompts are
// built per-run around code-sampled recipes/instances (see the lib/generation
// modules).
const MODE_BLOCKS: Record<
  Exclude<GenMode, 'trapdoor' | 'integral' | 'mirage'>,
  string
> = {
  easy: `
- EASY. A quick, approachable problem: a single clear elementary observation or a short direct computation solves it. No deep trick and no long chain of steps — it should feel like a warm-up.
- Provide a Lean 4 theorem stating the exact answer, provable in Mathlib. Prefer a statement decidable by decide/native_decide over a SMALL finite domain (Fin n, Finset.range/Icc, functions between small Fin types) so it is machine-checkable. It should be true (the Lean prover verifies it afterward — don't re-derive it in your head).
- Emit "difficulty":"Easy", "points":50.`,
  medium: `
- MEDIUM. A solid problem needing ONE genuine, non-obvious insight — not immediate, but not fiendish. A capable solver reaches the integer answer with some real thought.
- Provide a Lean 4 theorem provable in Mathlib: a decide/native_decide over a small finite domain is acceptable, or a modest closed-form fact. It should be true (the Lean prover verifies it afterward — don't re-derive it in your head).
- Emit "difficulty":"Medium", "points":100.`,
  hard: `
- HARD. The problem must NOT be solvable by a short brute-force script: avoid small finite search spaces. Use large or unbounded domains, a general n, or structures where naive enumeration is infeasible. It must hinge on a genuine, non-obvious insight, yet still be solvable by hand to a specific integer.
- The Lean 4 theorem must NOT be provable by decide/native_decide over an enumerable domain. State a GENERAL or closed-form fact (a formula in n, an identity, a divisibility/inequality, a characterization) that requires real Mathlib tactics — induction, algebra, known lemmas — to prove. It should be true (the Lean prover verifies it afterward — don't re-derive it in your head). Still attempt to make it provable in Mathlib.
- Emit "difficulty":"Hard", "points":150.`,
  insane: `
- INSANE. The hardest and rarest tier. The goal is a specific FEELING: a solver reads a SHORT, innocent-looking statement and is overwhelmed not by its length but by how LITTLE they have to go on — no foothold, no obvious first move, "wait… what can I even DO with this?". The path only appears after chaining MULTIPLE distinct, non-obvious insights (or seeing one extraordinarily deep idea), each unlocking the next. A long statement full of exotic vocabulary is the OPPOSITE of what you want — the difficulty must live in the ideas, not the reading.

  HARD BANS — none of these make a problem Insane. If your idea leans on any of them, it is at most Hard: DISCARD it and design a genuinely harder one (do NOT emit a mislabelled problem — this mode must still output a real Insane).
  · A big modulus / argument / bound that does NOT change the answer. If the result is the same for every prime p (or every large n), the giant number is pure decoration — e.g. "Σ_{i=1}^{p-1} (p-1)!/i mod p" is 0 for EVERY odd prime (one-line Wilson + inverses), so p = 10^9+7 is a costume, not difficulty.
  · An answer that is degenerate or forced by symmetry — 0, 1, or a constant independent of the elaborate-looking setup.
  · Dressing an elementary fact in a famous named object (Wilson, Stern/fusc diatomic, Pell, "the multiplicative group mod p", Fibonacci, Catalan…). A recognisable object hands the solver the very foothold you must deny them. Prefer an UNFAMILIAR, self-defined construction the solver has never seen named.
  · A "big" input whose EFFECTIVE work is tiny — a recurrence evaluated at n ≈ 10^7, a Pell equation with a small fundamental solution, an order/count read straight off a factorisation. If a five-line Python script prints the answer in under a second, it is not Insane (it is barely Hard).

  SELF-CHECK — in your brief reasoning you MUST clear ALL four; if any fails, the problem is not Insane, so redesign before emitting:
  1. INSIGHT CHAIN: name the ≥2 distinct insights that must be chained (or justify one genuinely deep idea). "One clever observation, then compute" is HARD, not Insane.
  2. NOT BRUTE-FORCEABLE: state the effective search space and why no short script cracks it — concretely (e.g. "even the smartest enumeration is ≳ 10^12 irreducible steps"), not merely "the number is large". If a small program wins, it fails.
  3. LOAD-BEARING NUMBERS: confirm the specific numbers matter — change them and both the answer AND the required ideas change. If you could shrink them with nothing lost, it fails.
  4. SPARSE STATEMENT: the statement is a couple of clean sentences with minimal given information. If it is long, or needs exotic named machinery to even state, rewrite it.
- The Lean 4 theorem must be a GENERAL / closed-form statement (NOT decide/native_decide over a finite domain), provable in Mathlib only with substantive, multi-step reasoning. It should be true (the Lean prover verifies it afterward — don't re-derive it in your head). Still attempt to make it provable in Mathlib.
- Emit "difficulty":"Insane", "points":200.`,
  reverse: `
- REVERSE-CONSTRUCTION MODE. The ONE invariant: EASY TO VERIFY, HARD TO SOLVE. Build the problem BACKWARD — start from hidden structure you choose so the answer is known to you for free, apply a process that is cheap to check but hard to run in reverse, then reveal only the result and ask for an integer function of what you hid. The Lean check must be a cheap one-step CERTIFICATE the answer satisfies; the solver, lacking your secret, must do real work to recover it.

  DO NOT restrict yourself to any one niche. This asymmetry appears EVERYWHERE in math — roam the whole space and pick whatever is freshest. A NON-exhaustive palette (do not just cycle these — invent your own):
  - Number theory: factoring, but ALSO Diophantine witnesses, digit/base representations, continued fractions, hidden divisor structure, modular seeds.
  - Combinatorics: a hidden colouring / tiling / graph / lattice path / matching / permutation whose count or a single witness is asked; a hidden subset with a target sum or property.
  - Algebra: a polynomial built from chosen roots (ask a coefficient / a value); a hidden matrix or linear system; a group/word construction.
  - Sequences & recurrences: a hidden seed or rule producing a term far downstream that is cheap to check forward, hard to invert.
  - Geometry: hidden lattice configurations, chosen points forcing an area/count, constructions with a cheap-to-verify invariant.
  - Games / processes / invariants: a chosen play sequence or state whose outcome is a cheap check but whose optimal value needs insight.
  Whatever you pick, the shape is: (1) SECRET you know → (2) a forward map cheap to verify but hard to invert → (3) hand the solver only the output, ask for a specific INTEGER function of the secret. Do not reveal the secret.

  LEAN 4 THEOREM = a CERTIFICATE the ANSWER satisfies, verifiable by ONE computation, NOT a search:
  - Reference the answer/witness DIRECTLY so verification is polynomial. Examples of the FORM (not a menu to copy): \`p * q = N ∧ Nat.Prime p ∧ Nat.Prime q\`; \`(g ^ x : ZMod p) = h\`; \`(S : Finset ℕ).sum f = T ∧ <cheap predicate on S>\`; \`poly.eval r = 0\`; \`f^[k] seed = target\`. Use ZMod for modular facts so the check stays fast (never form giant powers before reducing).
  - FORBIDDEN: a statement whose ONLY check is to enumerate a bounded domain — if Lean brute-forces it, so can the solver.
  - Also FORBIDDEN (co-NP, not cheap to verify): "the maximum/minimum is V", "the number of solutions is K", or any nonexistence claim — UNLESS you also give a directly-checkable witness that pins it.
  - Prefer decide/native_decide, an equational check, or a direct predicate on that single certificate.

  SCALE so brute force fails but insight wins: large enough that "loop over everything" is impractical, small enough that a smart method cracks it. Sizes are yours to choose per construction — do NOT default to crypto-grade magnitudes.

  COMPUTE, DON'T HAND-DERIVE: you have a Bash tool — run \`python3\` to build your secret, apply the forward map, and COMPUTE the exact integer answer and every number in the certificate (products, modular exponentials, sums, witness evaluations). VERIFY the certificate numerically in python before you emit it. NEVER do large arithmetic in your head — it is slow and it is wrong. State the exact values python gave you.
- Emit "difficulty":"Insane", "points":200.`,
};

const RESPONSE_FORMAT = `

LEAN SELF-CONTAINMENT (hard requirement, no exceptions): "lean" must be ONE single declaration — the theorem itself. NEVER split it into a separate top-level \`def\`/\`abbrev\`/\`structure\`/etc. that the theorem then references (e.g. a helper recursive function \`f\`). Any auxiliary function, sequence, or recurrence the statement needs must be folded INTO the theorem's own signature instead — as a bound variable plus hypotheses stating its defining equations, e.g. \`theorem foo (f : ℕ → ℕ) (hf0 : f 0 = 0) (hf : ∀ n, f (n + 1) = n + 1 + f ((n + 1) / 2)) : f 2026 = 9769\`. The verifier that later checks a submitted proof compares the target's signature verbatim against nothing but this one declaration — a leading def makes the problem permanently unprovable, not just harder.

Assume "import Mathlib" is present; do NOT include imports.
Respond with ONLY this JSON object, nothing else:
{"questionTitle":"<curious, alluring hook — a question / scenario / teaser; NEVER 'The <Adjective> <Noun>'>","subtitle":"<1-3 word tagline>","problem":"<self-contained statement>","answer":<integer>,"difficulty":"Easy|Medium|Hard|Insane","points":<50|100|150|200>,"level":<1-5>,"insight":"<key trick(s), 1-3 sentences>","lean":"theorem name : <statement encoding the integer answer> := by sorry"}`;

// The level (prerequisite-knowledge tier, 1-5) is no longer a generation
// constraint: the generator works unconstrained, and the tier is judged
// AFTER the fact by a cheap post-hoc assessor call (see generateOne). The
// rubric lives in lib/generation/trapdoor.ts.

interface LiveProblem {
  title: string;
  subtitle?: string;
  difficulty?: string;
}

interface LogEntry {
  id: number;
  ts: number;
  level: 'error' | 'warn' | 'info';
  message: string;
  // Optional payload, e.g. the raw generation output that failed to parse.
  detail?: string;
}

// Serialize a log entry to a self-contained, copy-pasteable block (includes the
// full raw output) so it can be dropped straight into a bug report.
function formatLogEntry(e: LogEntry): string {
  const head = `[${new Date(e.ts).toISOString()}] ${e.level.toUpperCase()}: ${e.message}`;
  return e.detail
    ? `${head}\n----- raw output -----\n${e.detail}\n----------------------`
    : head;
}

// Summarise problems that already exist (here + live on CompeteMath) so the
// model can deliberately avoid repeating topics/structures.
function buildAvoidContext(
  gen: { questionTitle?: string; problem?: string }[],
  live: LiveProblem[],
): string {
  const genLines = gen
    .slice(0, 60)
    .map(
      (g) =>
        `- "${g.questionTitle ?? 'untitled'}"${g.problem ? `: ${g.problem.replace(/\s+/g, ' ').slice(0, 110)}` : ''}`,
    );
  const liveLines = live
    .slice(0, 120)
    .map((p) => `- "${p.title}"${p.subtitle ? ` — ${p.subtitle}` : ''}`);
  const parts: string[] = [];
  if (genLines.length)
    parts.push(`Already generated here:\n${genLines.join('\n')}`);
  if (liveLines.length)
    parts.push(`Already live on CompeteMath:\n${liveLines.join('\n')}`);
  return parts.join('\n\n');
}

function buildPrompt(mode: GenMode, avoid: string): string {
  // Trapdoor and Integral build their prompts around per-run sampled recipes.
  // Mirage is handled entirely in generateOne (it needs the sampled instance
  // for the exact-field overwrite), so it never reaches buildPrompt.
  if (mode === 'trapdoor') return trapdoorPrompt(sampleChain(), avoid);
  if (mode === 'integral')
    return integralSetterPrompt(sampleIntegralRecipe(), avoid);
  if (mode === 'mirage')
    throw new Error('mirage prompt is built in generateOne, not buildPrompt');
  const avoidBlock = avoid
    ? `\n\nAVOID DUPLICATION. Do NOT create anything close in topic, structure, or mechanism to the problems below — choose a genuinely different area of mathematics and a fresh device:\n${avoid}`
    : '';
  return BASE_REQS + MODE_BLOCKS[mode] + avoidBlock + RESPONSE_FORMAT;
}

interface GenProblem {
  questionTitle?: string;
  subtitle?: string;
  problem?: string;
  answer?: number;
  difficulty?: string;
  points?: number;
  level?: number;
  insight?: string;
  lean?: string;
  // Trapdoor mode only: the hidden layer-by-layer construction (the key).
  // Stored server-side, never shown to solvers.
  chain?: string[];
  // Integral mode only: the certificate consumed by the hard verifier at
  // generation time (sympy syntax). The human-facing copy of the certificate
  // lives in `insight`; these raw fields are not persisted.
  integrand?: string;
  antiderivative?: string;
  lowerBound?: string;
  upperBound?: string;
  exactValue?: string;
}

// One independently-signed certificate for one toolchain. The flat fields on
// StagedItem below (proof/toolchain/mathlib/...) always mirror the MOST
// RECENT verify, for every existing UI read that expects a single proof;
// `certs` is the full accumulated set — one entry per DISTINCT toolchain the
// item has ever been successfully verified+signed on, upserted (not
// appended) so re-verifying the SAME toolchain replaces its entry rather
// than duplicating it. This is what lets an admin verify a problem on
// several toolchains BEFORE ever promoting it, and have all of them ship as
// independent certificates the first time it goes live.
interface CertEntry {
  toolchain: string;
  mathlib?: string | null;
  enforcer?: string | null;
  proof: string;
  verifiedAt?: string | null;
  signature?: string | null;
  signatureKeyId?: string | null;
  certMintedAt?: string | null;
}

interface StagedItem extends GenProblem {
  id: string;
  proof?: string;
  /** Lean toolchain + Mathlib version of the group that certified this proof. */
  toolchain?: string;
  mathlib?: string;
  /** Specific strategy that enforced this proof, for the certificate's
   *  Enforcer line (e.g. "Leak Ultra Fleeting" instead of bland "Leak"). */
  enforcer?: string;
  createdAt?: string;
  // ISO time the Lean kernel confirmed the proof (set by the verify loop),
  // threaded to the prod payload so the certificate's "verified" time is real.
  verifiedAt?: string | null;
  // Certificate signed at verify time (see the verify loop). Threaded through so
  // CompeteMath stores this exact signature rather than re-signing at ingestion.
  signature?: string | null;
  signatureKeyId?: string | null;
  certMintedAt?: string | null;
  // Every distinct-toolchain certificate accumulated across re-verifies of
  // THIS item, pre-publish. See CertEntry.
  certs?: CertEntry[];
}

interface GeneratedItem extends StagedItem {
  verified: boolean;
  error?: string | null;
  queued?: boolean;
  // Persisted cost-estimator state (hydrated into the `costs` map on load so the
  // per-card estimate/actual survive a refresh).
  estUsd?: number;
  estLow?: number;
  estHigh?: number;
  estRationale?: string;
  costHistoryId?: string;
  actualUsd?: number;
  // Saved verification progress (resumable have-tree checkpoint), auto-persisted.
  proofCheckpoint?: string;
  proofCheckpointFilled?: number;
  proofCheckpointTotal?: number;
  // Which generation mode produced this item.
  genMode?: string;
  // Sonnet-gauntlet verdict (Insane problems only) — see lib/generation/trapdoor.
  gauntlet?: GauntletMeta;
}

interface Health {
  staging: { ok: boolean; length?: number; error?: string };
  prod: { ok: boolean; length?: number; error?: string };
}

type GenFilter = 'all' | 'verified' | 'failed';

// LLMs emit JSON whose string values contain raw LaTeX backslashes (\sum,
// \lfloor, …) and sometimes literal newlines/tabs — both invalid inside a JSON
// string, so JSON.parse throws. Walk the candidate string-aware and escape those
// so the (otherwise well-formed) object parses. Only applied as a fallback.
function repairJsonStrings(s: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inStr) {
      out += c;
      if (c === '"') inStr = true;
      continue;
    }
    // Inside a string value.
    if (c === '\\') {
      const next = s[i + 1];
      if (next && '"\\/bfnrtu'.includes(next)) {
        out += c + next; // keep a valid escape intact
        i++;
      } else {
        out += '\\\\'; // lone backslash (LaTeX) → escape it
      }
    } else if (c === '"') {
      // A `"` really closes the string only if the next non-space char is a
      // JSON delimiter (, } ] :) or the end. Otherwise it's an unescaped quote
      // inside the value (e.g. a "friendly" pair) — escape it.
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      const nxt = s[j];
      if (
        nxt === undefined ||
        nxt === ',' ||
        nxt === '}' ||
        nxt === ']' ||
        nxt === ':'
      ) {
        out += c;
        inStr = false;
      } else {
        out += '\\"';
      }
    } else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else out += c;
  }
  return out;
}

// Return the first BALANCED {...} object starting at `start`, respecting strings
// (so braces inside the Lean code or problem text don't end it early). Handles
// prose that trails the object and contains stray braces.
function firstJsonObject(s: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function extractJson(text: string): GenProblem | null {
  if (!text) return null;
  let s = text.trim();
  // Unwrap a ```json … ``` fence if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  if (start === -1) return null;
  // Two candidate slices: the first balanced object (best for trailing prose),
  // and first-{ to last-} (best when unescaped quotes confuse brace matching).
  const balanced = firstJsonObject(s, start);
  const lastEnd = s.lastIndexOf('}');
  const greedy = lastEnd > start ? s.slice(start, lastEnd + 1) : null;
  const candidates: string[] = [];
  for (const c of [balanced, greedy]) {
    if (c && !candidates.includes(c)) candidates.push(c);
  }
  // For each candidate try strict, then a repaired version (raw LaTeX
  // backslashes, literal newlines, unescaped inner quotes).
  for (const cand of candidates) {
    for (const attempt of [cand, repairJsonStrings(cand)]) {
      try {
        return JSON.parse(attempt) as GenProblem;
      } catch {
        /* try the next candidate */
      }
    }
  }
  return null;
}

// Canonical title key for matching a problem across the generated / staging /
// prod / live stores (case- and whitespace-insensitive).
function normTitle(s?: string | null): string {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function metaLine(p: GeneratedItem | StagedItem, withDate = false): string {
  return [
    p.difficulty,
    p.level ? `Level ${p.level}` : null,
    p.points ? `${p.points}pts` : null,
    p.answer != null ? `ans ${p.answer}` : null,
    withDate && (p as GeneratedItem).createdAt
      ? new Date((p as GeneratedItem).createdAt as string).toLocaleString()
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

// Read a bridge connection from localStorage. `useWork` prefers the dedicated
// Work-loop bridge (lca.workBridgeUrl); verification uses the shared bridge so
// generation and proving can run in parallel on two bridges.
function connFor(useWork: boolean) {
  try {
    const base = JSON.parse(localStorage.getItem('lca.connection') || '{}');
    const workUrl = localStorage.getItem('lca.workBridgeUrl') || '';
    return useWork && workUrl ? { ...base, bridgeUrl: workUrl } : base;
  } catch {
    return {} as { bridgeUrl?: string; token?: string };
  }
}

// Default wall-clock budget a tree-path verification runs under before it needs
// a manual "+5 min" nudge. Generous — deep proofs (e.g. lucas_nresidue_prime)
// legitimately take a while — and always extendable live.
const VERIFY_COMPUTE_BUDGET_MS = 30 * 60_000;
// The Leak River strategies are deliberately governed much tighter: they're the
// experimental Goedel-Architect pipeline under test, so runs should fail fast
// and cheap rather than idle for 30 minutes — extend one minute at a time
// instead of five once you've confirmed it's making real progress.
const ARCHITECT_COMPUTE_BUDGET_MS = 5 * 60_000;
const ARCHITECT_EXTEND_MS = 1 * 60_000;
// Grok is the only driver the pipeline supports (see proveArchitect in
// public/local-claude-bridge.mjs) — the model selector is locked to this value
// whenever a River strategy is active. river-delta additionally makes one local
// Sonnet 5 call for its NL-proof seed, which is not a driver choice.
const ARCHITECT_MODEL = 'grok-4-1-fast-reasoning';
// Refinement-iteration budget: the paper's Figure 2 shows solve rate climbing
// log-linearly with refinement iterations, so this is the main quality dial.
// Starts at 5, +1 per click.
const ARCHITECT_DEFAULT_ITERS = 5;

// The no-op strategy: problems are generated and saved, but no prover ever
// runs. Kept as a strategy VALUE (rather than a separate toggle) so that the
// single `verifyStrategyRef` read inside runVerifier is the only gate the whole
// pipeline needs — every dispatch path already funnels through it.
const VERIFY_OFF = 'off';

// The three Leak River variants, each an ablation of the one before it so the
// research table isolates exactly one change at a time. `note` is shown in the
// UI under the selector.
const RIVER_STRATEGIES: {
  value: string;
  label: string;
  note: string;
}[] = [
  {
    value: 'river-stone',
    label: 'Leak River Stone (control)',
    note: 'Control: the Goedel-Architect paper as written — blueprint → parallel isolated node provers → refinement. Nothing added.',
  },
  {
    value: 'river-gate',
    label: 'Leak River Gate (+ dead-end ledger)',
    note: 'Stone + a shared dead-end ledger: environment facts the compiler establishes on one node (names that do not exist, unavailable typeclasses, coercion traps) are pooled and handed to sibling nodes, so no two nodes independently rediscover the same wall. Proof strategy is never shared.',
  },
  {
    value: 'river-delta',
    label: 'Leak River Delta (+ Sonnet 5 NL seed)',
    note: 'Gate + one local Sonnet 5 call up front for a natural-language proof of the target, handed to blueprint generation as a structural guide (the paper’s §4.2 NL guidance). Refinement is deliberately left unseeded — it reasons from machine-checked diagnoses instead.',
  },
];
const isRiverStrategy = (s: string) =>
  s === 'architect' || s.startsWith('river-');

// Leak Ultra — Stone's blueprint pipeline with the LOCAL Claude CLI as driver, on
// whatever model the dropdown says. Same Leak XI/XII/XIV gates as River, so it
// shares the architect toolchain, but its own research table: the driver differs,
// so its rows are not a River ablation.
const ULTRA_STRATEGIES: { value: string; label: string; note: string }[] = [
  {
    value: 'ultra-fleeting',
    label: 'Leak Ultra Fleeting (Claude driver)',
    note: "Stone's pipeline — identical prompts, tool contract and gates — driven by the local Claude CLI instead of the xAI API, on the model selected above. The bridge serves lean_compile/mathlib_search to the CLI from a local MCP server so the compile gate stays bridge-side; cost is the CLI's own reported total_cost_usd, so no price table is involved.",
  },
];
const isUltraStrategy = (s: string) => s.startsWith('ultra-');
// Both families run the architect orchestrator (and therefore Leak XI/XII/XIV).
const isArchitectStrategy = (s: string) =>
  isRiverStrategy(s) || isUltraStrategy(s);

// Human-readable "who enforced this" name for the certificate's Enforcer line
// (e.g. "Leak Ultra Fleeting", "Leak River Gate") — distinct per strategy,
// replacing the bland "Leak" every certificate showed before this existed.
const STRONGHOLD_ENFORCER_LABELS: Record<string, string> = {
  hacker: 'Leak Hacker',
  pantograph: 'Leak Pantograph',
  librarian: 'Leak Librarian',
  sketch: 'Leak Sketch',
  brute: 'Leak Brute',
  have: 'Leak Have',
  'have-tree': 'Leak Stronghold Dark',
};
function enforcerLabelFor(strategy: string): string {
  const river = RIVER_STRATEGIES.find((s) => s.value === strategy);
  if (river) return river.label.split('(')[0].trim();
  const ultra = ULTRA_STRATEGIES.find((s) => s.value === strategy);
  if (ultra) return ultra.label.split('(')[0].trim();
  return STRONGHOLD_ENFORCER_LABELS[strategy] ?? 'Leak';
}

// Replace this toolchain's entry (re-verifying the same toolchain updates it
// in place) or append a new one (a genuinely new toolchain). Never grows
// unbounded — one entry per distinct toolchain, always.
function upsertCertEntry(certs: CertEntry[] | undefined, entry: CertEntry): CertEntry[] {
  const next = (certs ?? []).filter((c) => c.toolchain !== entry.toolchain);
  next.push(entry);
  return next;
}
// certs[] is the source of truth once populated; an item that only ever had
// ONE verify (certs never touched) falls back to synthesizing a single-entry
// list from the flat fields, so every downstream consumer can just read
// certs() and get the right answer regardless of how the item got there.
function certsOrFallback(item: StagedItem): CertEntry[] {
  if (item.certs?.length) return item.certs;
  if (!item.proof) return [];
  return [{
    toolchain: item.toolchain || TOOLCHAIN,
    mathlib: item.mathlib ?? null,
    enforcer: item.enforcer ?? null,
    proof: item.proof,
    verifiedAt: item.verifiedAt ?? null,
    signature: item.signature ?? null,
    signatureKeyId: item.signatureKeyId ?? null,
    certMintedAt: item.certMintedAt ?? null,
  }];
}

// Would this proof text make a HONEST certificate for `target`? A certificate
// asserts "sorry-free Lean proof of THIS theorem", so both claims are checked
// here rather than trusted from whichever orchestrator produced the text. This is
// deliberately shape-only — the kernel already ruled on correctness; this catches
// a proof of the wrong statement, or one that still has a hole, before it gets
// signed and published. Returns null when the proof is fit to certify.
//
// Whitespace-insensitive on the signature: the architect path re-emits the
// declaration with its own formatting, and the certified file legitimately opens
// with `import Mathlib` where the have-path proofs are import-less.
function certifiableProof(target: string, proof: string): string | null {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const name = /(?:theorem|lemma)\s+([A-Za-z_][\w'.]*)/.exec(target)?.[1];
  if (!name) return null; // no target declaration to compare against
  if (!new RegExp(`(?:theorem|lemma)\\s+${name.replace(/\./g, '\\.')}\\b`).test(proof))
    return `proof does not declare the target theorem \`${name}\``;
  // The signature is everything up to the `:=` that opens the proof body.
  const sig = norm(
    target.replace(/:=\s*by[\s\S]*$/, '').replace(/:=\s*sorry[\s\S]*$/, ''),
  );
  if (sig && !norm(proof).includes(sig))
    return `proof's declaration does not match the target signature byte-for-byte`;
  if (/\bsorry\b/.test(proof)) return 'proof still contains `sorry`';
  return null;
}

// A generated "lean" field must be exactly one declaration — the theorem
// itself. If the generator split it into a separate top-level def/abbrev/etc.
// (typically to define a helper recursive sequence) the problem is
// permanently unprovable downstream: every verifier compares the target
// signature verbatim against that ONE declaration's own parsed signature,
// never the surrounding file — a leading def can never match, no matter what
// gets submitted. Prompt instructions alone aren't a reliable enough gate
// (models improvise this shape when a statement genuinely needs a helper
// function), so this is caught here, deterministically, before it's queued.
const LEADING_DECL_RE =
  /^\s*(?:private\s+|protected\s+|noncomputable\s+|public\s+)*(?:def|abbrev|structure|instance|inductive)\b/m;
function leanSplitsIntoSeparateDecl(lean: string): boolean {
  return LEADING_DECL_RE.test(lean);
}

export function AdminPipeline() {
  const [work, setWork] = useState(false);
  const [genStage, setGenStage] = useState<
    | 'idle'
    | 'generating'
    | 'elaborating'
    | 'reformalizing'
    | 'validating'
    | 'gauntlet'
    | 'assessing'
    | 'saving'
  >('idle');
  const [stats, setStats] = useState({
    generated: 0,
    verified: 0,
    failed: 0,
    errors: 0,
    downgraded: 0,
  });
  const [log, setLog] = useState<LogEntry[]>([]);
  const [logOpen, setLogOpen] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);

  const copy = useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  }, []);

  const pushLog = useCallback(
    (level: LogEntry['level'], message: string, detail?: string) => {
      setLog((l) =>
        [
          {
            id: Date.now() + Math.random(),
            ts: Date.now(),
            level,
            message,
            detail,
          },
          ...l,
        ].slice(0, 100),
      );
    },
    [],
  );

  const pauseForLimit = useCallback(
    (lim: { message: string; resetText?: string; resetAt?: number }) => {
      if (limitPausedRef.current) return;
      limitPausedRef.current = true;
      setLimitPause(lim);
      pushLog(
        'warn',
        `Paused — Claude session/usage limit reached${
          lim.resetText ? ` (${lim.resetText})` : ''
        }. Work auto-resumes at reset.`,
        lim.message,
      );
    },
    [pushLog],
  );

  const [health, setHealth] = useState<Health | null>(null);
  const [items, setItems] = useState<StagedItem[]>([]);
  const [generated, setGenerated] = useState<GeneratedItem[]>([]);
  const [genCap, setGenCap] = useState(200);
  const [genFilter, setGenFilter] = useState<GenFilter>('all');
  const [previewIds, setPreviewIds] = useState<string[]>([]);
  const [mode, setMode] = useState<GenMode>('medium');
  // Statement pre-check + the banner shown when it can't run (Leak IV not
  // connected). The banner is separate from the activity console because a
  // missing daemon is an infrastructure problem the user must act on, not a
  // verdict scrolling past in a log.
  const [statementCheck, setStatementCheck] = useState<StatementCheck>('leak');
  const [checkError, setCheckError] = useState<string | null>(null);
  // Generation model — independent from the verification model. '' = default.
  const [genModel, setGenModel] = useState('');
  const genModelRef = useRef(genModel);
  useEffect(() => {
    genModelRef.current = genModel;
  }, [genModel]);
  const [liveProblems, setLiveProblems] = useState<LiveProblem[]>([]);
  // Titles currently in the prod queue (awaiting the CompeteMath cron). Used to
  // flag generated items that are already staged for publication.
  const [prodTitles, setProdTitles] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [workBridgeUrl, setWorkBridgeUrl] = useState('');
  const [generatingOne, setGeneratingOne] = useState(false);

  // Verification queue (client-side): problems awaiting proof, processed serially
  // by a single verifier so generation and proving stay decoupled.
  const [verifyQueue, setVerifyQueue] = useState<GeneratedItem[]>([]);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [verifyPaused, setVerifyPaused] = useState<string | null>(null);
  // Full, normalized prover activity for the shared <ProverConsole> (thinking,
  // tool calls, tool results/errors, verify attempts, metrics) — not just names.
  const [verifyEvents, setVerifyEvents] = useState<ProverEvent[]>([]);
  // Same console, fed by generation: the generator's own run, every gauntlet
  // solver/judge exchange, mutation repairs, and the final save/scrap — so a
  // stuck or looping run can be watched live and copy-pasted whole.
  const [genEvents, setGenEvents] = useState<ProverEvent[]>([]);
  const genEventIdRef = useRef(0);
  // Accumulates across EVERY attempt in a Work-loop session — never cleared
  // per-attempt, or a fast-failing attempt's error would vanish the instant
  // the next attempt starts (which is exactly what made a real stuck run look
  // like "nothing is happening": the one attempt that mattered got wiped).
  // Capped so an unattended overnight Work loop can't grow this unbounded.
  const GEN_EVENTS_CAP = 500;
  const pushGenEvent = useCallback(
    (kind: ProverEventKind, label: string, extra?: Partial<ProverEvent>) => {
      genEventIdRef.current += 1;
      const ev: ProverEvent = {
        id: genEventIdRef.current,
        ts: Date.now(),
        kind,
        label,
        ...extra,
      };
      setGenEvents((prev) => {
        const next = [...prev, ev];
        return next.length > GEN_EVENTS_CAP
          ? next.slice(next.length - GEN_EVENTS_CAP)
          : next;
      });
    },
    [],
  );
  // Decompose mode: when on, ACG verification drives the /prove-tree orchestrator
  // (prove-or-split) instead of the single-agent /prove-stream. Held in a ref so
  // proveStream can read the latest value without re-creating the verify loop.
  const [verifyDecompose, setVerifyDecompose] = useState(false);
  const verifyDecomposeRef = useRef(verifyDecompose);
  useEffect(() => {
    verifyDecomposeRef.current = verifyDecompose;
  }, [verifyDecompose]);
  // Strategy mode (A/B testing proof approaches) for the decompose path. Held in
  // a ref for the same reason as verifyDecompose.
  const [verifyStrategy, setVerifyStrategy] = useState('hacker');
  const verifyStrategyRef = useRef(verifyStrategy);
  useEffect(() => {
    verifyStrategyRef.current = verifyStrategy;
  }, [verifyStrategy]);
  // Model the prover runs on ('' = the bridge/CLI default). Held in a ref so the
  // async verify loop reads the latest value. Passed through to `claude --model`.
  const [verifyModel, setVerifyModel] = useState('');
  const verifyModelRef = useRef(verifyModel);
  useEffect(() => {
    verifyModelRef.current = verifyModel;
  }, [verifyModel]);
  // The Leak River strategies always drive Grok directly — force the model and
  // lock the selector while one is active; fall back to the default the moment
  // the operator switches to any other strategy.
  useEffect(() => {
    if (isRiverStrategy(verifyStrategy)) setVerifyModel(ARCHITECT_MODEL);
    else setVerifyModel((m) => (m === ARCHITECT_MODEL ? '' : m));
  }, [verifyStrategy]);
  // Refinement-iteration budget for River runs (the "+1 iter" button). Held in a
  // ref too so the async verify loop reads the value at dispatch time.
  const [verifyMaxIters, setVerifyMaxIters] = useState(ARCHITECT_DEFAULT_ITERS);
  const verifyMaxItersRef = useRef(verifyMaxIters);
  useEffect(() => {
    verifyMaxItersRef.current = verifyMaxIters;
  }, [verifyMaxIters]);

  // Live monitoring: start timestamps drive elapsed timers; usage accumulates
  // token/cost metadata reported by the bridge.
  const [genStartedAt, setGenStartedAt] = useState<number | null>(null);
  const [verifyStartedAt, setVerifyStartedAt] = useState<number | null>(null);
  const [, setNowTick] = useState(0);
  // Wall-clock compute budget for a verification run (tree path). The bridge
  // reports the runId + deadline via onRunId; the "+5 min" button pushes it out.
  const [computeLimit, setComputeLimit] = useState<{
    deadlineMs: number;
    budgetMs: number;
  } | null>(null);
  const [extending, setExtending] = useState(false);
  const [extendingIters, setExtendingIters] = useState(false);
  const runIdRef = useRef<string | null>(null);
  // item.id -> saved checkpoint to resume from, set by "Resume from saved" and
  // consumed once by the verify loop (so a plain re-verify still starts fresh).
  const resumeSeedRef = useRef<Record<string, string>>({});
  const [usage, setUsage] = useState({
    calls: 0,
    tokens: 0,
    costUsd: 0,
    lastTokens: 0,
    lastCostUsd: 0,
  });

  // Cost estimator: per-item estimate/actual (session-scoped, keyed by item id)
  // + the running accuracy scoreboard. `costsRef` mirrors `costs` so the async
  // verify loop can read/patch without a stale closure. `estPromiseRef` holds the
  // in-flight estimate so the loop can join it (for the history row id) when the
  // proof — which runs concurrently — finishes.
  const [costs, setCosts] = useState<Record<string, ItemCost>>({});
  const costsRef = useRef<Record<string, ItemCost>>({});
  const estPromiseRef = useRef<Record<string, Promise<EstimateResult | null>>>(
    {},
  );
  const [estStats, setEstStats] = useState<EstStats | null>(null);
  const setCost = useCallback((id: string, patch: Partial<ItemCost>) => {
    costsRef.current = {
      ...costsRef.current,
      [id]: { ...costsRef.current[id], ...patch },
    };
    setCosts({ ...costsRef.current });
  }, []);
  const loadEstStats = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/cost-history?stats');
      if (r.ok) setEstStats((await r.json())?.stats ?? null);
    } catch {
      /* scoreboard is best-effort */
    }
  }, []);

  // Auto-pause when Claude's session/usage limit is hit; auto-resume at reset.
  const [limitPause, setLimitPause] = useState<{
    message: string;
    resetText?: string;
    resetAt?: number;
  } | null>(null);

  const workRef = useRef(false);
  const genAbortRef = useRef<AbortController | null>(null);
  const verifyAbortRef = useRef<AbortController | null>(null);
  const limitPausedRef = useRef(false);
  const queueRef = useRef<GeneratedItem[]>([]);
  const verifyingIdRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  // Refs so generateOne reads the latest mode + existing problems for the prompt
  // without depending on that state (which would restart the Work loop).
  const modeRef = useRef<GenMode>('medium');
  const statementCheckRef = useRef<StatementCheck>('leak');
  const generatedRef = useRef<GeneratedItem[]>([]);
  const liveRef = useRef<LiveProblem[]>([]);

  const syncQueue = () => setVerifyQueue([...queueRef.current]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    statementCheckRef.current = statementCheck;
  }, [statementCheck]);
  useEffect(() => {
    generatedRef.current = generated;
  }, [generated]);

  // Tick once a second while something is running (or paused), so elapsed timers
  // and the limit countdown update live.
  useEffect(() => {
    if (genStartedAt == null && verifyStartedAt == null && !limitPause) return;
    const id = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [genStartedAt, verifyStartedAt, limitPause]);

  const recordUsage = useCallback((u: any, costUsd: number | null) => {
    const t =
      (u?.input_tokens ?? 0) +
      (u?.cache_creation_input_tokens ?? 0) +
      (u?.cache_read_input_tokens ?? 0) +
      (u?.output_tokens ?? 0);
    if (!t && !costUsd) return;
    const cost = costUsd ?? 0;
    setUsage((s) => ({
      calls: s.calls + 1,
      tokens: s.tokens + t,
      costUsd: s.costUsd + cost,
      lastTokens: t,
      lastCostUsd: cost,
    }));
  }, []);

  const callBridge = useCallback(
    (useWork: boolean, path: string, init?: RequestInit) => {
      const conn = connFor(useWork);
      let base = (conn.bridgeUrl || 'http://localhost:4123').replace(/\/$/, '');
      // Tolerate a bare host:port (e.g. "localhost:4123") — fetch needs a scheme.
      if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
      return fetch(`${base}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          'x-bridge-token': conn.token || '',
          ...(init?.headers || {}),
        },
      });
    },
    [],
  );

  // Streaming twin of callBridge('/run'): drives the bridge's /run-stream SSE,
  // mirroring EVERY live step (thinking deltas, tool calls, tool output, model
  // status) into the generation console via pushGenEvent — so a 15-minute
  // generator/solver run reads as a living transcript instead of dead air —
  // and resolves with exactly the JSON /run would have returned. Falls back to
  // the blocking /run on an older bridge (404), so an un-updated bridge still
  // works; you just don't get live progress until it's re-downloaded.
  const runBridgeStream = useCallback(
    async (
      useWork: boolean,
      payload: { prompt: string; options: Record<string, unknown> },
      tag: string,
      signal: AbortSignal,
    ): Promise<BridgeRunResult> => {
      const res = await callBridge(useWork, '/run-stream', {
        method: 'POST',
        body: JSON.stringify(payload),
        signal,
      });
      if (res.status === 404) {
        // Old bridge without /run-stream — degrade to the silent blocking call.
        pushGenEvent(
          'system',
          `${tag}: bridge has no /run-stream — re-download the bridge for live progress`,
        );
        const r = await callBridge(useWork, '/run', {
          method: 'POST',
          body: JSON.stringify(payload),
          signal,
        });
        if (!r.ok)
          throw Object.assign(new Error(`Bridge /run failed (${r.status})`), {
            httpStatus: r.status,
            body: await r.text().catch(() => ''),
          });
        return (await r.json()) as BridgeRunResult;
      }
      if (!res.ok || !res.body)
        throw Object.assign(
          new Error(`Bridge /run-stream failed (${res.status})`),
          { httpStatus: res.status, body: await res.text().catch(() => '') },
        );

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let result: BridgeRunResult | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() || '';
        for (const f of frames) {
          if (!f.startsWith('data:')) continue;
          let d: Record<string, any>;
          try {
            d = JSON.parse(f.replace(/^data:\s*/, ''));
          } catch {
            continue;
          }
          switch (d.type) {
            case 'thinking':
              pushGenEvent('thinking', `${tag} — thinking`, {
                detail: String(d.text || ''),
              });
              break;
            case 'system':
              if (d.model) pushGenEvent('system', `${tag} — model ${d.model}`);
              break;
            case 'message-annotation':
              if (d.subtype === 'tool_intent')
                pushGenEvent('tool_call', `${tag} → ${d.tool}`, {
                  tool: d.tool,
                  input: typeof d.input === 'string' ? d.input : undefined,
                });
              else if (d.subtype === 'tool_result')
                pushGenEvent('tool_result', `${tag} ← tool output`, {
                  detail: String(d.output ?? ''),
                });
              else if (d.thought)
                pushGenEvent(
                  'text',
                  `${tag}: ${String(d.thought).split('\n')[0].slice(0, 160)}`,
                  { detail: String(d.thought) },
                );
              break;
            case 'result':
              result = d as BridgeRunResult;
              break;
            default:
              // heartbeat — liveness only, nothing to render
              break;
          }
        }
      }
      if (!result) {
        if (signal.aborted) throw new Error('Terminated by you');
        throw new Error(
          `${tag}: stream ended without a result — the bridge process likely died mid-run`,
        );
      }
      return result;
    },
    [callBridge, pushGenEvent],
  );

  const fetchMcp = (): Promise<ProverMcpServer[]> => fetchProverMcpServers();

  // Kick off the cost estimate for an item (auto, on enqueue). Runs CONCURRENTLY
  // with proving; the result lands on `costs[id]` and the promise on
  // `estPromiseRef` so the verify loop can join it and record the actual against
  // the same proof_cost_history row.
  const runEstimate = useCallback(
    (item: GeneratedItem) => {
      // Recompute on every (re-)verify — the only caller, enqueueVerify, already
      // dedupes queued items, so this fires once per verify and a repeat verify
      // gets a fresh estimate instead of being silently skipped.
      if (!item.lean) return;
      setCost(item.id, { estimating: true, estFailed: false });
      const model = verifyModelRef.current || 'claude-opus-4-8';
      const features = extractFeatures(
        {
          questionTitle: item.questionTitle,
          problem: item.problem,
          difficulty: item.difficulty,
          level: item.level,
          lean: item.lean,
        },
        { decompose: verifyDecomposeRef.current, model },
      );
      // Estimate: the trained ML service (signature→cost) when available, else
      // the deterministic k-NN quantile over cost history. Pass the Lean goal so
      // the service can predict from the signature alone.
      const p = estimateCost({ features, theorem: item.lean || '' })
        .then((est) => {
          if (est) {
            setCost(item.id, {
              estimating: false,
              estUsd: est.estimateUsd,
              estLow: est.low,
              estHigh: est.high,
              estRationale: est.rationale,
              costHistoryId: est.costHistoryId,
            });
            // Persist onto the generated record so the estimate survives a
            // refresh (the `costs` map is session-only). Best-effort.
            patchGenerated(item.id, {
              estUsd: est.estimateUsd,
              estLow: est.low,
              estHigh: est.high,
              estRationale: est.rationale,
              costHistoryId: est.costHistoryId,
            });
          } else setCost(item.id, { estimating: false, estFailed: true });
          return est;
        })
        .catch(() => {
          setCost(item.id, { estimating: false, estFailed: true });
          return null;
        });
      estPromiseRef.current[item.id] = p;
    },
    [callBridge, setCost],
  );

  // Prove via the SHARED bridge, streaming EVERY step into <ProverConsole> via
  // the same runProverStream the admin queue resolver + playground use. THROWS on
  // a connectivity/protocol failure (unreachable bridge, non-2xx, no completion
  // event) so the verifier treats it as transient and keeps the item queued,
  // rather than mis-marking it "failed". Returns an outcome only on a real
  // `done` event. A usage-limit message is detected from the streamed text and
  // rethrown as `__limit__` so the loop pauses instead of failing the item.
  const proveStream = useCallback(
    async (
      lean: string,
      mcpServers: ProverMcpServer[],
      signal?: AbortSignal,
      opts?: { itemId?: string; seed?: string; nlProof?: string },
    ) => {
      const conn = connFor(false); // shared (verification) bridge
      let content = ''; // accumulate text to detect a session-limit message
      const onEvent = (ev: ProverEvent) => {
        setVerifyEvents((prev) => [...prev, ev]);
        if (ev.detail) content += ` ${ev.detail}`;
        if (ev.label) content += ` ${ev.label}`;
      };
      try {
        // Resuming from a saved checkpoint is always a tree run (the seed is a
        // have-tree skeleton), so force the tree path + budget regardless of the
        // current decompose toggle.
        const resuming = !!opts?.seed;
        const decompose = verifyDecomposeRef.current || resuming;
        const strategy = verifyStrategyRef.current;
        const model = verifyModelRef.current;
        const outcome = await runProverStream({
          problem: lean,
          mcpServers,
          model: model || undefined,
          bridgeUrl: conn.bridgeUrl,
          token: conn.token,
          signal,
          onEvent,
          source: decompose ? `acg-tree:${strategy}` : 'acg',
          endpoint: decompose ? 'prove-tree' : 'prove-stream',
          strategy: decompose ? strategy : undefined,
          seed: opts?.seed,
          nlProof: opts?.nlProof,
          // Tree path runs under an extendable wall-clock budget; the single-agent
          // path ignores it (and never fires onRunId), so the indicator stays off.
          // Architect gets a much tighter budget (see ARCHITECT_COMPUTE_BUDGET_MS).
          computeBudgetMs: decompose
            ? isArchitectStrategy(strategy)
              ? ARCHITECT_COMPUTE_BUDGET_MS
              : VERIFY_COMPUTE_BUDGET_MS
            : undefined,
          // Architect pipeline only (River + Ultra): refinement budget from the
          // "+1 iter" control.
          maxIters: isArchitectStrategy(strategy)
            ? verifyMaxItersRef.current
            : undefined,
          onRunId: ({ runId, deadlineMs, budgetMs }) => {
            runIdRef.current = runId;
            // River runs report a runId even on an uncapped clock (the "+1 iter"
            // button needs one), so only show the time indicator for a real budget.
            if (budgetMs > 0) setComputeLimit({ deadlineMs, budgetMs });
          },
          // Auto-save: persist the newest banked checkpoint on the item so ANY
          // stop (usage-limit / Terminate / crash) can resume from it later.
          onCheckpoint: ({ skeleton, filled, total }) => {
            if (!opts?.itemId) return;
            patchGenerated(opts.itemId, {
              proofCheckpoint: skeleton,
              proofCheckpointFilled: filled,
              proofCheckpointTotal: total,
            });
          },
        });
        const lim = detectSessionLimit(content);
        if (lim.hit) throw Object.assign(new Error('__limit__'), { limit: lim });
        return outcome;
      } catch (e) {
        // A usage limit takes priority even when the stream ended abruptly.
        const lim = detectSessionLimit(content);
        if (lim.hit) throw Object.assign(new Error('__limit__'), { limit: lim });
        throw e; // abort (runVerifier checks signal.aborted) or transient
      }
    },
    [],
  );

  const patchGenerated = async (id: string, patch: Record<string, unknown>) => {
    const res = await fetch('/api/admin/generated', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, ...patch }),
    });
    if (res.ok) {
      const j = await res.json();
      if (j.item)
        setGenerated((g) => g.map((x) => (x.id === j.item.id ? j.item : x)));
    }
  };

  // Research telemetry: one row per verification ATTEMPT into whichever table
  // matches the strategy that ran — Leak River (architect) or Leak Stronghold
  // (every Claude-driven strategy: hacker/pantograph/librarian/sketch/brute/
  // have/have-tree, or the plain single-agent CLI with decompose off). Fire-
  // and-forget: recording must never affect the verify loop.
  const recordResearchRun = useCallback(
    (args: {
      item: GeneratedItem;
      strategy: string;
      model: string;
      verified: boolean;
      refuted: boolean;
      costUsd?: number;
      computeBudgetMs?: number;
      metrics?: ProverMetrics;
      finalProof: string;
      error: string | null;
      nlSeedUsed: boolean;
      seedUsed: boolean;
    }) => {
      const {
        item,
        strategy,
        model,
        verified,
        refuted,
        costUsd,
        computeBudgetMs,
        metrics,
        finalProof,
        error,
        nlSeedUsed,
        seedUsed,
      } = args;
      const theoremName =
        /(?:theorem|lemma)\s+([A-Za-z_][\w'.]*)/.exec(item.lean || '')?.[1] ??
        null;
      const common = {
        generatedItemId: item.id,
        problemTitle: item.questionTitle ?? item.problem?.slice(0, 80) ?? null,
        difficulty: item.difficulty ?? null,
        theoremName,
        sorriedTheorem: item.lean || '',
        model: model || null,
        // Every model that actually served a call. The bridge reports this for
        // River runs (driver + any ladder fallback + the Sonnet seed); for the
        // Claude strategies the configured model is the only one that runs.
        modelsUsed:
          metrics?.models_used && metrics.models_used.length
            ? metrics.models_used
            : model
              ? [model]
              : null,
        verified,
        refuted,
        costUsd: costUsd ?? null,
        computeBudgetMs: computeBudgetMs ?? null,
        timeElapsedS: metrics?.time_elapsed ?? null,
        llmCalls: metrics?.llm_invocations ?? null,
        toolCalls: metrics?.tools_invoked ?? null,
        finalProof: finalProof || null,
        error,
        bridgeBuild: metrics?.bridge_build ?? null,
        // The toolchain that ACTUALLY certified this run, as reported by the
        // bridge from the armed verifier group. Falling back to the group implied
        // by the strategy keeps older bridges honest rather than defaulting every
        // row to 4.29.1, which would be a false claim for architect runs.
        leanToolchain:
          metrics?.lean_toolchain ??
          (isArchitectStrategy(strategy) ? ARCHITECT_TOOLCHAIN : TOOLCHAIN),
        mathlibVersion:
          metrics?.mathlib_version ??
          (isArchitectStrategy(strategy)
            ? ARCHITECT_MATHLIB_VERSION
            : MATHLIB_VERSION),
      };
      const path = isRiverStrategy(strategy)
        ? '/api/admin/research/river'
        : isUltraStrategy(strategy)
          ? '/api/admin/research/ultra'
          : '/api/admin/research/stronghold';
      const body = isUltraStrategy(strategy)
        ? {
            ...common,
            strategy,
            // Claude CLI driver: one authoritative cost, one combined token
            // total — no per-bucket counts and no driver/seed split to report.
            tokens: metrics?.tokens ?? null,
            costCapHit: metrics?.cost_cap_hit ?? null,
            maxIters: metrics?.max_iters ?? null,
            blueprintIterations: metrics?.blueprint_iterations ?? null,
            nodesTotal: metrics?.nodes_total ?? null,
            nodesSolved: metrics?.nodes_solved ?? null,
            nodesForfeited: metrics?.nodes_forfeited ?? null,
            nodesNegated: metrics?.nodes_negated ?? null,
          }
        : isRiverStrategy(strategy)
        ? {
              ...common,
              // Which River variant ran — the GROUP BY key for the comparison.
              strategy,
              // Prefer the bridge's own observation of whether a seed was used
              // (river-delta generates its own), falling back to what we sent.
              nlSeedUsed: metrics?.nl_seed_used ?? nlSeedUsed,
              costDriverUsd: metrics?.cost_driver_usd ?? null,
              costSeedUsd: metrics?.cost_seed_usd ?? null,
              promptTokens: metrics?.prompt_tokens ?? null,
              completionTokens: metrics?.completion_tokens ?? null,
              cachedTokens: metrics?.cached_tokens ?? null,
              costCapHit: metrics?.cost_cap_hit ?? null,
              maxIters: metrics?.max_iters ?? null,
              blueprintIterations: metrics?.blueprint_iterations ?? null,
              nodesTotal: metrics?.nodes_total ?? null,
              nodesSolved: metrics?.nodes_solved ?? null,
              nodesForfeited: metrics?.nodes_forfeited ?? null,
              nodesNegated: metrics?.nodes_negated ?? null,
              deadEndsShared: metrics?.dead_ends_shared ?? null,
              deadEndsKnown: metrics?.dead_ends_known ?? null,
            }
          : {
              ...common,
              strategy,
              haveCaseCount: finalProof
                ? (finalProof.match(/\bhave\b/g) || []).length
                : null,
              checkpointUsed: seedUsed,
            };
      fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => {
        /* research logging must never affect the verify loop */
      });
    },
    [],
  );

  // The single verifier: pulls the head of the queue, proves it on the shared
  // bridge, persists the outcome (clearing the DB `queued` flag), and moves on.
  // A connectivity/protocol failure PAUSES the loop and leaves the item queued —
  // so a bridge that's down never mis-marks problems as failed.
  const runVerifier = useCallback(async () => {
    if (runningRef.current) return;
    // Strategy "off" — generate only, never prove. Guarding the one entry point
    // covers every caller (post-generation, manual enqueue, resume-from-
    // checkpoint, rebuild-on-load, usage-limit auto-resume), so no path can
    // start a prover run behind the operator's back. Items already queued stay
    // queued; they simply wait until a real strategy is selected.
    if (verifyStrategyRef.current === VERIFY_OFF) return;
    runningRef.current = true;
    setVerifyPaused(null);
    try {
      while (queueRef.current.length > 0) {
        // Stop proving while paused for a usage limit (auto-resumes on reset).
        if (limitPausedRef.current) break;
        const item = queueRef.current[0];
        verifyingIdRef.current = item.id;
        setVerifyingId(item.id);
        setVerifyEvents([]);
        runIdRef.current = null;
        setComputeLimit(null);
        const ctrl = new AbortController();
        verifyAbortRef.current = ctrl;
        setVerifyStartedAt(Date.now());

        let verified = false;
        let proof = '';
        let refuted = false;
        let counterexample = '';
        let actualUsd: number | undefined;
        // Captured for the research row regardless of outcome (verified or not).
        const strategyAtStart = verifyStrategyRef.current;
        const modelAtStart = verifyModelRef.current;
        let outMetrics: ProverMetrics | undefined;
        let nlSeedUsed = false;
        let seedUsed = false;
        let computeBudgetMsAtStart: number | undefined;
        try {
          const mcpServers = await fetchMcp();
          // If this item was enqueued via "Resume from saved", hand its checkpoint
          // to the run so it finishes from banked progress. One-shot: consumed here
          // so a later plain re-verify starts fresh.
          const seed = resumeSeedRef.current[item.id];
          delete resumeSeedRef.current[item.id];
          seedUsed = !!seed;
          // NL guidance is NOT injected here. This used to hand every architect
          // run the item's own problem statement, answer and solution sketch,
          // which wrecked the whole comparison: Stone stopped being a control,
          // and Delta's local Sonnet seed never fired (the bridge only generates
          // one when none was supplied), so Delta was silently identical to Gate.
          // Whether a variant gets an informal proof — and where it comes from —
          // is now decided solely by the variant (see architectConfigFor).
          const nlProof = undefined;
          nlSeedUsed = false;
          // Mirrors proveStream's own decompose check exactly (a resumed seed
          // always runs the tree path, even with the toggle off).
          computeBudgetMsAtStart = verifyDecomposeRef.current || seedUsed
            ? isArchitectStrategy(strategyAtStart)
              ? ARCHITECT_COMPUTE_BUDGET_MS
              : VERIFY_COMPUTE_BUDGET_MS
            : undefined;
          const out = await proveStream(
            item.lean as string,
            mcpServers,
            ctrl.signal,
            { itemId: item.id, seed, nlProof },
          );
          verified = out.verified;
          // Actual dollar cost of the whole run (summed across sub-runs on the
          // bridge). Shown on the card and recorded against the estimate.
          actualUsd = typeof out.costUsd === 'number' ? out.costUsd : undefined;
          // For a refuted theorem there is no proof — store the machine-checked
          // `¬theorem` disproof instead so the card can show the counterexample.
          proof = out.refuted ? out.disproof || '' : out.proof;
          refuted = !!out.refuted;
          counterexample = out.counterexample || '';
          outMetrics = out.metrics;
        } catch (e) {
          const title =
            item.questionTitle || item.problem?.slice(0, 60) || item.id;
          if (ctrl.signal.aborted) {
            // User terminated THIS verification — mark it and move to the next.
            await patchGenerated(item.id, {
              verified: false,
              error: 'Verification terminated by you',
              queued: false,
            });
            setStats((s) => ({ ...s, failed: s.failed + 1 }));
            pushLog('warn', `Verification terminated: ${title}`);
            queueRef.current = queueRef.current.filter((x) => x.id !== item.id);
            syncQueue();
            continue;
          }
          const lim = (e as { limit?: Parameters<typeof pauseForLimit>[0] })
            .limit;
          if (lim) {
            // Usage limit — leave this item queued and pause everything.
            pauseForLimit(lim);
            break;
          }
          // Transient — keep the item queued (DB flag stays true) and stop.
          const msg = String((e as Error)?.message || e);
          setVerifyPaused(msg);
          pushLog('warn', `Verification paused: ${msg} (items stay queued)`);
          break;
        }

        // Genuine outcome: persist it and clear the queued flag. A `refuted`
        // result (the theorem is machine-disproved false) is stored with a
        // distinct marker so it reads as a BAD problem, not a hard one.
        // The exact moment the Lean kernel confirmed this proof.
        const verifiedAt = verified ? new Date().toISOString() : undefined;
        // The toolchain that ACTUALLY certified this proof, straight from the
        // bridge. Architect runs are certified by Leak XIV on 4.32.0, the others
        // by the Leak II/IV daemon on 4.29.1 — the certificate must not claim one
        // when the other did the work.
        const runToolchain =
          outMetrics?.lean_toolchain ??
          (isArchitectStrategy(strategyAtStart) ? ARCHITECT_TOOLCHAIN : TOOLCHAIN);
        const runMathlib =
          outMetrics?.mathlib_version ??
          (isArchitectStrategy(strategyAtStart)
            ? ARCHITECT_MATHLIB_VERSION
            : MATHLIB_VERSION);
        // Mint the SIGNED certificate right now — as close to kernel verification
        // as possible, so the signed bytes are provably what the kernel saw. The
        // private key never leaves the server (this hits /api/admin/certificate/
        // sign). Best-effort: an unsigned cert still publishes if signing is off.
        let cert:
          | { signature?: string | null; keyId?: string | null; certMintedAt?: string | null }
          | null = null;
        // Shape gate before signing. A certificate asserts "this text is a
        // sorry-free Lean proof of THIS theorem", so refuse to sign anything that
        // doesn't carry the target declaration or still contains a hole — cheap
        // insurance that holds for every strategy, including new ones whose
        // assembly step the certificate layer knows nothing about.
        const certShapeError = verified && proof ? certifiableProof(item.lean || '', proof) : null;
        if (certShapeError) {
          pushLog(
            'warn',
            `Not signing ${item.questionTitle || item.id}: ${certShapeError}`,
          );
        }
        // Accumulated once signing is attempted below — every DISTINCT toolchain
        // this item has ever been verified on, upserted by toolchain (a re-verify
        // of the SAME toolchain replaces its entry, never duplicates it). This is
        // what lets an admin verify a problem on several toolchains before ever
        // promoting it, and ship all of them as independent certificates the
        // first time it goes live — see certsOrFallback/upsertCertEntry.
        let updatedCerts: CertEntry[] | undefined;
        if (verified && proof && !certShapeError) {
          try {
            const r = await fetch('/api/admin/certificate/sign', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                title: item.questionTitle,
                proof,
                verifiedAt,
                // Signed INTO the certificate bytes, so the toolchain claim is
                // covered by the signature rather than being loose metadata.
                toolchain: runToolchain,
                mathlib: runMathlib,
                // Which specific strategy enforced this proof — shown on the
                // certificate instead of the bland "Leak".
                enforcer: enforcerLabelFor(strategyAtStart),
              }),
            });
            if (r.ok) cert = await r.json();
          } catch {
            /* signing best-effort — the proof is still recorded either way */
          }
          updatedCerts = upsertCertEntry(item.certs, {
            toolchain: runToolchain,
            mathlib: runMathlib,
            enforcer: enforcerLabelFor(strategyAtStart),
            proof,
            verifiedAt,
            signature: cert?.signature ?? null,
            signatureKeyId: cert?.keyId ?? null,
            certMintedAt: cert?.certMintedAt ?? null,
          });
          // Robustness feature, backend-only (no UI change): if this title is
          // ALREADY published and this toolchain doesn't have a certificate
          // for it yet, push this one straight to prod as an additional
          // certificate. No-ops if never published, or if this toolchain is
          // already covered. Fire-and-forget — never blocks the verify loop.
          if (cert?.signature) {
            fetch('/api/admin/problems/attach-certificate', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                id: item.id,
                questionTitle: item.questionTitle,
                subtitle: item.subtitle,
                problem: item.problem,
                difficulty: item.difficulty,
                points: item.points,
                answer: item.answer,
                level: item.level,
                insight: item.insight,
                lean: item.lean,
                proof,
                toolchain: runToolchain,
                mathlib: runMathlib,
                enforcer: enforcerLabelFor(strategyAtStart),
                verifiedAt,
                signature: cert.signature,
                signatureKeyId: cert.keyId,
                certMintedAt: cert.certMintedAt,
              }),
            }).catch(() => {
              /* best-effort — a failed attach just means this stays local */
            });
          }
        }
        await patchGenerated(item.id, {
          verified,
          proof,
          ...(verified ? { verifiedAt } : {}),
          // Carried so staging → promote → CompeteMath ship the toolchain that
          // actually certified THIS proof, not the pipeline's default.
          ...(verified
            ? { toolchain: runToolchain, mathlib: runMathlib, enforcer: enforcerLabelFor(strategyAtStart) }
            : {}),
          // Signature + the moment it was minted, carried through staging → prod
          // so CompeteMath stores this exact signature instead of re-signing.
          ...(cert?.signature
            ? {
                signature: cert.signature,
                signatureKeyId: cert.keyId,
                certMintedAt: cert.certMintedAt,
              }
            : {}),
          // The full accumulated set of per-toolchain certificates (see above).
          ...(updatedCerts ? { certs: updatedCerts } : {}),
          error: verified
            ? null
            : refuted
              ? `↯ REFUTED — ${counterexample || 'counterexample verified by Lean'}`
              : 'Lean proof did not verify',
          queued: false,
          // A proven (or refuted) problem's checkpoint is stale — clear it so no
          // stale "resume" is offered. An unproven item KEEPS its checkpoint.
          ...(verified || refuted
            ? {
                proofCheckpoint: '',
                proofCheckpointFilled: 0,
                proofCheckpointTotal: 0,
              }
            : {}),
        });
        setStats((s) => ({
          ...s,
          verified: s.verified + (verified ? 1 : 0),
          // A refuted problem is resolved-as-bad, not a prover failure.
          failed: s.failed + (verified || refuted ? 0 : 1),
        }));
        pushLog(
          verified ? 'info' : refuted ? 'warn' : 'warn',
          `${verified ? 'Proved' : refuted ? `↯ Refuted (false theorem — ${counterexample})` : 'Did not verify'}: ${
            item.questionTitle || item.problem?.slice(0, 60) || item.id
          }`,
        );
        // Research telemetry: one row per attempt into Leak River or Leak
        // Stronghold, whichever strategy actually ran this attempt.
        recordResearchRun({
          item,
          strategy: strategyAtStart,
          model: modelAtStart,
          verified,
          refuted,
          costUsd: actualUsd,
          computeBudgetMs: computeBudgetMsAtStart,
          metrics: outMetrics,
          finalProof: proof,
          error: verified
            ? null
            : refuted
              ? `REFUTED — ${counterexample || 'counterexample verified by Lean'}`
              : 'Lean proof did not verify',
          nlSeedUsed,
          seedUsed,
        });
        // Record the actual cost against this item's estimate. The estimate
        // runs concurrently, so join its promise for the history row id, then
        // PATCH the actual and refresh the scoreboard.
        if (actualUsd != null) {
          setCost(item.id, { actualUsd });
          // Persist the actual onto the generated record so it survives a
          // refresh, not just the session `costs` map. Best-effort.
          patchGenerated(item.id, { actualUsd });
          try {
            const est = await estPromiseRef.current[item.id];
            // After a refresh the in-flight estimate promise is gone; fall back
            // to the costHistoryId persisted on the item / in the costs map.
            const histId =
              est?.costHistoryId ?? costsRef.current[item.id]?.costHistoryId;
            if (histId) {
              await fetch('/api/admin/cost-history', {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  id: histId,
                  actualUsd,
                  verified,
                }),
              });
              loadEstStats();
            }
          } catch {
            /* recording is best-effort; the actual still shows on the card */
          }
        }

        queueRef.current = queueRef.current.filter((x) => x.id !== item.id);
        syncQueue();
      }
    } finally {
      verifyingIdRef.current = null;
      verifyAbortRef.current = null;
      setVerifyingId(null);
      setVerifyStartedAt(null);
      runningRef.current = false;
    }
  }, [proveStream, pushLog, pauseForLimit, recordResearchRun]);

  const terminateVerification = () => verifyAbortRef.current?.abort();

  // "+5 min": push the running verification's wall-clock deadline out. Best-effort
  // — the bridge mutates the live deadline so it rescues even the current stage.
  const extendVerification = useCallback(async () => {
    const runId = runIdRef.current;
    if (!runId || extending) return;
    setExtending(true);
    try {
      const conn = connFor(false); // shared (verification) bridge
      const r = await extendProverRun({
        runId,
        addMs: isArchitectStrategy(verifyStrategyRef.current)
          ? ARCHITECT_EXTEND_MS
          : 5 * 60_000,
        bridgeUrl: conn.bridgeUrl,
        token: conn.token,
      });
      if (r) setComputeLimit(r);
    } finally {
      setExtending(false);
    }
  }, [extending]);

  // "+1 iter": raise the Leak River refinement budget. Always bumps the value the
  // next run starts with, AND — when a River run is in flight — the live budget of
  // that run, since the bridge reads it per iteration. A stale runId just 404s
  // (the bridge drops finished runs), leaving the local bump in place.
  const extendIterations = useCallback(async () => {
    if (extendingIters) return;
    setExtendingIters(true);
    try {
      const next = Math.min(32, verifyMaxItersRef.current + 1);
      verifyMaxItersRef.current = next;
      setVerifyMaxIters(next);
      const runId = runIdRef.current;
      if (!runId) return;
      const conn = connFor(false); // shared (verification) bridge
      const r = await extendProverRun({
        runId,
        addIters: 1, // no addMs — never buy wall-clock time from this button
        bridgeUrl: conn.bridgeUrl,
        token: conn.token,
      });
      // Trust the bridge's number over ours if the run is live (it clamps).
      if (r?.maxIters) {
        verifyMaxItersRef.current = r.maxIters;
        setVerifyMaxIters(r.maxIters);
      }
    } finally {
      setExtendingIters(false);
    }
  }, [extendingIters]);

  const resumeNow = useCallback(() => {
    limitPausedRef.current = false;
    setLimitPause(null);
    // Generation loop resumes on its own (it polls limitPausedRef); kick the
    // verifier back into gear for any still-queued items.
    runVerifier();
  }, [runVerifier]);

  // Auto-resume at the parsed reset time (+30s buffer). If no reset time could
  // be parsed, stays paused until the user resumes manually.
  useEffect(() => {
    if (!limitPause?.resetAt) return;
    const ms = Math.max(0, limitPause.resetAt - Date.now()) + 30000;
    const id = setTimeout(resumeNow, ms);
    return () => clearTimeout(id);
  }, [limitPause, resumeNow]);

  // Load the estimator scoreboard on mount (and it refreshes after each actual).
  useEffect(() => {
    loadEstStats();
  }, [loadEstStats]);

  // Add to the verification queue — persists queued=true so it survives reloads.
  const enqueueVerify = useCallback(
    async (item: GeneratedItem) => {
      if (
        verifyingIdRef.current === item.id ||
        queueRef.current.some((x) => x.id === item.id)
      ) {
        return;
      }
      queueRef.current = [...queueRef.current, { ...item, queued: true }];
      syncQueue();
      // Auto-estimate the cost the moment it enters the queue — every problem
      // piped to the verifier gets a prediction, computed concurrently with the
      // proof (its few-minute budget never touches the prover).
      runEstimate(item);
      await patchGenerated(item.id, { queued: true });
      runVerifier();
    },
    [runVerifier, runEstimate],
  );

  // Resume a run from its saved checkpoint: stash the seed (consumed once by the
  // verify loop) and enqueue. The tree run finishes the remaining holes from the
  // banked skeleton instead of replanning from scratch.
  const resumeVerification = useCallback(
    (item: GeneratedItem) => {
      if (!item.proofCheckpoint) return;
      resumeSeedRef.current[item.id] = item.proofCheckpoint;
      enqueueVerify(item);
    },
    [enqueueVerify],
  );

  const removeFromVerifyQueue = async (id: string) => {
    queueRef.current = queueRef.current.filter((x) => x.id !== id);
    syncQueue();
    await patchGenerated(id, { queued: false });
  };

  // Rebuild the in-memory queue from the DB `queued` flags (on load), preserving
  // FIFO order, and resume verifying.
  const rebuildQueue = useCallback(
    (list: GeneratedItem[]) => {
      queueRef.current = list
        .filter((g) => g.queued)
        .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
      syncQueue();
      if (queueRef.current.length > 0) runVerifier();
    },
    [runVerifier],
  );

  // ---- loaders (hydrate on mount / manual refresh) ----------------------

  const loadQueue = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/problems');
      if (!r.ok) return;
      const j = await r.json();
      setHealth(j.health ?? null);
      setItems(Array.isArray(j.items) ? j.items : []);
      setProdTitles(Array.isArray(j.prodItems) ? j.prodItems : []);
    } catch {
      /* ignore */
    }
  }, []);

  const loadGenerated = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/generated');
      if (!r.ok) return;
      const j = await r.json();
      const list: GeneratedItem[] = Array.isArray(j.items) ? j.items : [];
      setGenerated(list);
      if (typeof j.cap === 'number') setGenCap(j.cap);
      // Rehydrate the per-card cost display from the persisted item fields so the
      // estimate/actual survive a refresh (the `costs` map is session-only).
      const seeded: Record<string, ItemCost> = { ...costsRef.current };
      for (const it of list) {
        if (it.estUsd != null || it.actualUsd != null || it.costHistoryId) {
          const prev = seeded[it.id];
          // MERGE, never null-clobber: a persisted field only overrides when it
          // has a value. Otherwise a record whose estUsd hasn't been written yet
          // (estimate still in flight, or lost to an old race) would wipe the
          // estimate we just computed in memory — the "only actual, no est" bug.
          seeded[it.id] = {
            ...prev,
            estUsd: it.estUsd ?? prev?.estUsd,
            estLow: it.estLow ?? prev?.estLow,
            estHigh: it.estHigh ?? prev?.estHigh,
            estRationale: it.estRationale ?? prev?.estRationale,
            costHistoryId: it.costHistoryId ?? prev?.costHistoryId,
            actualUsd: it.actualUsd ?? prev?.actualUsd,
          };
        }
      }
      costsRef.current = seeded;
      setCosts(seeded);
      rebuildQueue(list);
    } catch {
      /* ignore */
    }
  }, [rebuildQueue]);

  const loadAll = useCallback(() => {
    loadQueue();
    loadGenerated();
  }, [loadQueue, loadGenerated]);

  useEffect(() => {
    loadAll();
    setWorkBridgeUrl(localStorage.getItem('lca.workBridgeUrl') || '');
    const savedMode = localStorage.getItem('lca.genMode') as GenMode | null;
    if (savedMode && savedMode in MODE_LABEL) setMode(savedMode);
    const savedCheck = localStorage.getItem(
      'lca.statementCheck',
    ) as StatementCheck | null;
    if (savedCheck && savedCheck in STATEMENT_CHECK_LABEL)
      setStatementCheck(savedCheck);
    const savedStrategy = localStorage.getItem('lca.verifyStrategy');
    if (savedStrategy) {
      setVerifyStrategy(savedStrategy);
      // Sync the ref immediately too — loadAll() above can reach rebuildQueue →
      // runVerifier before the ref's own effect flushes, and a restored "off"
      // must not lose that race and start proving the restored queue.
      verifyStrategyRef.current = savedStrategy;
    }
    // Pull already-live CompeteMath problems so generation can avoid them.
    fetch('/api/admin/live-problems')
      .then((r) => (r.ok ? r.json() : { problems: [] }))
      .then((j) => {
        const p: LiveProblem[] = Array.isArray(j.problems) ? j.problems : [];
        liveRef.current = p;
        setLiveProblems(p);
      })
      .catch(() => {
        /* live context is best-effort */
      });
  }, [loadAll]);

  const persistMode = (m: GenMode) => {
    setMode(m);
    localStorage.setItem('lca.genMode', m);
  };

  // Persisted, because a verification off-switch that silently reverted to a
  // real strategy on reload would start burning prover runs unannounced.
  const persistVerifyStrategy = (s: string) => {
    setVerifyStrategy(s);
    // Set the ref HERE rather than waiting for its sync effect: that effect
    // runs after the next render, so the runVerifier() call below would still
    // read the OLD strategy and bail out when switching off -> on.
    verifyStrategyRef.current = s;
    localStorage.setItem('lca.verifyStrategy', s);
    // Switching back on picks up anything queued while it was off.
    if (s !== VERIFY_OFF && queueRef.current.length > 0) runVerifier();
  };

  const persistStatementCheck = (c: StatementCheck) => {
    setStatementCheck(c);
    localStorage.setItem('lca.statementCheck', c);
    // Turning the check off clears a stale "not connected" banner.
    if (c === 'off') setCheckError(null);
  };

  const persistWorkBridgeUrl = (value: string) => {
    setWorkBridgeUrl(value);
    if (value.trim()) localStorage.setItem('lca.workBridgeUrl', value.trim());
    else localStorage.removeItem('lca.workBridgeUrl');
  };

  // ---- generation (produces unverified problems, enqueues them) ---------

  // The Sonnet gauntlet: k cold-solve attempts against the problem statement
  // alone. Following VHG (arXiv 2605.06660), the gauntlet is a difficulty
  // METER, not a gate: it measures whether a tool-equipped mid-tier Claude
  // cracks the problem, and the caller TIERS the item accordingly (cracked
  // claimed-Insane → Hard; held integral → Insane). Nothing valid is ever
  // discarded, and there is no repair loop — a fresh generation is the
  // better spend than repairing a cracked design (measured live).
  const runGauntlet = useCallback(
    async (
      gen: GenProblem,
      signal: AbortSignal,
    ): Promise<{ meta: GauntletMeta }> => {
      setGenStage('gauntlet');
      const expected = normalizeIntString(gen.answer) ?? String(gen.answer ?? '');
      pushGenEvent(
        'system',
        `Gauntlet: up to ${GAUNTLET_SAMPLES}× ${GAUNTLET_MODEL}`,
        { input: `expected answer: ${expected}` },
      );
      const runSample = async (i: number) => {
          const empty = { cracked: false, claimedAnswer: null, reason: 'solver run failed' };
          // 1. Solver attempts the problem cold, with a Bash/python tool —
          // every tool call and thought streams into the console live.
          let sData: BridgeRunResult;
          try {
            sData = await runBridgeStream(
              true,
              {
                prompt: gauntletSolverPrompt(gen.problem || ''),
                options: GAUNTLET_RUN_OPTIONS,
              },
              `Solver #${i + 1}`,
              signal,
            );
          } catch (e) {
            pushGenEvent('error', `Solver #${i + 1} — bridge call failed`, {
              detail: String((e as { httpStatus?: number })?.httpStatus ?? e),
            });
            return { transcript: '', verdict: empty };
          }
          recordUsage(
            sData.usage as Parameters<typeof recordUsage>[0],
            (sData.costUsd as number | undefined) ?? null,
          );
          const transcript = String(sData.text || '');
          pushGenEvent('text', `Solver #${i + 1} final (${GAUNTLET_MODEL})`, {
            detail: transcript || '(empty output)',
          });

          // 2. A separate, tool-equipped judge rules on the transcript —
          // running any code it contains rather than trusting it.
          let jData: BridgeRunResult;
          try {
            jData = await runBridgeStream(
              true,
              {
                prompt: gauntletJudgePrompt(gen.problem || '', expected, transcript),
                options: GAUNTLET_JUDGE_RUN_OPTIONS,
              },
              `Judge #${i + 1}`,
              signal,
            );
          } catch (e) {
            pushGenEvent('error', `Judge #${i + 1} — bridge call failed`, {
              detail: String((e as { httpStatus?: number })?.httpStatus ?? e),
            });
            return { transcript, verdict: { ...empty, reason: 'judge run failed' } };
          }
          recordUsage(
            jData.usage as Parameters<typeof recordUsage>[0],
            (jData.costUsd as number | undefined) ?? null,
          );
          const verdict = parseJudgeVerdict(String(jData.text || ''));
          pushGenEvent(
            verdict.cracked ? 'rejected' : 'verified',
            `Judge #${i + 1}: ${verdict.cracked ? 'CRACKED' : 'HELD'}${verdict.claimedAnswer ? ` (claimed ${verdict.claimedAnswer})` : ''}`,
            { detail: verdict.reason || String(jData.text || '') },
          );
          return { transcript, verdict };
        };

        // Sequential with early exit: one CRACKED verdict decides the whole
        // round, so a cracked problem costs one solver+judge, not two. The
        // price is serialized wall-clock on survivors — worth it while the
        // crack rate is high.
        const samples: Awaited<ReturnType<typeof runSample>>[] = [];
        for (let i = 0; i < GAUNTLET_SAMPLES; i++) {
          const s = await runSample(i);
          samples.push(s);
          if (s.verdict.cracked) {
            if (i + 1 < GAUNTLET_SAMPLES)
              pushGenEvent(
                'system',
                `Remaining sample(s) skipped — round already cracked`,
              );
            break;
          }
        }

        const solved = samples.some((s) => s.verdict.cracked);
        // Every HELD sample's judge nonetheless converging on the SAME
        // (wrong) answer is a strong smell the INTENDED answer is wrong —
        // flag for human review, don't auto-pass it silently.
        const heldClaims = samples
          .filter((s) => !s.verdict.cracked)
          .map((s) => s.verdict.claimedAnswer)
          .filter((a): a is string => a != null);
        const suspect =
          !solved &&
          heldClaims.length === GAUNTLET_SAMPLES &&
          heldClaims.every((a) => a === heldClaims[0]) &&
          heldClaims[0] !== expected
            ? heldClaims[0]
            : undefined;
        const meta: GauntletMeta = {
          model: GAUNTLET_MODEL,
          // Actual samples run — fewer than GAUNTLET_SAMPLES when the round
          // early-exited on a crack.
          samples: samples.length,
          verdicts: samples.map((s) => s.verdict),
          solved,
          ...(suspect ? { suspectAnswer: suspect } : {}),
        };
        if (suspect)
          pushGenEvent(
            'text',
            `Suspect: every HELD sample converged on ${suspect}, not the intended ${expected}`,
          );
        pushGenEvent(
          solved ? 'rejected' : 'verified',
          solved
            ? 'Gauntlet cracked — the item ships at a lower tier (VHG: measure difficulty, never discard valid problems)'
            : 'Gauntlet held — full marks',
        );
        return { meta };
    },
    [runBridgeStream, recordUsage, pushGenEvent],
  );

  // Generate ONE problem on the work bridge, save it unverified, and enqueue it
  // for verification. Returns nothing; throws on generation failure.
  const generateOne = useCallback(async () => {
    const bridgeUrl =
      (connFor(true).bridgeUrl as string) || 'http://localhost:4123';
    const ctrl = new AbortController();
    genAbortRef.current = ctrl;
    setGenStartedAt(Date.now());
    setGenStage('generating');
    // Never clears — each attempt appends after a divider so a fast-failing
    // attempt's error survives long enough to actually read, instead of being
    // wiped the instant the next attempt starts.
    pushGenEvent(
      'received',
      `── Generating (${MODE_LABEL[modeRef.current]}) ──`,
    );
    try {
      // Mirage: TS samples a fully-solved instance; the LLM only writes the
      // disguised prose. The exact answer + Lean certificate come from the
      // instance and overwrite whatever the model emits (see below), so the
      // model is never authoritative for the mathematics.
      const mirageInst: MirageInstance | null =
        modeRef.current === 'mirage' ? sampleThresholdMirage() : null;
      const avoid = buildAvoidContext(generatedRef.current, liveRef.current);
      const prompt = mirageInst
        ? mirageSetterPrompt(mirageInst, avoid)
        : buildPrompt(modeRef.current, avoid);
      const genOptions = mirageInst
        ? MIRAGE_RUN_OPTIONS
        : genRunOptionsFor(modeRef.current, genModelRef.current || undefined);
      let genData: BridgeRunResult;
      try {
        genData = await runBridgeStream(
          true,
          { prompt, options: genOptions },
          'Generator',
          ctrl.signal,
        );
      } catch (e) {
        if (ctrl.signal.aborted)
          throw new Error('Generation terminated by you');
        const httpStatus = (e as { httpStatus?: number })?.httpStatus;
        if (httpStatus) {
          const body = (e as { body?: string })?.body || '';
          const detail = `${JSON.stringify(
            { bridge: bridgeUrl, httpStatus, mode: modeRef.current },
            null,
            2,
          )}\n\n----- response body -----\n${body || '(empty)'}`;
          throw Object.assign(
            new Error(`Bridge /run-stream failed (${httpStatus})`),
            { detail },
          );
        }
        // Stream died mid-run (bridge crash) — surface that as-is; a plain
        // fetch failure means the bridge was never reachable at all.
        if (e instanceof Error && /stream ended without a result/.test(e.message))
          throw e;
        throw new Error(
          `Couldn't reach the generation bridge at ${bridgeUrl}. Check a bridge is running there, the URL is a full http:// URL, and you're on Chrome/Edge/Firefox.`,
        );
      }
      recordUsage(
        genData.usage as Parameters<typeof recordUsage>[0],
        genData.costUsd ?? null,
      );
      const raw = String(genData.text || '');
      const gen = extractJson(raw);
      // Mirage: overwrite the mathematics with the exact TS-computed values.
      // The setter only supplied prose (title/problem/insight) — it never
      // produced a Lean statement, so inject the certificate here too, before
      // the lean check below.
      if (mirageInst && gen) {
        const ex = mirageExactFields(mirageInst);
        gen.answer = Number(ex.answer);
        gen.lean = ex.lean;
        gen.difficulty = ex.difficulty;
        gen.points = ex.points;
        pushGenEvent(
          'text',
          `Mirage exact answer ${ex.answer} injected (break index B=${mirageInst.breakIndex})`,
        );
      }
      if (!gen?.lean) {
        // Rich diagnostic: the bridge's own metadata explains an empty/failed run
        // (timeout, non-zero exit, claude stderr like a rate limit) — the actual
        // cause, not just the symptom. Plus the full raw output for parse issues.
        const stderr = String(genData.stderr || '').trim();
        // Session/usage limit → surface a limit marker so the loop pauses.
        const lim = detectSessionLimit(`${raw}\n${stderr}`);
        if (lim.hit) {
          throw Object.assign(
            new Error(
              `Session limit reached${lim.resetText ? ` — ${lim.resetText}` : ''}`,
            ),
            { limit: lim, detail: raw || stderr },
          );
        }
        // A claude API error is returned as the "result" text, not JSON — report
        // it verbatim rather than mislabeling it a parse failure.
        const apiErr = raw.match(/API Error:[^\n]*/i);
        const reason = apiErr
          ? apiErr[0].slice(0, 180)
          : raw
            ? 'could not parse a problem from the output'
            : genData.timedOut
              ? `generation timed out after ${genData.durationMs ?? '?'}ms`
              : genData.ok === false
                ? `claude exited ${genData.exitCode ?? '?'}${stderr ? `: ${stderr.split('\n')[0].slice(0, 120)}` : ' (no stderr)'}`
                : 'empty output (claude returned no text)';
        const meta = {
          mode: modeRef.current,
          bridge: bridgeUrl,
          ok: genData.ok,
          exitCode: genData.exitCode,
          timedOut: genData.timedOut,
          durationMs: genData.durationMs,
          textLength: raw.length,
          promptChars: prompt.length,
        };
        const detail = `${JSON.stringify(meta, null, 2)}${
          stderr ? `\n\n----- stderr -----\n${stderr}` : ''
        }\n\n----- raw output (${raw.length} chars) -----\n${raw || '(empty)'}`;
        throw Object.assign(new Error(`Discarded — ${reason}`), { detail });
      }
      setStats((s) => ({ ...s, generated: s.generated + 1 }));
      pushGenEvent('text', `Generated: ${gen.questionTitle ?? 'untitled'}`, {
        detail: raw,
      });

      // Trapdoor problems are Insane by contract, whatever the model emitted.
      if (modeRef.current === 'trapdoor') {
        gen.difficulty = 'Insane';
        gen.points = 200;
      }

      // VHG local pre-filter (format/answer/degeneracy) — pure code, free,
      // BEFORE any expensive verification or solving.
      const preReason = prefilterProblem(gen);
      if (preReason) {
        throw Object.assign(new Error(`Discarded — pre-filter: ${preReason}`), {
          detail: JSON.stringify(gen, null, 2),
        });
      }

      // STATEMENT PRE-CHECK, then REPAIR — never discard the mathematics.
      //
      // A failed elaboration condemns the Lean RENDERING, not the problem. The
      // statement, answer, insight and hidden chain are all still good and are
      // the expensive part; the theorem is a cheap re-derivable view of them.
      // So a compile failure feeds the exact compiler errors back and asks for
      // a corrected statement for the SAME problem, up to
      // MAX_REFORMALIZE_ATTEMPTS times. Binning a sound problem over a
      // typeclass slip would also contradict the doctrine this pipeline already
      // took from VHG: nothing valid is ever discarded.
      //
      // Running it before the paid stages still matters — a statement that
      // never typechecks is unprovable (the prover's target signature is
      // immutable, so refinement cannot repair the theorem's own opening line)
      // and would forfeit a whole prover run.
      const checkRemote = statementCheckRef.current !== 'off';
      const leanFailures: { lean: string; errors: string }[] = [];
      let leanOk = false;
      for (let attempt = 0; ; attempt++) {
        // Free, local, and the same repair fixes it, so it shares the loop.
        const structural = leanSplitsIntoSeparateDecl(gen.lean)
          ? 'The submission was split into a separate top-level declaration plus the theorem. It must be ONE self-contained theorem: fold the helper into the signature as a bound variable plus hypotheses giving its defining equations.'
          : '';
        let errText = structural;
        if (!structural) {
          if (!checkRemote) {
            leanOk = true;
            break;
          }
          setGenStage('elaborating');
          let verdict: Awaited<ReturnType<typeof checkStatementElaborates>>;
          try {
            // Through the Work bridge — the same one that just generated this,
            // so the check needs nothing running that generation didn't.
            verdict = await checkStatementElaborates(gen.lean, (path, init) =>
              callBridge(true, path, init),
            );
          } catch (e) {
            if (e instanceof ElaborationUnavailableError) {
              // Infrastructure, not a verdict — surface it and stop WITHOUT
              // touching the problem. Re-formalizing here would rewrite a
              // statement that was never actually found wanting.
              setCheckError(e.message);
              pushGenEvent('error', 'Statement check unavailable', {
                detail: e.message,
              });
              throw new Error(`Statement check unavailable — ${e.message}`);
            }
            throw e;
          }
          setCheckError(null);
          pushGenEvent(
            verdict.elaborates ? 'verified' : 'rejected',
            `Statement check (${verdict.serverUrl ? new URL(verdict.serverUrl).host : 'Leak'}): ${
              verdict.elaborates ? 'elaborates' : `${verdict.errors.length} error(s)`
            }`,
            { detail: verdict.raw },
          );
          if (verdict.elaborates) {
            leanOk = true;
            break;
          }
          errText = verdict.errors.join('\n') || verdict.raw;
        }
        leanFailures.push({ lean: gen.lean, errors: errText });
        if (attempt >= MAX_REFORMALIZE_ATTEMPTS - 1) break;

        setGenStage('reformalizing');
        pushGenEvent(
          'text',
          `Re-formalizing (${attempt + 1}/${MAX_REFORMALIZE_ATTEMPTS - 1}) — keeping the problem, rewriting only the Lean`,
          { detail: errText },
        );
        let rf: BridgeRunResult;
        try {
          rf = await runBridgeStream(
            true,
            {
              prompt: reformalizePrompt(
                gen.problem || '',
                gen.answer ?? '',
                leanFailures,
              ),
              options: REFORMALIZER_RUN_OPTIONS,
            },
            'Re-formalizer',
            ctrl.signal,
          );
        } catch (e) {
          if (ctrl.signal.aborted) throw new Error('Generation terminated by you');
          pushGenEvent('error', 'Re-formalizer bridge call failed', {
            detail: String(e),
          });
          break;
        }
        recordUsage(
          rf.usage as Parameters<typeof recordUsage>[0],
          (rf.costUsd as number | undefined) ?? null,
        );
        const fixed = parseReformalized(String(rf.text || ''));
        if (!fixed) {
          pushGenEvent('error', 'Re-formalizer returned no usable statement', {
            detail: String(rf.text || ''),
          });
          break;
        }
        gen.lean = fixed.lean;
        pushGenEvent('text', `New statement — ${fixed.fix || '(no note)'}`, {
          detail: fixed.lean,
        });
      }
      // Still broken after every repair attempt. The MATHEMATICS is untouched
      // and worth keeping, so the problem is saved anyway — just held out of
      // the prover queue, with the compiler output recorded so the Lean can be
      // fixed by hand (the admin PATCH accepts `lean`). Discarding here is what
      // this loop exists to prevent.
      const leanNeedsHand = !leanOk;
      if (leanNeedsHand) {
        pushGenEvent(
          'rejected',
          `Lean still not elaborating after ${leanFailures.length} attempt(s) — saving the problem unqueued for a manual fix`,
          { detail: leanFailures.at(-1)?.errors ?? '' },
        );
      }

      // Integral mode: HARD verification (VHG Appendix E.3) before anything
      // else — an independent run whose verdict comes from executed sympy
      // (derivative match, exact value, numeric cross-check, answer
      // extraction). Invalid pairs are discarded; validity is never assumed
      // from the setter's own transcript.
      if (modeRef.current === 'integral') {
        setGenStage('validating');
        const cert: IntegralCertificate = {
          integrand: gen.integrand,
          antiderivative: gen.antiderivative,
          lowerBound: gen.lowerBound,
          upperBound: gen.upperBound,
          exactValue: gen.exactValue,
        };
        let vData: BridgeRunResult;
        try {
          vData = await runBridgeStream(
            true,
            {
              prompt: integralVerifierPrompt(cert, gen.answer, gen.problem || ''),
              options: INTEGRAL_VERIFIER_RUN_OPTIONS,
            },
            'Hard verifier',
            ctrl.signal,
          );
        } catch (e) {
          if (ctrl.signal.aborted) throw new Error('Generation terminated by you');
          throw new Error(
            `Integral verifier bridge call failed (${(e as { httpStatus?: number })?.httpStatus ?? e})`,
          );
        }
        recordUsage(
          vData.usage as Parameters<typeof recordUsage>[0],
          (vData.costUsd as number | undefined) ?? null,
        );
        const verdict = parseIntegralVerdict(String(vData.text || ''));
        pushGenEvent(
          verdict.valid ? 'verified' : 'rejected',
          `Hard verifier: ${verdict.valid ? 'VALID' : 'INVALID'}${verdict.checkedAnswer ? ` (checked answer ${verdict.checkedAnswer})` : ''}`,
          { detail: verdict.reason || String(vData.text || '') },
        );
        if (!verdict.valid) {
          throw Object.assign(
            new Error(`Discarded — integral failed hard verification: ${verdict.reason}`),
            { detail: String(vData.text || '') },
          );
        }
      }

      // The gauntlet as difficulty METER (VHG): runs for every claimed-Insane
      // problem and every integral. The verdict tiers the item; nothing valid
      // is discarded and nothing is repaired.
      let gauntlet: GauntletMeta | undefined;
      const claimedInsane = (gen.difficulty || '').toLowerCase() === 'insane';
      if (claimedInsane || modeRef.current === 'integral') {
        const { meta } = await runGauntlet(gen, ctrl.signal);
        gauntlet = meta;
        if (claimedInsane && meta.solved) {
          // Cracked "Insane" is a mislabelled Hard — tier down and ship.
          gen.difficulty = 'Hard';
          gen.points = 150;
          setStats((s) => ({ ...s, downgraded: s.downgraded + 1 }));
          pushGenEvent('text', 'Tiered down to Hard (cracked by the gauntlet)');
        } else if (modeRef.current === 'integral' && !meta.solved) {
          // An integral even a tool-equipped solver failed — that is Insane.
          gen.difficulty = 'Insane';
          gen.points = 200;
          pushGenEvent('text', 'Promoted to Insane (held against the gauntlet)');
        }
      }

      // Post-hoc level assessment: the generator ran unconstrained, so the
      // knowledge tier is judged after the fact. Best-effort — on any failure
      // the generator's own estimate stands.
      setGenStage('assessing');
      try {
        const d = await runBridgeStream(
          true,
          {
            prompt: levelAssessorPrompt(gen.problem || '', gen.insight),
            options: ASSESSOR_RUN_OPTIONS,
          },
          'Assessor',
          ctrl.signal,
        );
        recordUsage(
          d.usage as Parameters<typeof recordUsage>[0],
          (d.costUsd as number | undefined) ?? null,
        );
        const assessed = parseAssessedLevel(String(d.text || ''));
        if (assessed) gen.level = assessed;
        pushGenEvent('text', `Level assessed: ${assessed ?? '(kept generator estimate)'}`, {
          detail: String(d.text || ''),
        });
      } catch {
        /* keep the generator's own level */
      }

      setGenStage('saving');
      // Strategy "off": save the problem but leave it OUT of the verification
      // queue entirely. Queueing it would silently bank work that starts
      // proving the moment a real strategy is picked — the opposite of "just
      // generate". It stays in the generated history and can be queued by hand
      // later with "Verify again".
      // A statement that never elaborated is also held back — proving it is
      // impossible, so queueing it would only burn a forfeited run.
      const verifyOff = verifyStrategyRef.current === VERIFY_OFF || leanNeedsHand;
      const res = await fetch('/api/admin/generated', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...gen,
          verified: false,
          proof: '',
          error: leanNeedsHand
            ? `Lean statement does not elaborate after ${leanFailures.length} re-formalization attempt(s) — the problem is kept; edit the Lean and re-queue. Last compiler output:\n${leanFailures.at(-1)?.errors ?? ''}`
            : null,
          queued: !verifyOff,
          toolchain: TOOLCHAIN,
          genMode: modeRef.current,
          ...(gauntlet ? { gauntlet } : {}),
        }),
      });
      if (res.ok) {
        const j = await res.json();
        if (j.item) {
          setGenerated((g) => [j.item, ...g.filter((x) => x.id !== j.item.id)]);
          if (verifyOff) {
            pushGenEvent(
              'done',
              leanNeedsHand
                ? 'Saved — problem kept, Lean needs a manual fix (not queued)'
                : 'Saved — verification off, not queued',
              { verified: !gauntlet || !gauntlet.solved },
            );
          } else {
            // Already persisted queued=true; just add to the in-memory queue.
            if (!queueRef.current.some((x) => x.id === j.item.id)) {
              queueRef.current = [...queueRef.current, j.item];
              syncQueue();
            }
            pushGenEvent('done', `Saved — queued for verification`, {
              verified: !gauntlet || !gauntlet.solved,
            });
            runVerifier();
          }
        }
      }
    } finally {
      genAbortRef.current = null;
      setGenStartedAt(null);
      setGenStage('idle');
    }
  }, [
    runBridgeStream,
    callBridge,
    runVerifier,
    recordUsage,
    runGauntlet,
    pushLog,
    pushGenEvent,
  ]);

  const terminateGeneration = () => genAbortRef.current?.abort();

  // Manual: add one fresh unproven generation to the verify queue.
  const addUnprovenGeneration = useCallback(async () => {
    setGeneratingOne(true);
    try {
      await generateOne();
    } catch (e) {
      const err = e as Error & { detail?: string };
      setStats((s) => ({ ...s, errors: s.errors + 1 }));
      pushLog('error', err.message, err.detail);
      pushGenEvent('error', err.message, { detail: err.detail });
    } finally {
      setGeneratingOne(false);
    }
  }, [generateOne, pushLog, pushGenEvent]);

  // The Work loop: keep generating (each generation enqueues itself).
  useEffect(() => {
    workRef.current = work;
    if (!work) {
      setGenStage('idle');
      return;
    }
    let cancelled = false;
    (async () => {
      while (!cancelled && workRef.current) {
        // Hold while paused for a usage limit (auto-resumes when the limit clears).
        if (limitPausedRef.current) {
          await new Promise((res) => setTimeout(res, 4000));
          continue;
        }
        try {
          await generateOne();
        } catch (e) {
          const err = e as Error & {
            detail?: string;
            limit?: { message: string; resetText?: string; resetAt?: number };
          };
          if (err.limit) {
            pauseForLimit(err.limit);
          } else {
            setStats((s) => ({ ...s, errors: s.errors + 1 }));
            pushLog('error', err.message, err.detail);
            pushGenEvent('error', err.message, { detail: err.detail });
          }
          await new Promise((res) => setTimeout(res, 3000));
        }
      }
      if (!cancelled) setGenStage('idle');
    })();
    return () => {
      cancelled = true;
    };
  }, [work, generateOne, pushLog, pauseForLimit, pushGenEvent]);

  // ---- per-item actions -------------------------------------------------

  // "Verify again" simply (re)enqueues the problem — the verifier handles it.
  const verifyAgain = (item: GeneratedItem) => {
    if (item.lean) enqueueVerify(item);
  };

  const addToStaging = useCallback(async (item: GeneratedItem | StagedItem) => {
    if (!item.lean) return;
    // A cracked Insane problem is a mislabelled Hard — it never ships as-is.
    const gauntlet = (item as GeneratedItem).gauntlet;
    if ((item.difficulty || '').toLowerCase() === 'insane' && gauntlet?.solved) {
      pushLog(
        'warn',
        `Blocked staging "${item.questionTitle ?? 'untitled'}" — the gauntlet cracked it; regenerate instead.`,
      );
      return;
    }
    setBusy(`stage:${item.id}`);
    try {
      const res = await fetch('/api/admin/problems', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          questionTitle: item.questionTitle ?? null,
          subtitle: item.subtitle ?? null,
          problem: item.problem ?? null,
          answer: item.answer ?? null,
          difficulty: item.difficulty ?? null,
          points: item.points ?? null,
          level: item.level ?? null,
          insight: item.insight ?? null,
          lean: item.lean,
          proof: item.proof ?? '',
          // Whatever certified this item, recorded at verify time. The fallback
          // only applies to rows proved before toolchain was carried per run.
          toolchain: item.toolchain ?? TOOLCHAIN,
          mathlib: item.mathlib ?? MATHLIB_VERSION,
          enforcer: item.enforcer ?? null,
          verifiedAt: item.verifiedAt ?? null,
          signature: item.signature ?? null,
          signatureKeyId: item.signatureKeyId ?? null,
          certMintedAt: item.certMintedAt ?? null,
          // Every distinct-toolchain certificate accumulated pre-publish, so
          // promote can ship all of them the first time this problem goes live.
          certs: certsOrFallback(item),
        }),
      });
      if (res.ok) {
        const j = await res.json();
        if (j.staged)
          setItems((it) => [
            j.staged,
            ...it.filter((x) => x.id !== j.staged.id),
          ]);
      } else if (res.status === 409) {
        // Server refused a duplicate — surface it and refresh so the chip shows.
        const j = await res.json().catch(() => null);
        pushLog('warn', j?.error || 'Already in staging — not added again.');
        loadQueue();
      }
    } finally {
      setBusy(null);
    }
  }, [pushLog, loadQueue]);

  const removeGenerated = useCallback(async (id: string) => {
    setBusy(`del:${id}`);
    try {
      const res = await fetch(
        `/api/admin/generated?id=${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      if (res.ok) {
        setGenerated((g) => g.filter((x) => x.id !== id));
        // The record is gone; just drop it from the in-memory queue.
        queueRef.current = queueRef.current.filter((x) => x.id !== id);
        syncQueue();
      }
    } finally {
      setBusy(null);
    }
  }, []);

  const dropStaged = (id: string) => {
    setItems((it) => it.filter((x) => x.id !== id));
  };

  const removeItem = useCallback(async (id: string) => {
    setBusy(`del:${id}`);
    try {
      const res = await fetch(
        `/api/admin/problems?id=${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      if (res.ok) dropStaged(id);
    } finally {
      setBusy(null);
    }
  }, []);

  const promoteItem = useCallback(async (id: string) => {
    setBusy(`promote:${id}`);
    try {
      const r = await fetch('/api/admin/problems/promote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      // Duplicate refusal is not a prod outage — just report it and refresh so
      // the "In prod" state shows; don't mark prod unhealthy.
      if (r.status === 409) {
        pushLog('warn', (await r.text()) || 'Already in prod — not pushed.');
        loadQueue();
        return;
      }
      if (!r.ok) throw new Error((await r.text()) || `failed (${r.status})`);
      dropStaged(id);
    } catch (e) {
      setHealth((h) =>
        h
          ? { ...h, prod: { ok: false, error: String((e as Error).message) } }
          : h,
      );
    } finally {
      setBusy(null);
    }
  }, [pushLog, loadQueue]);

  // ---- derived ----------------------------------------------------------

  const statusOf = (g: GeneratedItem) => {
    if (verifyingId === g.id) return 'verifying';
    if (verifyQueue.some((x) => x.id === g.id)) return 'queued';
    if (g.verified) return 'proved';
    if (g.error?.startsWith('↯ REFUTED')) return 'refuted';
    if (g.error) return 'failed';
    return 'unverified';
  };

  const badgeClass: Record<string, string> = {
    verifying: 'bg-amber-500/15 text-amber-600 animate-pulse',
    queued: 'bg-blue-500/15 text-blue-600',
    proved: 'bg-emerald-500/15 text-emerald-600',
    // Refuted = the theorem is provably false (a bad problem, distinct from a
    // hard one the prover merely couldn't close).
    refuted: 'bg-fuchsia-500/15 text-fuchsia-600',
    failed: 'bg-red-500/15 text-red-500',
    unverified: 'bg-muted text-muted-foreground',
  };

  const filtered = generated.filter(
    (g) =>
      genFilter === 'all' ||
      (genFilter === 'verified' ? g.verified : !g.verified),
  );

  // Publication-state highlighting. A problem is identified across the three
  // stores by its (normalized) title — the only field the prod payload shares
  // with staging + the live CompeteMath set (the Lean statement isn't promoted).
  const liveTitleSet = new Set(liveProblems.map((p) => normTitle(p.title)));
  const stagingTitleSet = new Set(items.map((s) => normTitle(s.questionTitle)));
  const prodTitleSet = new Set(prodTitles.map(normTitle));
  const placementOf = (g: GeneratedItem) => {
    const t = normTitle(g.questionTitle);
    if (!t) return { live: false, staging: false, prod: false };
    return {
      live: liveTitleSet.has(t),
      staging: stagingTitleSet.has(t),
      prod: prodTitleSet.has(t),
    };
  };

  // Problems waiting for proof: the verification queue minus the one currently
  // being worked on (verifyQueue holds the in-flight item at its front until it
  // finishes). This is what the "Queued" stat means next to Generated/Verified/
  // Failed — NOT the staging-Redis length.
  const queuedForVerify = verifyQueue.filter((x) => x.id !== verifyingId).length;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Content pipeline</h1>
          <p className="text-sm text-muted-foreground">
            Generate → queue for proof → review → publish.
          </p>
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link href="/">← Back to chat</Link>
        </Button>
      </div>

      {/* Usage-limit pause banner */}
      {limitPause && (
        <div className="mb-4 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium text-amber-700">
                ⏸ Paused — Claude usage limit reached
              </p>
              <p className="mt-0.5 text-xs text-amber-700/90">
                {limitPause.message}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {limitPause.resetAt
                  ? `Auto-resumes at ${new Date(limitPause.resetAt).toLocaleTimeString()} (in ${fmtCountdown(limitPause.resetAt - Date.now())}).`
                  : 'No reset time detected — resume manually when your limit refreshes.'}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-8 shrink-0"
              onClick={resumeNow}
            >
              Resume now
            </Button>
          </div>
        </div>
      )}

      {/* Work / generation control */}
      <div className="rounded-lg border p-4">
        <div className="flex items-center justify-between">
          <div>
            <Label htmlFor="admin-work" className="text-base">
              Work
            </Label>
            <p className="text-xs text-muted-foreground">
              While on: continuously generate problems and add them to the
              verification queue below.
            </p>
          </div>
          <Switch id="admin-work" checked={work} onCheckedChange={setWork} />
        </div>

        <div className="mt-3">
          <Label className="text-xs">Difficulty mode</Label>
          <div className="mt-1 flex flex-wrap gap-1 text-xs">
            {(
              [
                'easy',
                'medium',
                'hard',
                'insane',
                'reverse',
                'trapdoor',
                'integral',
                'mirage',
              ] as GenMode[]
            ).map(
              (m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => persistMode(m)}
                  className={cn(
                    'rounded border px-2 py-1',
                    mode === m
                      ? 'border-foreground bg-foreground text-background'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {MODE_LABEL[m]}
                </button>
              ),
            )}
          </div>
          <div className="mt-3">
            <Label className="text-xs">Statement check</Label>
            <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
              {(['leak', 'off'] as StatementCheck[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => persistStatementCheck(c)}
                  className={cn(
                    'rounded border px-2 py-1',
                    statementCheck === c
                      ? 'border-foreground bg-foreground text-background'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {STATEMENT_CHECK_LABEL[c]}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {statementCheck === 'leak'
                ? 'Compiles each generated Lean statement on your Lean daemon — through the bridge, so nothing extra needs to be running — before anything is spent on it. A statement that does not elaborate is unprovable (the prover cannot edit its own target signature), so it is discarded here instead of forfeiting a full prover run.'
                : 'No statement check. Problems are generated and queued without compiling their Lean, so a statement that does not elaborate will only surface once the prover forfeits on it.'}
            </p>
          </div>
          {checkError && (
            <div className="mt-2 rounded border border-destructive/50 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
              <div className="flex items-start justify-between gap-2">
                <span>
                  <strong>Statement check unavailable.</strong> {checkError}
                </span>
                <button
                  type="button"
                  onClick={() => setCheckError(null)}
                  className="shrink-0 underline opacity-70 hover:opacity-100"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
          <label className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
            Generation model
            <select
              value={genModel}
              onChange={(e) => setGenModel(e.target.value)}
              className="rounded-md border bg-background px-1.5 py-1 text-xs"
              title="Which model generates problems (independent of the verification model). Default = the bridge/CLI default."
            >
              {PROVER_MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {mode === 'easy' &&
              'A quick warm-up: one elementary observation solves it. Lean proof usually machine-checkable (decide). Emits difficulty Easy.'}
            {mode === 'medium' &&
              'Needs one genuine, non-obvious insight. Small-domain decide or a modest closed form. Emits difficulty Medium.'}
            {mode === 'hard' &&
              'No brute-force / small-search solution; Lean theorem is general (not decide) — harder to auto-prove, but the workflow still tries. Emits difficulty Hard.'}
            {mode === 'insane' &&
              'Chains multiple distinct insights (or one very deep idea); general (non-decide) Lean statement. Hardest to prove automatically. Emits difficulty Insane.'}
            {mode === 'reverse' &&
              'Easy to VERIFY (a one-step Lean certificate), hard to SOLVE even by computer — built backward from a secret (factoring / discrete-log / subset-witness style). Answer correct by construction; scaled so brute force fails but insight wins.'}
            {mode === 'trapdoor' &&
              'Code samples a random chain of hidden transformations (the trapdoor key); the model instantiates it forward — trivial to construct, but solving requires re-discovering every layer. Claims Insane; the gauntlet tiers it. Generates with Opus 4.8 unless you pick a model.'}
            {mode === 'integral' &&
              'VHG-style (arXiv 2605.06660): the antiderivative is chosen FIRST, differentiated, and disguised — the answer is correct by construction, and an independent hard verifier re-checks everything with executed sympy before the item can queue. Ships at Hard; promoted to Insane if the gauntlet fails to crack it.'}
            {mode === 'mirage' &&
              'Anti-inductive: TS plants a threshold-mirage instance where computing the accessible cases and extrapolating gives the WRONG answer (the break sits below numerical-detection noise) — the solver’s own tool misleads it. Code does the exact math in milliseconds; the model only writes the disguise. Answer + certificate are TS-authoritative, never the model’s.'}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            The gauntlet (up to {GAUNTLET_SAMPLES}× cold solves by{' '}
            {GAUNTLET_MODEL}) is a difficulty METER, not a gate: cracked
            Insane → ships at Hard; an integral that holds → promoted to
            Insane. Nothing valid is discarded. Level is assessed after
            generation, unconstrained.
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            De-duplicating against {generated.length} generated +{' '}
            {liveProblems.length} live CompeteMath problems.
          </p>
        </div>

        <div className="mt-3">
          <Label htmlFor="admin-work-bridge" className="text-xs">
            Generation bridge URL (optional)
          </Label>
          <Input
            id="admin-work-bridge"
            value={workBridgeUrl}
            placeholder="defaults to your shared bridge"
            className="mt-1 h-8 max-w-sm text-xs"
            onChange={(e) => persistWorkBridgeUrl(e.target.value)}
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Generation runs here (e.g. http://localhost:4124); verification runs
            on your shared bridge, so the two can work in parallel.
          </p>
        </div>

        <div className="mt-4 grid grid-cols-5 gap-2 text-center">
          <Stat label="Generated" value={stats.generated} />
          <Stat
            label="Verified"
            value={stats.verified}
            tone="text-emerald-600"
          />
          <Stat label="Failed" value={stats.failed} />
          <Stat label="Queued" value={queuedForVerify} />
          <Stat
            label="Downgraded"
            value={stats.downgraded}
            tone="text-amber-600"
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium">Generation:</span>
          {genStartedAt != null ? (
            <span className="flex items-center gap-1.5 text-amber-600">
              <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
              {genStage} ({MODE_LABEL[mode]}) · {fmtElapsed(genStartedAt)}
              <button
                type="button"
                onClick={terminateGeneration}
                className="ml-1 rounded border border-red-500/40 px-1.5 py-0.5 text-red-500 hover:bg-red-500/10"
              >
                Terminate
              </button>
            </span>
          ) : (
            <span className="capitalize text-muted-foreground">{genStage}</span>
          )}
          {stats.errors > 0 && (
            <span className="text-red-500">· {stats.errors} errors</span>
          )}
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-7 px-2 text-xs"
            disabled={generatingOne || genStartedAt != null}
            onClick={addUnprovenGeneration}
          >
            {generatingOne ? 'Generating…' : '+ Generate one → queue'}
          </Button>
        </div>

        {genEvents.length > 0 && (
          <>
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={() => setGenEvents([])}
                className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
              >
                Clear generation log
              </button>
            </div>
            <ProverConsole
              events={genEvents}
              running={genStartedAt != null}
              title="Generation activity"
              emptyHint="No activity yet — generate a problem."
            />
          </>
        )}

        {/* Usage / metadata */}
        <div className="mt-3 grid grid-cols-3 gap-2 rounded-md border p-2 text-center text-[11px]">
          <div>
            <div className="font-semibold">{usage.calls}</div>
            <div className="text-muted-foreground">claude calls</div>
          </div>
          <div>
            <div className="font-semibold">{fmtTokens(usage.tokens)}</div>
            <div className="text-muted-foreground">total tokens</div>
          </div>
          <div>
            <div className="font-semibold">${usage.costUsd.toFixed(3)}</div>
            <div className="text-muted-foreground">session cost</div>
          </div>
        </div>
        {usage.lastTokens > 0 && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Last generation: {fmtTokens(usage.lastTokens)} tokens ($
            {usage.lastCostUsd.toFixed(3)}) —{' '}
            {((usage.lastTokens / CONTEXT_WINDOW) * 100).toFixed(1)}% of the{' '}
            {fmtTokens(CONTEXT_WINDOW)} context window.
          </p>
        )}

        {/* Cost estimator scoreboard — how close estimates have tracked actuals.
            The "test the estimator" surface: it should improve as more proofs
            land (MAPE ↓). Bias > 0 means we over-estimate on average. */}
        <div className="mt-3 rounded-md border p-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Cost estimator
            </span>
            <span className="text-[10px] text-muted-foreground">
              {estStats?.n ? `${estStats.n} scored` : 'no scored proofs yet'}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
            <div>
              <div className="font-semibold">{fmtPct(estStats?.mape)}</div>
              <div className="text-muted-foreground">MAPE</div>
            </div>
            <div>
              <div className="font-semibold">
                {estStats?.biasRel == null
                  ? '—'
                  : `${estStats.biasRel > 0 ? '+' : ''}${fmtPct(estStats.biasRel)}`}
              </div>
              <div className="text-muted-foreground">bias</div>
            </div>
            <div>
              <div className="font-semibold">{fmtUsd(estStats?.biasAbs)}</div>
              <div className="text-muted-foreground">avg $ error</div>
            </div>
          </div>
          {estStats?.byDifficulty && estStats.byDifficulty.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
              {estStats.byDifficulty.map((d) => (
                <span key={d.difficulty}>
                  {d.difficulty}: {fmtPct(d.mape)}{' '}
                  <span className="opacity-60">(n={d.n})</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Activity / error log */}
      <div className="mt-8">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            Log{' '}
            <span className="text-sm font-normal text-muted-foreground">
              ({log.length})
            </span>
          </h2>
          {log.length > 0 && (
            <div className="flex items-center gap-3 text-xs">
              <button
                type="button"
                onClick={() =>
                  copy('all', log.map(formatLogEntry).join('\n\n'))
                }
                className="text-muted-foreground underline-offset-2 hover:underline"
              >
                {copied === 'all' ? 'Copied ✓' : 'Copy all'}
              </button>
              <button
                type="button"
                onClick={() => setLog([])}
                className="text-muted-foreground underline-offset-2 hover:underline"
              >
                Clear
              </button>
            </div>
          )}
        </div>
        <p className="mb-2 text-[11px] text-muted-foreground">
          Something break? Hit “Copy all” (or a row’s “copy”) and paste it to
          Claude — each entry includes the full raw output, so the exact failure
          can be diagnosed.
        </p>
        <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2">
          {log.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Errors, discarded generations, and verification results appear
              here.
            </p>
          )}
          {log.map((e) => (
            <div key={e.id} className="text-xs">
              <div className="flex items-start gap-2">
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {new Date(e.ts).toLocaleTimeString()}
                </span>
                <span
                  className={cn(
                    'break-words',
                    e.level === 'error'
                      ? 'text-red-500'
                      : e.level === 'warn'
                        ? 'text-amber-600'
                        : 'text-muted-foreground',
                  )}
                >
                  {e.message}
                </span>
                <div className="ml-auto flex shrink-0 gap-2 text-[10px] text-muted-foreground">
                  <button
                    type="button"
                    className="underline-offset-2 hover:underline"
                    onClick={() => copy(String(e.id), formatLogEntry(e))}
                  >
                    {copied === String(e.id) ? 'copied ✓' : 'copy'}
                  </button>
                  {e.detail && (
                    <button
                      type="button"
                      className="underline-offset-2 hover:underline"
                      onClick={() =>
                        setLogOpen((s) => {
                          const n = new Set(s);
                          if (n.has(e.id)) n.delete(e.id);
                          else n.add(e.id);
                          return n;
                        })
                      }
                    >
                      {logOpen.has(e.id) ? 'hide raw' : 'view raw'}
                    </button>
                  )}
                </div>
              </div>
              {e.detail && logOpen.has(e.id) && (
                <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[10px]">
                  {e.detail}
                </pre>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Verification queue */}
      <div className="mt-8">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            Verification queue{' '}
            <span className="text-sm font-normal text-muted-foreground">
              ({verifyQueue.length})
            </span>
          </h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setVerifyDecompose((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors ${
                verifyDecompose
                  ? 'border-violet-500/50 bg-violet-500/10 text-violet-600 dark:text-violet-400'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
              title="Verify generated problems via the prove-or-split decomposition tree instead of a single agent run"
            >
              {/* branch glyph as text to avoid adding an icon dependency */}
              <span aria-hidden>⑂</span>
              Decompose {verifyDecompose ? 'on' : 'off'}
            </button>
            <label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              Model
              <select
                value={isRiverStrategy(verifyStrategy) ? ARCHITECT_MODEL : verifyModel}
                onChange={(e) => setVerifyModel(e.target.value)}
                disabled={isRiverStrategy(verifyStrategy)}
                className="rounded-md border bg-background px-1.5 py-1 text-xs disabled:opacity-60"
                title={
                  isRiverStrategy(verifyStrategy)
                    ? 'Leak River strategies always drive Grok directly — model is locked.'
                    : isUltraStrategy(verifyStrategy)
                      ? 'Leak Ultra inherits this model as its blueprint-pipeline driver (passed to claude --model).'
                      : 'Which model the prover runs on (passed to claude --model), independent of the generation model. Default uses the bridge/CLI default.'
                }
              >
                {isRiverStrategy(verifyStrategy) ? (
                  <option value={ARCHITECT_MODEL}>
                    Grok 4.1 Fast Reasoning (forced)
                  </option>
                ) : (
                  PROVER_MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))
                )}
              </select>
            </label>
            {/* Always rendered — unlike the proving strategies, "Off" has to be
                reachable with Decompose off too. The other options are inert
                without Decompose (strategy is only sent on tree runs), which
                the title spells out. */}
            <label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                Strategy
                <select
                  value={verifyStrategy}
                  onChange={(e) => persistVerifyStrategy(e.target.value)}
                  className={cn(
                    'rounded-md border bg-background px-1.5 py-1 text-xs',
                    verifyStrategy === VERIFY_OFF &&
                      'border-amber-500/60 text-amber-600 dark:text-amber-400',
                  )}
                  title={
                    verifyStrategy === VERIFY_OFF
                      ? 'Verification is OFF — problems are generated and saved, but no prover ever runs.'
                      : verifyDecompose
                        ? 'A/B-test proof strategies; runs are tagged acg-tree:<strategy> in the agent debug log'
                        : 'Turn Decompose on to use a proving strategy — with it off, a single agent run is used and this setting is ignored (except "Off", which always applies).'
                  }
                >
                  <option value={VERIFY_OFF}>Off — generate only, never prove</option>
                  <option value="hacker">Hacker (compiler-driven)</option>
                  <option value="pantograph">Pantograph (interactive Leak II)</option>
                  <option value="librarian">Librarian (search-first control)</option>
                  <option value="sketch">Sketch (plan then formalize)</option>
                  <option value="brute">Brute (automation only)</option>
                  <option value="have">Have (in-context, no top-level lemmas)</option>
                  {/* value stays `have-tree` — renaming it would orphan saved
                      checkpoints, queued items and every existing research row. */}
                  <option value="have-tree">
                    Leak Stronghold Dark (planner + isolated per-hole minions)
                  </option>
                  <optgroup label="Leak River (Goedel blueprint · grok driver · Leak XI/XII/XIV)">
                    {RIVER_STRATEGIES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Leak Ultra (Goedel blueprint · claude driver · Leak XI/XII/XIV)">
                    {ULTRA_STRATEGIES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>
            {/* The refinement-iteration budget lives on the verifier console
                itself (next to the "+1 min" clock control), so it can be raised
                MID-FLIGHT rather than only configured before a run. */}
            {verifyPaused && verifyQueue.length > 0 && !verifyingId && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => runVerifier()}
              >
                Resume verifying
              </Button>
            )}
          </div>
        </div>
        {verifyStrategy === VERIFY_OFF && (
          <p className="mb-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
            <strong>Verification is off.</strong> Problems are generated and
            saved to history, but no prover runs and new problems are not
            queued.
            {verifyQueue.length > 0 && (
              <>
                {' '}
                {verifyQueue.length} item
                {verifyQueue.length === 1 ? '' : 's'} already in the queue will
                stay put until you pick a strategy.
              </>
            )}
          </p>
        )}
        {verifyStrategy !== VERIFY_OFF &&
          verifyDecompose &&
          !isArchitectStrategy(verifyStrategy) && (
          <p className="mb-2 text-xs text-muted-foreground">
            Decompose mode: each generated problem is proved-or-split into
            toolchain-verified sub-lemmas (recursively) and assembled into one
            sorry-free proof. Slower but closes goals a single run stalls on.
            Verified on{' '}
            <span className="font-mono">{TOOLCHAIN.replace(/^.*:/, '')}</span> ·
            Mathlib {MATHLIB_VERSION} (Leak I/II/IV).
          </p>
        )}
        {verifyDecompose && isArchitectStrategy(verifyStrategy) && (
          <p className="mb-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {[...RIVER_STRATEGIES, ...ULTRA_STRATEGIES].find(
                (s) => s.value === verifyStrategy,
              )?.label ?? 'Leak River Stone (control)'}
              {': '}
            </span>
            {[...RIVER_STRATEGIES, ...ULTRA_STRATEGIES].find(
              (s) => s.value === verifyStrategy,
            )?.note ?? RIVER_STRATEGIES[0].note}{' '}
            Certified on{' '}
            <span className="font-mono">
              {ARCHITECT_TOOLCHAIN.replace(/^.*:/, '')}
            </span>{' '}
            · Mathlib {ARCHITECT_MATHLIB_VERSION} (Leak XI/XII/XIV) — a different
            Lean from the {MATHLIB_VERSION} group, and recorded per row. Results
            are logged to the{' '}
            <Link href="/admin/research" className="underline">
              {isUltraStrategy(verifyStrategy) ? 'Leak Ultra' : 'Leak River'}{' '}
              research table
            </Link>
            .
          </p>
        )}
        {verifyPaused && (
          <div className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-600">
            <span className="font-medium">Paused: </span>
            <span className="font-mono">{verifyPaused}</span>. Items stay
            queued; fix the shared bridge and resume.
          </div>
        )}
        {verifyingId && verifyStartedAt != null && (
          <div className="mb-2 flex items-center gap-2 text-xs text-amber-600">
            <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
            Verifying · {fmtElapsed(verifyStartedAt)}
            <button
              type="button"
              onClick={terminateVerification}
              className="rounded border border-red-500/40 px-1.5 py-0.5 text-red-500 hover:bg-red-500/10"
            >
              Terminate
            </button>
          </div>
        )}
        {/* Rendered for a selected architect strategy (River or Ultra) even with no events yet, so the
            refinement-budget control has a home before the first run too. */}
        {(verifyEvents.length > 0 ||
          (verifyDecompose && isArchitectStrategy(verifyStrategy))) && (
          <ProverConsole
            events={verifyEvents}
            running={!!verifyingId}
            title="Verification activity"
            className="mb-2"
            computeLimit={computeLimit}
            onExtend={extendVerification}
            extending={extending}
            extendLabel={isArchitectStrategy(verifyStrategy) ? '1 min' : '5 min'}
            iterLimit={
              verifyDecompose && isArchitectStrategy(verifyStrategy)
                ? { budget: verifyMaxIters }
                : null
            }
            onExtendIters={extendIterations}
            extendingIters={extendingIters}
            onResetIters={
              verifyMaxIters === ARCHITECT_DEFAULT_ITERS
                ? undefined
                : () => setVerifyMaxIters(ARCHITECT_DEFAULT_ITERS)
            }
          />
        )}
        <div className="space-y-1.5">
          {verifyQueue.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing queued. Turn Work on, hit “Generate one”, or “Verify
              again” on any problem below.
            </p>
          )}
          {verifyQueue.map((q, i) => {
            const active = verifyingId === q.id;
            return (
              <div
                key={q.id}
                className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase',
                      active ? badgeClass.verifying : badgeClass.queued,
                    )}
                  >
                    {active ? 'verifying' : `#${i + 1}`}
                  </span>
                  <span className="truncate">
                    {q.questionTitle || q.problem || 'Untitled problem'}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 px-2 text-xs text-red-500 hover:text-red-600"
                  disabled={active}
                  title={active ? 'Currently verifying' : 'Remove from queue'}
                  onClick={() => removeFromVerifyQueue(q.id)}
                >
                  Remove
                </Button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Generated history */}
      <div className="mt-8">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            Generated{' '}
            <span className="text-sm font-normal text-muted-foreground">
              ({generated.length}/{genCap})
            </span>
          </h2>
          <div className="flex items-center gap-1 text-xs">
            {(['all', 'verified', 'failed'] as GenFilter[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setGenFilter(f)}
                className={cn(
                  'rounded px-2 py-1 capitalize',
                  genFilter === f
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {f}
              </button>
            ))}
            <button
              type="button"
              onClick={loadGenerated}
              className="ml-1 text-muted-foreground underline-offset-2 hover:underline"
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="space-y-2">
          {filtered.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No {genFilter === 'all' ? '' : `${genFilter} `}problems yet.
            </p>
          )}
          {filtered.map((g) => {
            const status = statusOf(g);
            const pl = placementOf(g);
            return (
              <div
                key={g.id}
                className={cn(
                  'rounded-lg border p-3',
                  pl.live && 'border-rose-500/40 bg-rose-500/[0.03]',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase',
                          badgeClass[status],
                        )}
                      >
                        {status}
                      </span>
                      {pl.live && (
                        <span
                          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase bg-rose-500/15 text-rose-600"
                          title="Already published on CompeteMath practice — remove if this is a duplicate"
                        >
                          Live
                        </span>
                      )}
                      {pl.staging && (
                        <span
                          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase bg-blue-500/15 text-blue-600"
                          title="Sitting in the staging review queue"
                        >
                          Staging
                        </span>
                      )}
                      {pl.prod && (
                        <span
                          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase bg-violet-500/15 text-violet-600"
                          title="Promoted to prod — awaiting the CompeteMath publish cron, or already published"
                        >
                          Prod
                        </span>
                      )}
                      {g.gauntlet && (
                        <span
                          className={cn(
                            'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase',
                            g.gauntlet.solved
                              ? 'bg-amber-500/15 text-amber-600'
                              : 'bg-emerald-500/15 text-emerald-600',
                          )}
                          title={
                            g.gauntlet.solved
                              ? `Cracked by ${g.gauntlet.model} — tiered to its measured difficulty`
                              : `Survived ${g.gauntlet.samples} cold solve(s) by ${g.gauntlet.model}`
                          }
                        >
                          {g.gauntlet.solved ? '🛡 cracked' : '🛡 held'}
                        </span>
                      )}
                      {g.gauntlet?.suspectAnswer != null && (
                        <span
                          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase bg-amber-500/15 text-amber-600"
                          title={`All ${g.gauntlet.samples} gauntlet samples agreed on ${g.gauntlet.suspectAnswer}, which differs from the intended answer ${g.answer} — the INTENDED answer may be wrong. Review before staging.`}
                        >
                          ans suspect
                        </span>
                      )}
                      <span className="truncate font-medium">
                        {g.questionTitle || g.problem || 'Untitled problem'}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {metaLine(g, true)}
                    </p>
                    <CostLine cost={costs[g.id]} />
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={() =>
                      setPreviewIds((p) =>
                        p.includes(g.id)
                          ? p.filter((x) => x !== g.id)
                          : [...p, g.id],
                      )
                    }
                  >
                    {previewIds.includes(g.id) ? 'Hide preview' : 'Preview'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    disabled={status === 'queued' || status === 'verifying'}
                    onClick={() => verifyAgain(g)}
                  >
                    {status === 'queued'
                      ? 'Queued'
                      : status === 'verifying'
                        ? 'Verifying…'
                        : 'Verify again'}
                  </Button>
                  {g.proofCheckpoint &&
                    !g.verified &&
                    status !== 'queued' &&
                    status !== 'verifying' && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 border-violet-500/50 px-2 text-xs text-violet-600 hover:bg-violet-500/10 dark:text-violet-400"
                        onClick={() => resumeVerification(g)}
                        title={`Continue from the saved checkpoint (${g.proofCheckpointFilled ?? 0}/${g.proofCheckpointTotal ?? 0} holes banked) instead of restarting`}
                      >
                        ▶ Resume ({g.proofCheckpointFilled ?? 0}/
                        {g.proofCheckpointTotal ?? 0})
                      </Button>
                    )}
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 px-2 text-xs"
                    disabled={busy === `stage:${g.id}` || pl.staging}
                    onClick={() => addToStaging(g)}
                    title={
                      pl.staging
                        ? 'Already in the staging queue'
                        : 'Add this problem to the staging review queue'
                    }
                  >
                    {busy === `stage:${g.id}`
                      ? 'Adding…'
                      : pl.staging
                        ? 'In staging'
                        : 'Add to staging'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-red-500 hover:text-red-600"
                    disabled={busy === `del:${g.id}`}
                    onClick={() => removeGenerated(g.id)}
                  >
                    Delete
                  </Button>
                </div>

                {previewIds.includes(g.id) && (
                  <div className="mt-3 space-y-3 border-t pt-3">
                    {g.problem && <MathMarkdown>{g.problem}</MathMarkdown>}
                    {g.insight && (
                      <div className="rounded bg-muted/40 p-2 text-xs">
                        <span className="font-medium">Insight. </span>
                        <MathMarkdown>{g.insight}</MathMarkdown>
                      </div>
                    )}
                    {!g.verified && g.error && (
                      <p className="text-xs text-red-500">Reason: {g.error}</p>
                    )}
                    {g.lean && (
                      <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11px]">
                        {g.lean}
                      </pre>
                    )}
                    {g.verified && g.proof && (
                      <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-emerald-500/10 p-2 text-[11px]">
                        {g.proof}
                      </pre>
                    )}
                    {statusOf(g) === 'refuted' && g.proof && (
                      <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-fuchsia-500/10 p-2 text-[11px]">
                        <span className="mb-1 block font-medium text-fuchsia-600">
                          Machine-checked disproof (¬theorem, compiled by Lean):
                        </span>
                        {g.proof}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <Separator className="my-8" />

      {/* Review queue */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            Review queue{' '}
            <span className="text-sm font-normal text-muted-foreground">
              ({health?.staging.length ?? items.length})
            </span>
          </h2>
          <div className="flex items-center gap-2 text-xs">
            <HealthChip label="Staging" state={health?.staging} />
            {/* Count the DURABLE promoted set (queue ∪ GeneratedProblem archive),
                the same source the per-item "Prod" badges use — not the transient
                prod queue, which the CompeteMath cron drains to 0 once published.
                Keeps the count consistent with the badges. */}
            <HealthChip
              label="Prod"
              state={
                health?.prod
                  ? { ...health.prod, length: prodTitles.length }
                  : undefined
              }
            />
            <button
              type="button"
              onClick={loadQueue}
              className="text-muted-foreground underline-offset-2 hover:underline"
            >
              Refresh
            </button>
          </div>
        </div>

        {(health?.staging.error || health?.prod.error) && (
          <div className="mb-2 space-y-1 rounded-md border border-red-500/40 bg-red-500/5 p-2 text-[11px] text-red-500">
            {health?.staging.error && (
              <p>
                <span className="font-medium">Staging: </span>
                <span className="break-all font-mono">
                  {health.staging.error}
                </span>
              </p>
            )}
            {health?.prod.error && (
              <p>
                <span className="font-medium">Prod: </span>
                <span className="break-all font-mono">{health.prod.error}</span>
              </p>
            )}
          </div>
        )}

        <div className="space-y-2">
          {items.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {health && !health.staging.ok
                ? 'Staging Redis unreachable — see the error above.'
                : 'Queue is empty.'}
            </p>
          )}
          {items.map((it) => {
            const inProd = prodTitleSet.has(normTitle(it.questionTitle));
            return (
            <div key={it.id} className="rounded-lg border p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {it.questionTitle || it.problem || 'Untitled problem'}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {metaLine(it)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 px-2 text-xs"
                    disabled={
                      busy === `promote:${it.id}` || !health?.prod.ok || inProd
                    }
                    onClick={() => promoteItem(it.id)}
                    title={
                      inProd
                        ? 'Already in the prod queue'
                        : health?.prod.ok
                          ? 'Publish to the production weekly-problems queue'
                          : 'Prod Redis unreachable'
                    }
                  >
                    {busy === `promote:${it.id}`
                      ? '…'
                      : inProd
                        ? 'In prod'
                        : 'Push to prod'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-red-500 hover:text-red-600"
                    disabled={busy === `del:${it.id}`}
                    onClick={() => removeItem(it.id)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </div>
            );
          })}
        </div>
      </div>

      <p className="mt-8 text-xs text-muted-foreground">
        Requires your bridge running (Local Agent → set it up). Verifying never
        auto-stages — “Add to staging” is manual. “Push to prod” publishes to
        the main CompeteMath queue and archives the Lean proof to the database.
      </p>
    </div>
  );
}

// Per-card cost line: the estimate (with band + rationale on hover) and, once
// the proof lands, the actual and the signed delta.
function CostLine({ cost }: { cost?: ItemCost }) {
  if (!cost) return null;
  const { estimating, estFailed, estUsd, estRationale, actualUsd } = cost;
  if (!estimating && !estFailed && estUsd == null && actualUsd == null)
    return null;
  const delta = estUsd != null && actualUsd != null ? actualUsd - estUsd : null;
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
      {estimating ? (
        <span className="text-amber-500">estimating cost…</span>
      ) : estFailed ? (
        <span className="text-muted-foreground">estimate unavailable</span>
      ) : estUsd != null ? (
        <span className="text-amber-600" title={estRationale || undefined}>
          est {fmtUsd(estUsd)}
        </span>
      ) : null}
      {actualUsd != null && (
        <span className="font-medium text-emerald-600">
          actual {fmtUsd(actualUsd)}
        </span>
      )}
      {delta != null && Math.abs(delta) > 1e-9 && (
        <span className={delta > 0 ? 'text-rose-500' : 'text-emerald-500'}>
          Δ {delta > 0 ? '+' : '−'}
          {fmtUsd(Math.abs(delta))}
        </span>
      )}
    </p>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: string;
}) {
  return (
    <div className="rounded-md border p-2">
      <div className={cn('text-lg font-semibold', tone)}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

function HealthChip({
  label,
  state,
}: {
  label: string;
  state?: { ok: boolean; length?: number; error?: string };
}) {
  const ok = state?.ok;
  return (
    <span
      className={cn(
        'flex items-center gap-1 rounded border px-1.5 py-0.5',
        ok === undefined
          ? 'text-muted-foreground'
          : ok
            ? 'border-emerald-500/40 text-emerald-600'
            : 'border-red-500/40 text-red-500',
      )}
      title={state?.error || undefined}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          ok === undefined
            ? 'bg-muted-foreground'
            : ok
              ? 'bg-emerald-500'
              : 'bg-red-500',
        )}
      />
      {label}
      {ok && state?.length != null ? ` · ${state.length}` : ''}
      {ok === false ? ' · error' : ''}
    </span>
  );
}
