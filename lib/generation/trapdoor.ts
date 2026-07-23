// Trapdoor problem generation + the Sonnet gauntlet.
//
// THE TRAPDOOR DOCTRINE. A problem generated "forward" ("write a hard
// problem") is drawn from the same distribution solver models trained on —
// which is why frontier models keep cracking our Insane tier. This module
// inverts the process: CODE samples a random chain of hidden transformations
// (the trapdoor key), and the generator model merely *instantiates* it —
// walks the chain forward (each step trivial to execute), computes the answer
// mechanically, then renders a statement exposing ONLY the outermost surface.
// Creation is easy by construction; solving requires re-discovering every
// hidden layer, where each intermediate representation appears nowhere in the
// statement. The randomness lives outside the model on purpose: models are
// terrible at being random and gravitate to their favourite five tricks.
//
// THE GAUNTLET. Every Insane problem (whatever mode produced it) must defeat
// a mid-tier Claude solving it cold before it can ship. If the solver cracks
// it, the generator gets the solver's own transcript and must close that
// path; after MAX_MUTATIONS failed repairs the problem is scrapped. This is
// the difficulty calibrator: "Insane" stops meaning "the generator felt it
// was hard" and starts meaning "a real adversary failed it".
//
// THE SOLVER GETS TOOLS. Withholding a calculator from the gauntlet does not
// test mathematical difficulty — it tests mental arithmetic, which is a
// different axis entirely and a bad one (the generator itself computes with
// python; a solver denied the same aid will "fail" a problem whose actual
// insight chain is trivial, exactly the "five-line script prints the answer
// in under a second" case the quality bars already ban). So the solver gets
// the same Bash/python tool the generator does, and is never forced into a
// rigid ANSWER: line — it just solves, naturally.
//
// A SEPARATE JUDGE DECIDES THE VERDICT. Parsing the solver's own claimed
// answer isn't enough either: a solver can derive the entire correct method
// and only fumble the final digit-crunching, which means the problem was
// still cracked (a real solver with a calculator finishes it trivially from
// there). So a second model — also tool-equipped, so it can actually RUN any
// code the solver produced rather than take its word — judges the full
// transcript against the ground-truth answer and rules CRACKED if the
// solver stated the right answer, handed over code that (when run) computes
// it, or reduced the problem to a single mechanical step with no insight
// left to find.

// ---------------------------------------------------------------------------
// Move library
// ---------------------------------------------------------------------------

export interface TrapdoorMove {
  id: string;
  name: string;
  // What the generator DOES, forward — must be mechanically executable.
  forward: string;
  // How to render the surface so this layer is invisible in the statement.
  hide: string;
  // Moves this one can feed into (the NEXT layer applied to its output).
  // Empty = terminal finisher.
  feeds: string[];
  // MECHANICAL = there is a known, textbook ALGORITHM that finds this layer
  // (order-finding, CRT/Euler tower-mod reduction, linear-recurrence
  // discovery via Berlekamp-Massey-style state tracking...) — a tool gets
  // you there with no insight, only patience. STRUCTURAL (mechanical=false)
  // = the solver has to INVENT something (a bijection, an invariant, a
  // second counting argument, a group action) that no algorithm hands you.
  // A chain built ENTIRELY from mechanical moves LOOKS insane (huge towers,
  // multi-step) but is actually "run one boilerplate procedure, N times" —
  // exactly what a tool-equipped gauntlet solver eats alive regardless of
  // chain depth. See sampleChain: every sampled chain must include at least
  // one structural move.
  mechanical: boolean;
}

