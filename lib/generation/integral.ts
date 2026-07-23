// Integral generation mode — the VHG hard-verifier task, adapted.
//
// From "Verifier-Backed Hard Problem Generation for Mathematical Reasoning"
// (arXiv:2605.06660). Their indefinite-integral setting is the trapdoor
// paradigm in its purest working form: the setter picks the ANTIDERIVATIVE
// first (the answer), differentiates it (mechanical — differentiation is the
// easy direction), disguises the resulting integrand, and publishes only the
// integrand. Validity is then checked by CODE, not by an LLM's opinion:
// parse both expressions, differentiate the candidate antiderivative, and
// test symbolic equality against the integrand. Degenerate, unparsable, or
// mismatched pairs are rejected outright (their Appendix E.3).
//
// Our adaptation: CompeteMath needs a specific INTEGER answer, so we use
// DEFINITE integrals whose exact value has an AIME-style closed form
// (p/q → "find p+q", a+b·ln c → "find a+b+c", …). The full certificate
// (antiderivative + exact value) is known to the generator by construction.
//
// Honesty note on difficulty: a tool-equipped solver can numerically
// evaluate any definite integral and reverse-engineer closed forms via
// integer-relation detection, so integral problems will often be cracked by
// the gauntlet — that is fine and expected. The gauntlet is a difficulty
// METER here, not a gate: cracked → ships at Hard, held → promoted to
// Insane. The mode's purpose is a steady stream of valid, certified,
// human-challenging integral content (a content type the site lacks), with
// correctness guaranteed by the hard verifier rather than hoped for.

// ---------------------------------------------------------------------------
// Seed bank + transformation vocabulary (sampled code-side, like the
// trapdoor chain — the randomness lives outside the model)
// ---------------------------------------------------------------------------

// Seed ANTIDERIVATIVES — the answer is picked first. Styles follow the
// paper's seeds (their Table 1 / Table 10): compositions with radicals,
// exp/log mixtures, inverse trig, rational-log blends.
export const INTEGRAL_SEEDS: string[] = [
  'exp(x) - 2*sqrt(x)',
  'x - atan(x)',
  '-1/x + log(x)',
  '3*exp(cbrt(x)) * (x**(2/3) - 2*cbrt(x) + 2)',
  '(x+1)**(2/3) - 3*cbrt(x+1) + 3*log(cbrt(x+1) + 1)',
  'x*log(x)**2 - 2*x*log(x) + 2*x',
  'atan(x)**2 / 2',
  'log(x**2 + 1) - x*atan(x)',
  'sqrt(x**2 + 1) + log(x + sqrt(x**2 + 1))',
  'x*exp(x)/(x + 1)',
  'sin(x)*log(sin(x)) - sin(x)',
  'x**2 * atan(x) / 2',
];

// Transformations applied to the seed antiderivative F to produce a harder
// F̃ (then f = F̃′ by sympy). Straight from the paper's illustrated setter
// moves plus the classical disguise repertoire.
export const INTEGRAL_TRANSFORMS: string[] = [
  'PRODUCT-LOG: multiply F by log(q(x)) for a simple polynomial/radical q — the derivative interleaves a reciprocal term with F′ (their "product-style modification").',
  'RATIONAL-WRAP: form F/(1+x²) or F/q(x) for simple q — the quotient rule turns a clean seed into a two-term rational integrand (their "rational wrapping").',
  'RADICAL-COMPOSE: substitute x → sqrt(x), cbrt(x), or sqrt(x+1) inside F — the chain rule injects fractional powers through every term.',
  'EXP-MIX: multiply F by exp(g(x)) for g a simple radical or rational — the derivative couples every term to g′ (their "multiplication combining exponential and radical terms").',
  'TRIG-COMPOSE: substitute x → tan(x), sin(x), or atan(x) inside F, keeping the domain safe on the chosen bounds.',
  'ADDITIVE-BLEND: add a second, structurally different seed antiderivative — the integrand becomes a sum whose parts demand different techniques.',
  'BY-PARTS-BAIT: multiply F by x or x² — the derivative produces a form that looks like integration-by-parts fodder but with the roles disguised.',
];

