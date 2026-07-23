// Mirage generation mode — hardness by making the solver's own method backfire.
//
// THE DOCTRINE. Every other mode asked "what can an LLM not figure out?" — a
// losing question against frontier+tools. Mirage asks the opposite: "what will
// an LLM confidently get WRONG?" The answer is anything where induction from
// accessible cases lies. A tool-equipped solver's reflex is: compute the small
// / reachable cases, spot the pattern, extrapolate. Mirage problems are built
// so that reflex yields a specific WRONG integer, while the true answer needs
// the structural reason the pattern breaks. This is a permanent asymmetry —
// it's a property of finite-data induction, not of model strength, so it binds
// GPT-7 as surely as Sonnet.
//
// All exact math is done HERE, in TypeScript (BigInt) — the answer and its
// machine-checkable certificate are known before any model runs. The setter
// LLM only writes the disguised narrative around a fully-solved instance; it
// is never trusted for the answer or the Lean statement (those are overwritten
// with the exact values computed below). Generation is one prose call, no tool
// loop — milliseconds of compute plus one short completion.
//
// FLAGSHIP MECHANISM — the threshold mirage (generalized Borwein integral).
// I_n = ∫_0^∞ ∏_{k=0}^n sinc(a_k x) dx equals π/(2 a_0) EXACTLY as long as
// a_1 + … + a_n ≤ a_0, then breaks. The break is real but astronomically tiny
// (~1e-11 for the classic family) — BELOW the accuracy a numerical integrator
// achieves on such a wildly oscillatory infinite product. So a solver that
// numerically evaluates I_n sees the closed form hold for n = 0..B and, even
// evaluating n = B+1, sees it STILL hold (the break hides under quadrature
// noise) — and concludes "for all n." Wrong. Only the hidden equivalence to
// the partial-sum threshold (the Borwein theorem itself, the insight) reveals
// the finite break. We freshen the a_k every instance so the family isn't
// recognizable, and the answer is a guess-proof large integer derived from the
// exact break, not the small break index itself.

// ---------------------------------------------------------------------------
// Exact rational arithmetic (BigInt)
// ---------------------------------------------------------------------------

function gcdBig(a0: bigint, b0: bigint): bigint {
  let a = a0 < 0n ? -a0 : a0;
  let b = b0 < 0n ? -b0 : b0;
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}

interface Frac {
  n: bigint;
  d: bigint;
}

function frac(n0: bigint, d0: bigint): Frac {
  const sign = d0 < 0n ? -1n : 1n;
  const n = n0 * sign;
  const d = d0 * sign;
  const g = gcdBig(n, d) || 1n;
  return { n: n / g, d: d / g };
}

function addFrac(a: Frac, b: Frac): Frac {
  return frac(a.n * b.d + b.n * a.d, a.d * b.d);
}

function subFrac(a: Frac, b: Frac): Frac {
  return frac(a.n * b.d - b.n * a.d, a.d * b.d);
}

// a ≤ b ?
function leFrac(a: Frac, b: Frac): boolean {
  return a.n * b.d <= b.n * a.d;
}

// ---------------------------------------------------------------------------
// Threshold-mirage instance generator (exact, code-side, microseconds)
// ---------------------------------------------------------------------------

export interface MirageInstance {
  mechanism: 'threshold';
  // The scale factors a_k = 1/denom_k as {denom} (a_0 first). Rendered in the
  // problem as a custom pulse/filter sequence, never as sinc/Borwein.
  denoms: number[];
  // Largest n for which a_1+…+a_n ≤ a_0 — i.e. the last n with I_n = π/(2 a_0).
  breakIndex: number;
  // Exact positive slack S = a_0 − (a_1+…+a_{breakIndex}) at the break, reduced.
  slack: Frac;
  // Guess-proof integer answer: numerator + denominator of the slack.
  answer: bigint;
  // What a naive numerical/small-case solver concludes (the wrong belief).
  trap: string;
  // Machine-checkable certificate (decidable — cheap for the prover): the
  // break index is exactly what the threshold inequality gives.
  lean: string;
}