export const MOVE_LIBRARY: TrapdoorMove[] = [
  {
    id: 'unity-filter',
    name: 'Roots-of-unity filter',
    forward:
      'Choose a family of objects and an integer weight on them, such that the full generating product/sum has a simple closed form at each m-th root of unity. The count of objects with weight ≡ r (mod m) is then (1/m)·Σ_j ω^{-jr}·P(ω^j) — a closed form you obtain by evaluating, never by enumerating.',
    hide:
      'The statement only asks to count objects whose weight satisfies a divisibility/residue condition. Generating functions, ω, and the filter identity never appear.',
    feeds: ['modular-collapse', 'telescope', 'recurrence-fold'],
    mechanical: false,
  },
  {
    id: 'bijection-recode',
    name: 'Bijection recode',
    forward:
      'Take a family A that is trivial to count or parametrise. Construct an explicit bijection φ from A to a family B living in a completely different combinatorial skin. The answer about B equals the trivial count of A.',
    hide:
      'Define B intrinsically, in its own vocabulary. A and φ are never mentioned; nothing in the statement suggests B is a re-encoding of anything.',
    feeds: ['unity-filter', 'symmetry-quotient', 'double-count', 'invariant-drop'],
    mechanical: false,
  },
  {
    id: 'modular-collapse',
    name: 'Modular collapse',
    forward:
      'Reduce a giant closed-form value modulo a smallish prime via a chain of: multiplicative order of the base, CRT splits of the exponent modulus, Fermat/Euler reductions, and a final modular inverse. Each reduction is one line; the composition is invisible from outside.',
    hide:
      'Scale the parameters astronomically (tower exponents) so direct evaluation is unthinkable, and ask only for the remainder. The order/CRT/inverse ladder is the solver’s to rediscover.',
    feeds: [],
    mechanical: true,
  },
  {
    id: 'double-count',
    name: 'Double counting',
    forward:
      'Build an incidence structure (pairs/flags/triples with a relation) where counting one way is trivial by your construction. Equating the two counts yields the target quantity.',
    hide:
      'State only the non-trivial side. The incidence structure itself — the thing counted two ways — is never named.',
    feeds: ['unity-filter', 'modular-collapse', 'telescope'],
    mechanical: false,
  },
  {
    id: 'symmetry-quotient',
    name: 'Symmetry quotient',
    forward:
      'Count equivalence classes under a group action you choose (rotation/reflection/relabeling), via Burnside: the answer is the average number of fixed points, each term trivial for the action you picked.',
    hide:
      'Describe the equivalence informally ("two arrangements count as the same if …") without naming the group, the action, or Burnside. Pick an action whose fixed-point counts are easy for YOU but whose orbit structure is not a textbook case.',
    feeds: ['modular-collapse', 'recurrence-fold', 'double-count'],
    mechanical: false,
  },
  {
    id: 'telescope',
    name: 'Hidden telescope',
    forward:
      'Choose f, set g(k) = f(k+1) − f(k) (or a ratio for products), then algebraically disguise g so the cancellation is invisible. The sum/product over any range is f(end) − f(start), known to you instantly.',
    hide:
      'Present g in expanded/rearranged form (partial-fraction remixed, factored differently). Nothing hints the terms collapse.',
    feeds: ['modular-collapse'],
    mechanical: false,
  },
  {
    id: 'genfunc-substitute',
    name: 'Substitution extraction',
    forward:
      'Start from a closed-form identity (product formula, binomial-type series) and choose a substitution that turns the target sum into one coefficient or one evaluation of it. Forward, the answer is a single plug-in.',
    hide:
      'Present the sum in raw combinatorial form. The identity and substitution never appear; the solver must conjure both.',
    feeds: ['unity-filter', 'modular-collapse', 'telescope'],
    mechanical: false,
  },
  {
    id: 'invariant-drop',
    name: 'Invariant drop',
    forward:
      'Define a process/game (merging, splitting, token moves, rewriting) and plant a conserved quantity — a weighting or colouring that the rules provably never change. The final answer is read off the initial state through the invariant, no simulation needed.',
    hide:
      'The statement gives only the rules and asks about an end state after astronomically many steps. The invariant — and even the fact that one exists — is hidden.',
    feeds: ['modular-collapse', 'recurrence-fold', 'double-count'],
    mechanical: false,
  },
  {
    id: 'recurrence-fold',
    name: 'Recurrence fold',
    forward:
      'Engineer the quantity to satisfy a small linear recurrence (order ≤ 4) you chose. Modulo your prime it is eventually periodic with a short period you compute; evaluate at an astronomical index by reducing the index mod the period.',
    hide:
      'Only the defining object at index N is stated. The recurrence is never given — discovering it IS the problem.',
    feeds: ['modular-collapse'],
    // Deceptively "mechanical": a small linear recurrence over a finite
    // field is auto-discoverable by simulating a handful of terms and
    // solving a linear system (Berlekamp-Massey-style) — no insight
    // required, a tool finds it as fast as it can generate the terms.
    mechanical: true,
  },
  {
    id: 'order-trap',
    name: 'Order trap',
    forward:
      'Plant an element (unit mod m, permutation, matrix, functional iterate) whose exact order you engineered via the factorisation of the ambient group order. Questions about periods/repeats/first-returns are read straight off your construction.',
    hide:
      'Present the iteration concretely and ask for the first return / period / a far-downstream state. The order computation and the planted factorisation are hidden.',
    feeds: ['modular-collapse'],
    mechanical: true,
  },
];

