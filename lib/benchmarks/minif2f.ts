import raw from './minif2f-test.json';

// miniF2F-test: 244 formal Lean 4 statements spanning AMC/AIME/IMO and
// high-school/early-undergrad competition math — the standard cross-paper
// benchmark for Lean theorem provers (DeepSeek-Prover, Goedel-Prover,
// Kimina-Prover, Hilbert, Seed-Prover, etc. all report against this exact
// split), fast enough to run a full pass without it taking days.
//
// Formal statements: leanprover-community-style Lean 4 port, MIT-licensed
// (facebookresearch/miniF2F → yangky11/miniF2F-lean4). Informal descriptions
// (where available): google-deepmind/miniF2F's annotated fork, Apache-2.0.
// Original benchmark: Zheng, Han, Polu — "miniF2F: a cross-system benchmark
// for formal Olympiad-level mathematics" (arXiv:2109.00110).
//
// Each `statement` is self-contained (its own `set_option`/`open` lines) and
// ends in `:= by sorry`, ready to hand straight to the prover as `problem`.
export interface MiniF2FProblem {
  id: string;
  split: 'test';
  statement: string;
  informal: string | null;
}

export const MINIF2F_TEST: MiniF2FProblem[] = raw as MiniF2FProblem[];