// AIME-style integer extraction from the exact value of the definite
// integral. The problem statement must state the convention EXACTLY.
export const ANSWER_FORMATS: string[] = [
  'The value is a rational p/q in lowest terms with p, q positive — ask for p + q.',
  'The value has the form a + b·ln(c) with a, b rational and c a small positive integer, ln fully reduced — express a, b in lowest terms and ask for the sum of all numerators and denominators plus c.',
  'The value has the form (a·π + b)/c with a, b, c integers, gcd 1, c > 0 — ask for a + b + c.',
  'The value has the form a·e + b or a/e + b with a, b rationals in lowest terms — ask for the sum of all numerators and denominators.',
  'The value has the form a·sqrt(d) + b with a, b rational, d squarefree — ask for the sum of numerators, denominators, and d.',
];

export interface IntegralRecipe {
  seed: string;
  transforms: string[];
  answerFormat: string;
}

export function sampleIntegralRecipe(
  rand: () => number = Math.random,
): IntegralRecipe {
  const seed = INTEGRAL_SEEDS[Math.floor(rand() * INTEGRAL_SEEDS.length)];
  // 1 transform 60% of the time, 2 stacked 40% — stacking is the paper's
  // route to their hardest verified examples.
  const shuffled = [...INTEGRAL_TRANSFORMS].sort(() => rand() - 0.5);
  const transforms = shuffled.slice(0, rand() < 0.6 ? 1 : 2);
  const answerFormat =
    ANSWER_FORMATS[Math.floor(rand() * ANSWER_FORMATS.length)];
  return { seed, transforms, answerFormat };
}

// ---------------------------------------------------------------------------
// Setter prompt (paper Appendix E.1, adapted to definite + integer answer)
// ---------------------------------------------------------------------------

export function integralSetterPrompt(
  recipe: IntegralRecipe,
  avoid: string,
): string {
  const avoidBlock = avoid
    ? `\n\nAVOID DUPLICATION. Do NOT produce an integrand structurally close to these existing problems:\n${avoid}\n`
    : '';
  return `You are a problem setter building a DEFINITE-INTEGRAL competition problem BACKWARD: the antiderivative is chosen first (so the answer is yours by construction), then differentiated and disguised. Integration is the hard direction; you only ever differentiate.

SEED ANTIDERIVATIVE (sympy syntax): ${recipe.seed}

TRANSFORMATIONS to apply to the seed (in order) to form your final antiderivative F:
${recipe.transforms.map((t, i) => `${i + 1}. ${t}`).join('\n')}

ANSWER FORMAT for the definite value: ${recipe.answerFormat}

BUILD PROCEDURE — do ALL symbolic work in ONE consolidated python3 script via the Bash tool (sympy), re-run on parameter changes; never do calculus in your head:
1. Apply the transformations to the seed to get F. Keep F elementary and expressible in sympy.
2. Compute f = diff(F, x) and SIMPLIFY/REARRANGE f so the route back to F is not visually obvious (expand products, split or merge fractions, rewrite radicals as fractional powers). f must stay exactly equal to F′ — the verifier will check symbolic equality, so disguise by rewriting, never by dropping terms.
3. Choose bounds [a, b] on which f is continuous (or the improper integral clearly converges), F is defined at both endpoints, and the exact value V = F(b) − F(a) lands in the required ANSWER FORMAT. Iterate bounds/parameters in the same script until it does.
4. Compute the integer answer from V exactly as the format prescribes, IN the script.
5. Sanity-check numerically in the same script: mpmath quadrature of f over [a,b] must match V to 20+ digits.
6. Write the problem: display the integral ∫_a^b f(x) dx in standard mathematical notation (LaTeX-style, NOT sympy syntax), state the closed-form shape the value takes and the EXACT extraction convention, and ask for that integer.

TITLE RULES: curious and alluring, 2-6 words; never the "The <Adjective> <Noun>" template; never hint at the answer.

Respond with ONLY this JSON object, nothing else:
{"questionTitle":"<hook>","subtitle":"<1-3 word tagline>","problem":"<self-contained statement with the displayed integral and the exact extraction convention>","answer":<integer>,"difficulty":"Hard","points":150,"level":<1-5 prerequisite-knowledge estimate>,"insight":"<the certificate: F(x) = <antiderivative>, value V = <exact value>, and the key disguise ideas — 1-3 sentences>","integrand":"<f in sympy syntax>","antiderivative":"<F in sympy syntax>","lowerBound":"<a, sympy syntax>","upperBound":"<b, sympy syntax>","exactValue":"<V in sympy syntax>","lean":"theorem name : ∫ x in (<a>:ℝ)..<b>, <f x> = <V> := by sorry"}`;
}