// Combinatorial "skin" the chain is dressed in — sampled so the same abstract
// chain never wears the same clothes twice.
export const DOMAIN_SKINS: string[] = [
  'subsets of {1,…,n} and their element-sums',
  'words/strings over a small alphabet with positional rules',
  'lattice paths or walks on a grid',
  'colourings of a cycle, path, or small grid',
  'tournaments or orientations of graphs',
  'permutations with forbidden or forced positions',
  'coefficients of an explicitly given polynomial or product',
  'an integer sequence defined by an explicit self-contained rule',
  'a token / chip / splitting process evolving by simple rules',
  'tilings of a strip or grid by small pieces',
  'residues and clock arithmetic with an unusual modulus',
  'weighted counting where each object carries a product weight',
];

// Scale flavour — how the load-bearing "big numbers" are dressed.
export const SCALE_FLAVOURS: string[] = [
  'tower exponents in the style of 3^101 or 2^(5^40)',
  'constants flavoured around 2026 (2026, 20^26, 2·10^26…)',
  'an unusual small prime modulus (13, 41, 97, 181…) against a giant argument',
  'a factorial or binomial of moderate size composed with a giant index',
];

export interface SampledChain {
  // moves[0] is the innermost (first applied) layer; the last move is the
  // outermost surface the statement is rendered from.
  moves: TrapdoorMove[];
  domain: string;
  flavour: string;
}

function sampleChainOnce(rand: () => number): TrapdoorMove[] {
  const r = rand();
  const targetDepth = r < 0.4 ? 2 : r < 0.85 ? 3 : 4;
  const byId = new Map(MOVE_LIBRARY.map((m) => [m.id, m]));

  // Start anywhere that can feed a chain (non-terminal).
  const starters = MOVE_LIBRARY.filter((m) => m.feeds.length > 0);
  let current = starters[Math.floor(rand() * starters.length)];
  const moves: TrapdoorMove[] = [current];

  while (moves.length < targetDepth) {
    const options = current.feeds
      .map((id) => byId.get(id))
      .filter((m): m is TrapdoorMove => !!m && !moves.some((x) => x.id === m.id));
    if (options.length === 0) break; // hit a terminal finisher early — fine
    current = options[Math.floor(rand() * options.length)];
    moves.push(current);
  }
  return moves;
}