// Guess-proof floor for the answer (VHG): below this a solver could blind-guess
// p+q. Resampling to clear it also selects a larger break index B, which is
// exactly the harder regime (the numeric break sits further below quadrature
// noise), so the gate improves difficulty and guess-proofness together.
const MIN_MIRAGE_ANSWER = 100000n;

// Sample fresh denominators d_1 < d_2 < … whose reciprocals cross the a_0
// threshold at a planted break index B. Resamples until the derived answer is
// guess-proof (this also pushes B into the ~8..15 range, the hard regime).
export function sampleThresholdMirage(
  rand: () => number = Math.random,
): MirageInstance {
  for (let attempt = 0; attempt < 50; attempt++) {
    const inst = sampleThresholdMirageOnce(rand);
    if (inst.answer >= MIN_MIRAGE_ANSWER) return inst;
  }
  // Vanishingly unlikely to reach here; return the last attempt regardless so
  // the caller always gets a valid (if smaller-answer) instance.
  return sampleThresholdMirageOnce(rand);
}

function sampleThresholdMirageOnce(rand: () => number): MirageInstance {
  // a_0 = 1. Build STRICTLY INCREASING denominators (so the a_k = 1/d_k are
  // decreasing widths — the Borwein condition wants ∑_{k≥1} a_k crossing a_0)
  // whose reciprocals sum toward 1. Steps of 1..3 (mean ~2, like the classic
  // 1/(2k+1)) make ∑ 1/d_k grow fast enough to cross 1 around k ≈ 7..14 while
  // the per-step random nudge keeps every instance's widths distinct. Because
  // the harmonic-type sum diverges, the crossing is GUARANTEED; we loop until
  // it happens (safety cap far above any real crossing) and always keep the
  // crossing term, so denoms[breakIndex+1] exists by construction.
  const denoms: number[] = [1];
  const aSeq: Frac[] = [];
  const a0 = frac(1n, 1n);
  let prev = 1; // d_0 = 1
  let running = frac(0n, 1n);
  for (let k = 1; k <= 200; k++) {
    const step = 1 + Math.floor(rand() * 3); // 1..3 — strictly increases prev
    const d = prev + step;
    prev = d;
    const term = frac(1n, BigInt(d));
    denoms.push(d);
    aSeq.push(term);
    running = addFrac(running, term);
    if (!leFrac(running, a0)) break; // this term crossed a_0 — stop, keep it
  }
  // Exact B: largest n with Σ_{k=1}^n a_k ≤ a_0.
  let sum = frac(0n, 1n);
  let breakIndex = 0;
  for (let i = 0; i < aSeq.length; i++) {
    const cand = addFrac(sum, aSeq[i]);
    if (leFrac(cand, a0)) {
      sum = cand;
      breakIndex = i + 1;
    } else break;
  }
  const slack = subFrac(a0, sum); // exact positive gap at the break
  const answer = slack.n + slack.d;

  // Lean certificate: the break index equals the threshold-inequality cutoff.
  // Decidable over ℚ — the prover discharges it with `decide`/`norm_num`.
  const denomList = denoms.slice(1, breakIndex + 1).join(', ');
  const lean = `theorem mirage_break :
    IsGreatest {n : ℕ | (Finset.range n).sum (fun i => (1 : ℚ) / [${denomList}].getD i 1) ≤ 1} ${breakIndex} := by
  sorry`;

  const trap = `A solver numerically evaluates the integral for the reachable factor counts, sees it hold at the closed form for every reachable n, and — because the eventual discrepancy is far smaller than any achievable quadrature accuracy — concludes it holds for ALL n. It does not: it holds for exactly n = 0..${breakIndex}. The finite cutoff is invisible to computation and only follows from the partial-sum threshold (∑ a_k ≤ a_0), which the solver has no reason to connect to the integral.`;

  return {
    mechanism: 'threshold',
    denoms,
    breakIndex,
    slack,
    answer,
    trap,
    lean,
  };
}

