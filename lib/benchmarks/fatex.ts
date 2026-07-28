import raw from './fatex.json';

// FATE-X: 100 formal Lean 4 statements from frenzymath/FATE-X, ordered by
// increasing difficulty — graduate abstract/commutative algebra (UFDs and PIDs,
// local rings, Ext and depth, Cohen–Macaulay theory, …) rather than miniF2F's
// competition arithmetic. A much harder ceiling: the intended failure mode here
// is "no prover closes it", not "the easy ones are saturated".
//
// Source: github.com/frenzymath/FATE-X, FATE-X.json (which is byte-identical to
// the FATEX/N.lean files). Each entry keeps the paper's `tag` topic path and a
// count of the supporting declarations the statement carries.
//
// Statements are normalized for the Leak prover exactly as miniF2F's are:
//   - `import Mathlib` removed (the daemon injects it, and its safeguards
//     reject a submission that adds import lines),
//   - the `namespace ProblemN` / `end ProblemN` wrapper removed,
//   - `/-- … -/` doc comments removed (the informal text lives in `informal`).
//
// Single-statement rewrite (2026-07-28): the architect pipeline requires its
// target to be ONE theorem with nothing before it — any `open`/`class`/`def`/
// `instance`/`variable` line preceding the theorem gets swallowed into the
// compiler's target-signature match, which then demands a signature nothing
// can satisfy (verified live: a `class`-prelude problem burned its full budget
// and never produced a compiling blueprint; a bare-theorem problem compiled
// and validated in the same run). 52 of the 100 original FATE-X statements had
// such a prelude and needed rewriting; the other 48 were already bare.
//
// Every rewrite is machine-checked, not asserted: `strengthProof` is a Lean
// tactic proof — verified on Leak XII (Lean/Mathlib v4.32.0) — that derives
// `originalStatement`'s theorem FROM the compact `statement`'s theorem. That
// makes the compact version PROVABLY AT LEAST AS HARD as the original FATE-X
// problem; several rewrites are strictly stronger (e.g. generalizing a
// concrete ring to "any ring isomorphic to it"), never weaker. `originalStatement`
// is kept for every rewritten problem so the claim is auditable.
//
// Toolchain check: every statement was ALSO compiled standalone against Leak
// XII to confirm it elaborates on v4.32.0 (FATE-X itself was authored against
// v4.28.0). 98/100 do. The other 2 are tagged `toolchainIncompatible` below and
// EXCLUDED from every run — genuine v4.28→v4.32 Mathlib API drift on the
// ORIGINAL statement that no rewrite can fix without changing its mathematical
// content:
//   #9  (sylow_subgroup_not_normal_of_maximal_intersection) — `Subgroup.normalizer`
//       field-notation signature changed.
//   #41 (isNoetherianRing_and_krullDim_eq_top) — a definition that used to be
//       computable now requires `noncomputable` (AddMonoidAlgebra.semiring).
export interface FateXProblem {
  id: string;
  /** 1-100, the paper's own ordering (increasing difficulty). */
  index: number;
  /** The target theorem's identifier. */
  name: string | null;
  /** What the prover is handed: always a single self-contained theorem. */
  statement: string;
  informal: string | null;
  /** Topic path from the paper, e.g. ['Abstract Algebra','Ring Theory','PID, ED and UFD']. */
  tags: string[];
  /** How many supporting declarations `statement` carries (always 0 now — see compactRewrite). */
  declarations: number;
  /** True iff `statement` was rewritten from FATE-X's original multi-declaration
   *  form into a single theorem. See `originalStatement` / `strengthProof`. */
  compactRewrite?: boolean;
  /** The untouched original FATE-X statement, kept when compactRewrite is true. */
  originalStatement?: string;
  /** Lean proof, verified on Leak XII, deriving `originalStatement`'s theorem
   *  from `statement`'s — the machine-checked evidence that the rewrite is at
   *  least as hard as the source problem. Present iff compactRewrite is true. */
  strengthProof?: string;
  /** Set (with the compiler error) iff this statement does not elaborate on
   *  our v4.32.0 toolchain — genuine Mathlib API drift, not a rewrite bug.
   *  Excluded from FATEX_RUNNABLE and every benchmark run. */
  toolchainIncompatible?: string;
}

export const FATEX: FateXProblem[] = raw as FateXProblem[];

/** FATEX minus the 2 statements that don't elaborate on our toolchain. */
export const FATEX_RUNNABLE: FateXProblem[] = FATEX.filter(
  (p) => !p.toolchainIncompatible,
);

/** The Lean/Mathlib version FATE-X was authored against (NOT what we run). */
export const FATEX_SOURCE_TOOLCHAIN = 'leanprover/lean4:v4.28.0';