// Sample a random chain by walking the compatibility graph. Depth 2-4,
// weighted toward 3. All randomness is code-side by design (see doctrine).
//
// A chain built ENTIRELY from "mechanical" moves (modular-collapse,
// recurrence-fold, order-trap — every one has a known textbook algorithm
// that finds it) looks insane but is actually "run one boilerplate
// procedure, N times", which a tool-equipped gauntlet solver cracks
// regardless of depth or how astronomical the numbers look. So resample
// until the chain includes at least one STRUCTURAL move (something that
// demands the solver invent a bijection/invariant/argument no algorithm
// hands them) — the loop converges almost immediately in practice since 7
// of the 10 library moves are structural, but it's a guarantee, not a hope.
export function sampleChain(rand: () => number = Math.random): SampledChain {
  let moves = sampleChainOnce(rand);
  for (let attempt = 0; attempt < 25 && moves.every((m) => m.mechanical); attempt++) {
    moves = sampleChainOnce(rand);
  }

  return {
    moves,
    domain: DOMAIN_SKINS[Math.floor(rand() * DOMAIN_SKINS.length)],
    flavour: SCALE_FLAVOURS[Math.floor(rand() * SCALE_FLAVOURS.length)],
  };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

// Quality bars shared with the classic Insane mode — a trapdoor problem must
// still clear all of them; the chain makes clearing them easier, not optional.
const INSANE_QUALITY_BARS = `
QUALITY BARS (all mandatory — redesign until every one is cleared):
· LOAD-BEARING NUMBERS: change the specific numbers and both the answer AND the required ideas must change. A giant number that is pure decoration fails.
· NOT BRUTE-FORCEABLE: no short script may crack it. If a five-line python loop prints the answer in under a second, it fails.
· NO FAMOUS COSTUMES: never dress the construction in a recognisable named object (Wilson, Pell, Fibonacci, Catalan, "the multiplicative group mod p"…). A named object hands the solver the foothold the chain exists to deny. Self-defined, unfamiliar constructions only.
· SPARSE STATEMENT: a couple of clean sentences, minimal given information. The difficulty lives in the ideas, not the reading.
· NON-DEGENERATE ANSWER: not 0/1-by-symmetry, not independent of the elaborate setup.`;

export function trapdoorPrompt(chain: SampledChain, avoid: string): string {
  const layers = chain.moves
    .map(
      (m, i) =>
        `LAYER ${i + 1} — ${m.name} (${m.id})
  Forward construction: ${m.forward}
  How to hide it: ${m.hide}`,
    )
    .join('\n\n');

  const avoidBlock = avoid
    ? `\n\nAVOID DUPLICATION. Do NOT create anything close in topic, structure, or mechanism to these existing problems:\n${avoid}\n`
    : '';

  return `You are a problem architect building a TRAPDOOR competition problem: trivial to construct forward with the secret key below, demanding serious ingenuity to solve without it.

THE SECRET KEY — a chain of hidden transformations, sampled for you. You must realise EXACTLY this chain, in this order (layer 1 is applied first / innermost; the last layer is the outermost surface the statement will show):

${layers}

DOMAIN SKIN: dress the construction as ${chain.domain}.
SCALE FLAVOUR: make the load-bearing numbers ${chain.flavour}.

BUILD PROCEDURE (follow in order):
1. Instantiate layer 1 concretely in the domain skin: pick the seed object/family and parameters.
2. Apply each subsequent layer to the previous layer's OUTPUT — the chain must genuinely compose; do not build ${chain.moves.length} disconnected tricks.
3. Walk the whole chain FORWARD with the Bash tool: write ONE consolidated python3 script that computes every layer and the exact final INTEGER answer in a single run, and re-run that one script when parameters change. Do NOT spread the walk across many small exploratory tool calls — each call is a full model round-trip, and the round-trips (not the arithmetic) are what cost time. Never do large arithmetic in your head.
   SELF-CHECK BUDGET: when validating a helper (e.g. brute-force vs. formula on small cases), a HANDFUL of cases (≤20) at SMALL parameter sizes (nothing near the astronomical scale of the real problem) is enough to catch a construction bug. Do NOT run large-scale validation — hundreds/thousands of random trials, or brute-forcing a case anywhere near the real magnitude — it burns minutes for no extra confidence past the first few checks and is the single biggest cause of slow generations.
4. Write the statement exposing ONLY the outermost layer's surface. NO intermediate object, weight, bijection, group, recurrence, or identity from inner layers may be named or hinted at. A solver must re-discover every layer with none of them visible.
5. Self-check against the quality bars below, then emit the JSON.
${INSANE_QUALITY_BARS}
${avoidBlock}
LEAN THEOREM: a GENERAL/closed-form Lean 4 statement encoding the exact integer answer (NOT decide/native_decide over an enumerable domain), provable in Mathlib with substantive reasoning. Assume "import Mathlib"; no imports. It should be true — it will be machine-checked afterward, so do not re-derive it by hand.

TITLE RULES: genuinely curious and alluring, 2-6 words, varied shape (question / scenario / teaser). HARD BANS: the "The <Adjective> <Noun>" template, and any title that reveals or hints at the answer's value.

Respond with ONLY this JSON object, nothing else:
{"questionTitle":"<hook>","subtitle":"<1-3 word tagline>","problem":"<self-contained statement>","answer":<integer>,"difficulty":"Insane","points":200,"level":<your 1-5 estimate of prerequisite knowledge>,"insight":"<the key ideas, 1-3 sentences>","chain":["<layer 1: one line — what is hidden and how it resolves forward>","<layer 2: …>"],"lean":"theorem name : <statement> := by sorry"}`;
}

// The gauntlet solver sees the statement alone — no insight, no Lean, no hint
// that this is a generated problem — but DOES get a Bash/python tool, same as
// the generator, and is never forced into a rigid output format: it just
// solves, as a real capable solver with a calculator would.
export function gauntletSolverPrompt(problem: string): string {
  return `Solve this competition mathematics problem. The answer is a specific integer.

${problem}

You have a Bash tool — use python3 freely for any arithmetic, modular exponentiation, search, or verification. Never grind large computation by hand; that is not the point of this problem. A handful of small-scale sanity checks (a few cases, small parameters) is enough to confirm a method — do not run large-scale brute-force validation (hundreds/thousands of trials); it wastes time without adding real confidence. Reason honestly: if you find the full method but are unsure of a final digit, say so; if you are genuinely stuck, say so rather than guessing. State your final answer clearly if you reach one.`;
}

export const GAUNTLET_SOLVER_SYSTEM_PROMPT =
  'You are a strong competition mathematician with a Bash/python tool, solving a problem cold. Use the tool freely for computation. Reason honestly; do not fabricate a confident final answer you have not actually derived.';

// The judge sees the ground-truth answer and the solver's full transcript,
// and ALSO gets a Bash tool — so a claim like "this code computes it" is
// verified by actually running the code, not taken on the solver's word.
export function gauntletJudgePrompt(
  problem: string,
  intendedAnswer: string,
  solverTranscript: string,
): string {
  return `Judge whether a solver CRACKED this competition problem — do not solve it yourself from scratch, evaluate what THEY produced.

--- PROBLEM ---
${problem}

--- INTENDED ANSWER (ground truth) ---
${intendedAnswer}

--- SOLVER'S FULL OUTPUT (reasoning + any code it ran) ---
${solverTranscript}

You have a Bash tool. If the solver's output contains code, RUN IT YOURSELF and check what it actually prints — do not trust a claimed result.

CRACKED means ANY of:
(a) the solver's output states the correct final integer (${intendedAnswer}), directly or paraphrased;
(b) the solver's output contains code that, when you run it, correctly computes ${intendedAnswer} — verify this by execution, not inspection;
(c) the solver's derivation reduces the problem to a single mechanical computation (a direct plug-in, one modular exponentiation, one closed-form evaluation) such that ANY capable solver with a calculator would finish it from here with no further insight — even if THIS solver never finished the arithmetic or made a slip at the end.

NOT cracked: the solver is missing a genuine structural or conceptual step (not just an execution step), takes a clearly wrong or incomplete approach, or reaches a wrong answer via a wrong METHOD (not merely a computational slip on an otherwise-correct method).

Respond with ONLY these three lines, nothing else:
VERDICT: CRACKED|HELD
CLAIMED_ANSWER: <the integer the solver arrived at or implied, or NONE>
REASON: <one line — which criterion, or why it held>`;
}

export const GAUNTLET_JUDGE_SYSTEM_PROMPT =
  'You are a rigorous adversarial judge with a Bash/python tool. Verify any code claim by actually running it — never take a transcript\'s word for what code produces. Reply in exactly the requested three-line format, nothing else.';

export interface GauntletSampleVerdict {
  cracked: boolean;
  // Digit-string (sign included) if the judge identified one, else null.
  claimedAnswer: string | null;
  reason: string;
}

// Parse the judge's three-line verdict.
export function parseJudgeVerdict(text: string): GauntletSampleVerdict {
  const cracked = /VERDICT:\s*CRACKED/i.test(text || '');
  const am = text?.match(/CLAIMED_ANSWER:\s*(-?\d+|NONE)/i);
  const claimedAnswer =
    am && am[1].toUpperCase() !== 'NONE' ? normalizeIntString(am[1]) : null;
  const rm = text?.match(/REASON:\s*(.+)/i);
  return { cracked, claimedAnswer, reason: rm ? rm[1].trim().slice(0, 300) : '' };
}

// Normalise an expected/parsed answer for exact comparison ("+07" → "7").
export function normalizeIntString(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!/^[+-]?\d+$/.test(s)) return null;
  const neg = s.startsWith('-');
  const digits = s.replace(/^[+-]/, '').replace(/^0+(?=\d)/, '');
  return digits === '0' ? '0' : (neg ? '-' : '') + digits;
}