// ---------------------------------------------------------------------------
// Setter prompt — the LLM writes ONLY the disguised story around a fully
// solved instance. It receives the answer but must never reveal the mechanism.
// ---------------------------------------------------------------------------

export function mirageSetterPrompt(inst: MirageInstance, avoid: string): string {
  const avoidBlock = avoid
    ? `\n\nAVOID DUPLICATION. Do NOT reuse a framing close to these existing problems:\n${avoid}\n`
    : '';
  const factors = inst.denoms
    .map((d, i) => (i === 0 ? `a_0 = 1` : `a_${i} = 1/${d}`))
    .join(', ');

  return `You are dressing a fully-solved mathematics problem in a disguise. All the mathematics is done — your ONLY job is to write a clean, self-contained problem statement and a curious title around the given object, WITHOUT revealing the hidden mechanism. Do not solve anything; do not add or change any numbers.

THE OBJECT (do not reveal these labels to the solver): consider
    I(n) = ∫_0^∞  ∏_{k=0}^{n}  sin(a_k x) / (a_k x)  dx
with the scale factors ${factors}.
It is a theorem that I(n) = π / (2·a_0) = π/2 for every n up to a hidden cutoff, and then it stops. The cutoff is n = ${inst.breakIndex}.

HOW TO DISGUISE IT (mandatory):
- Frame the product as a physical cascade the reader can picture: overlapping pulse trains, a chain of averaging filters, successive smoothing windows — your choice, make it vivid and concrete. Present the a_k as the given widths/rates of that cascade, listed explicitly.
- NEVER use the words sinc, Borwein, cardinal sine, or "threshold"; never mention partial sums of the a_k. The whole point is that the reader must NOT see the integral is governed by ∑ a_k. Present ONLY the integral and the cascade.
- The reader is told: "for small n this integral equals π/2 exactly; determine [the answer quantity]." Steer them toward computing cases — that is the trap.

THE ANSWER QUANTITY the problem must ask for: "Let B be the largest n for which the integral equals π/2 exactly. Writing the exact positive value of a_0 − (a_1 + … + a_B) as a fraction p/q in lowest terms, find p + q." The answer is ${inst.answer} (do NOT reveal it). This phrasing forces the solver to first pin the cutoff B and then compute an exact rational — a numeric approach cannot fake either.

Respond with ONLY this JSON object, nothing else (answer and lean are placeholders — they will be overwritten with exact values, so you may copy them verbatim):
{"questionTitle":"<curious hook, 2-6 words, never 'The <Adj> <Noun>', never hinting the number>","subtitle":"<1-3 word tagline>","problem":"<the disguised, self-contained statement: the integral, the explicit cascade widths, and the exact answer quantity>","answer":${inst.answer},"difficulty":"Insane","points":200,"level":5,"insight":"<1-3 sentences: the integral equals π/2 until ∑ a_k first exceeds a_0, an invisible-to-computation cutoff at n=${inst.breakIndex}; the naive numeric approach wrongly concludes it holds forever>"}${avoidBlock}`;
}

export const MIRAGE_SETTER_SYSTEM_PROMPT =
  'You are a careful problem editor. You dress already-solved problems in vivid disguises without revealing their mechanism or changing any numbers. Respond with only the requested JSON object.';

// After the setter returns, the caller OVERWRITES answer + lean with these
// exact TS-computed values — the model is never authoritative for them.
export function mirageExactFields(inst: MirageInstance): {
  answer: string;
  lean: string;
  difficulty: string;
  points: number;
} {
  return {
    answer: inst.answer.toString(),
    lean: inst.lean,
    difficulty: 'Insane',
    points: 200,
  };
}