// ---------------------------------------------------------------------------
// Hard verifier (paper Appendix E.3): the verdict comes from EXECUTED sympy,
// the LLM is only the transcription layer. Independent of the setter — never
// trust the setter's own script output.
// ---------------------------------------------------------------------------

export interface IntegralCertificate {
  integrand?: string;
  antiderivative?: string;
  lowerBound?: string;
  upperBound?: string;
  exactValue?: string;
}

export function integralVerifierPrompt(
  cert: IntegralCertificate,
  answer: unknown,
  problem: string,
): string {
  return `You are a hard verifier for a definite-integral problem. Your verdict must come from CODE YOU RUN, not from judgment. Write and run ONE python3 (sympy + mpmath) script via the Bash tool that checks ALL of:

1. PARSE: integrand f, antiderivative F, bounds a, b, claimed exact value V all parse (sympy).
   f = ${cert.integrand ?? '(missing)'}
   F = ${cert.antiderivative ?? '(missing)'}
   a = ${cert.lowerBound ?? '(missing)'}, b = ${cert.upperBound ?? '(missing)'}
   V = ${cert.exactValue ?? '(missing)'}
2. DERIVATIVE MATCH: simplify(diff(F, x) - f) == 0 (try simplify, radsimp, trigsimp, factor — equality under any counts).
3. VALUE: simplify(F.subs(x, b) - F.subs(x, a) - V) == 0, and F is defined (finite) at both endpoints (use limits if an endpoint is a removable issue; reject genuine singularities inside [a, b]).
4. NUMERIC CROSS-CHECK: mpmath quadrature of f over [a, b] equals float(V) to at least 15 significant digits.
5. ANSWER EXTRACTION: the problem's stated convention, applied to V, yields exactly ${String(answer)}. Compute the extraction in the script from V's exact form — do not eyeball it.

--- PROBLEM STATEMENT (for check 5) ---
${problem}

If anything is missing or a check fails, the pair is INVALID. Respond with ONLY these three lines:
VALID: YES|NO
CHECKED_ANSWER: <the integer your script extracted, or NONE>
REASON: <one line — which check failed, or "all checks passed">`;
}

export const INTEGRAL_VERIFIER_SYSTEM_PROMPT =
  'You are a rigorous symbolic-verification agent with a Bash/python tool. Every verdict must come from code you actually ran in this session — never from inspection. Reply in exactly the requested three-line format.';

export interface IntegralVerdict {
  valid: boolean;
  checkedAnswer: string | null;
  reason: string;
}

export function parseIntegralVerdict(text: string): IntegralVerdict {
  const valid = /VALID:\s*YES/i.test(text || '');
  const am = text?.match(/CHECKED_ANSWER:\s*(-?\d+|NONE)/i);
  const checkedAnswer =
    am && am[1].toUpperCase() !== 'NONE' ? am[1] : null;
  const rm = text?.match(/REASON:\s*(.+)/i);
  return {
    valid,
    checkedAnswer,
    reason: rm ? rm[1].trim().slice(0, 300) : '',
  };
}

// ---------------------------------------------------------------------------
// VHG local pre-filters (their Appendix A/B: format, answer, degeneracy
// checks BEFORE any expensive verification or solving). Pure code, free.
// ---------------------------------------------------------------------------

export function prefilterProblem(gen: {
  questionTitle?: string;
  problem?: string;
  answer?: unknown;
  lean?: string;
}): string | null {
  if (!gen.questionTitle?.trim()) return 'missing title';
  const p = (gen.problem ?? '').trim();
  if (p.length < 80) return 'statement too short to be well-posed';
  if (p.length > 6000) return 'statement absurdly long';
  const a = String(gen.answer ?? '').trim();
  if (!/^-?\d+$/.test(a)) return `answer is not a specific integer (got "${a.slice(0, 40)}")`;
  if (!gen.lean?.includes('theorem')) return 'missing Lean theorem';
  return null;
}
