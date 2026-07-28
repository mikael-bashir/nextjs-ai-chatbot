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
//   - the `namespace ProblemN` / `end ProblemN` wrapper removed so the target
//     theorem and its helpers are top-level and unqualified — what the
//     architect's target-name regex and canonical rebuild both assume (any
//     `open … ProblemN` loses that one identifier with it),
//   - `/-- … -/` doc comments removed (the informal text lives in `informal`),
//   - `section` / bare `end` blocks PRESERVED — they scope `variable` lines the
//     theorem still needs.
// 38 of the 100 carry supporting declarations (a custom `class`, `def` or
// `instance` the theorem is stated in terms of); those are part of `statement`.
//
// ⚠️ Toolchain: FATE-X pins Lean/Mathlib **v4.28.0**, while the Leak XI/XII/XIV
// verifier group this benchmark runs against is on **v4.32.0**. Most statements
// elaborate unchanged, but Mathlib API drift across those four releases means a
// few may not — the architect's target pre-flight is advisory, so such a
// problem simply fails rather than aborting the run.
export interface FateXProblem {
  id: string;
  /** 1-100, the paper's own ordering (increasing difficulty). */
  index: number;
  /** The target theorem's identifier. */
  name: string | null;
  statement: string;
  informal: string | null;
  /** Topic path from the paper, e.g. ['Abstract Algebra','Ring Theory','PID, ED and UFD']. */
  tags: string[];
  /** How many supporting declarations the statement carries (0 for most). */
  declarations: number;
}

export const FATEX: FateXProblem[] = raw as FateXProblem[];

/** The Lean/Mathlib version FATE-X was authored against (NOT what we run). */
export const FATEX_SOURCE_TOOLCHAIN = 'leanprover/lean4:v4.28.0';