export function mutationPrompt(
  itemJson: string,
  solverTranscripts: string[],
  hasChain: boolean,
): string {
  const excerpts = solverTranscripts
    .map(
      (t, i) =>
        `--- SOLVER TRANSCRIPT ${i + 1} (how it was cracked) ---\n${t.slice(-4000)}`,
    )
    .join('\n\n');
  const repair = hasChain
    ? 'Either FUSE ONE ADDITIONAL hidden layer onto the chain (keeping it forward-computable — re-run the python walk for the new exact answer), or RE-SKIN the outermost surface so the pattern the solver latched onto no longer appears. Update "chain" to match.'
    : 'Restructure the problem so the exploited approach is closed off: change the structural device, not just the constants. Cosmetic renaming fails — the solver transcript shows a PATH, and that path must no longer exist.';

  return `A problem you built was SOLVED by a mid-tier model — it is not Insane yet. Repair it so that specific solution path is closed, then re-emit.

--- CURRENT PROBLEM (full JSON) ---
${itemJson}

${excerpts}

REPAIR DOCTRINE: ${repair}
${INSANE_QUALITY_BARS}

The repaired problem must have a specific INTEGER answer and a general (non-decide) Lean 4 theorem, exactly as before. Respond with ONLY the same-shaped JSON object, nothing else.`;
}

// ---------------------------------------------------------------------------
// Post-hoc level assessment (replaces the old target-level constraint: the
// generator now works unconstrained and the tier is judged AFTER the fact).
// ---------------------------------------------------------------------------

const LEVEL_RUBRIC = `1 = a first-year primary-school student technically has the base knowledge (basic arithmetic, counting, simple patterns)
2 = up to early high / secondary school (fractions, basic algebra, simple geometry, elementary number facts)
3 = up to the end of sixth form / college (algebra, functions, sequences, basic combinatorics/number theory, introductory calculus)
4 = built around a single advanced, university-level concept (group theory, linear algebra, real analysis, advanced number theory…)
5 = several advanced, university-level concepts combined`;

export function levelAssessorPrompt(problem: string, insight?: string): string {
  return `Classify the prerequisite KNOWLEDGE level of this maths problem — the background needed to UNDERSTAND and attempt it, NOT how hard it is to solve (a level-1 problem can be fiendish).

${LEVEL_RUBRIC}

--- PROBLEM ---
${problem}
${insight ? `\n--- INTENDED SOLUTION IDEA (private) ---\n${insight}\n` : ''}
Judge by the statement's objects and the intended solution's concepts. Reply with ONLY the single line:
LEVEL: <1-5>`;
}

export const LEVEL_ASSESSOR_SYSTEM_PROMPT =
  'You classify maths problems by prerequisite knowledge tier. Reply with only the requested line.';

export function parseAssessedLevel(text: string): number | null {
  const m = text?.match(/LEVEL:\s*([1-5])/i);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Gauntlet configuration + result metadata (persisted on the generated item)
// ---------------------------------------------------------------------------

export const GAUNTLET_MODEL = 'claude-sonnet-5';
export const GAUNTLET_SAMPLES = 2;
// ONE repair shot, then scrap. A repair round costs a full mutation call plus
// a complete re-gauntlet (2 solvers + 2 judges), and it keeps the same flawed
// skeleton — while a fresh generation rolls a brand-new chain (guaranteed to
// carry a structural move by sampleChain). Measured live, second repairs of a
// cracked design almost never survive; regeneration is the better spend.
export const GAUNTLET_MAX_MUTATIONS = 1;
// Generation-side cap only (the no-wall-clock-cap rule protects the PROVER).
// A solver that can't crack it inside this window has, for gauntlet purposes,
// failed to crack it — which is the pass condition, so a timeout is safe.
export const GAUNTLET_TIMEOUT_MS = 15 * 60 * 1000;

export interface GauntletMeta {
  model: string;
  samples: number;
  // One judge verdict per solver sample.
  verdicts: GauntletSampleVerdict[];
  // True = any sample was judged CRACKED → the problem must repair or scrap.
  solved: boolean;
  // How many repair rounds were spent before the final verdict.
  mutations: number;
  // Set when every HELD sample's judge nonetheless converged on the SAME
  // answer, different from the intended one — a strong smell that the
  // INTENDED answer (not the problem) is wrong. Surfaced as a review flag.
  suspectAnswer?: string;
}
