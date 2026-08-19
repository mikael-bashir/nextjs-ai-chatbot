import { MINIF2F_TEST } from './minif2f';
import { FATEX_RUNNABLE } from './fatex';

// The benchmark registry. A run names one of these by `id`; the API seeds its
// items from the server's own bundled copy (never from the client), so a run
// can't be created with tampered statements.
export interface BenchmarkProblem {
  id: string;
  statement: string;
  informal: string | null;
}

export interface BenchmarkDef {
  id: string;
  label: string;
  /** One line under the picker. */
  blurb: string;
  /** Longer caveat/provenance note, shown when this benchmark is selected. */
  note: string;
  problems: BenchmarkProblem[];
  /** Sample sizes offered for this benchmark; `0` means "all". */
  sampleSizes: { label: string; value: number }[];
}

export const BENCHMARKS: BenchmarkDef[] = [
  {
    id: 'minif2f-test',
    label: 'miniF2F-test — 244 competition problems',
    blurb:
      'AMC/AIME/IMO + early-undergrad competition math. The standard cross-paper capability benchmark.',
    note: 'Every Lean prover paper (DeepSeek-Prover, Goedel-Prover, Kimina, Seed-Prover…) reports against this exact split, so numbers here are directly comparable to published results.',
    problems: MINIF2F_TEST.map((p) => ({
      id: p.id,
      statement: p.statement,
      informal: p.informal,
    })),
    sampleSizes: [
      { label: 'Smoke test — first 10', value: 10 },
      { label: 'Quick pass — first 50', value: 50 },
      { label: 'Full miniF2F-test — all 244', value: 0 },
    ],
  },
  {
    id: 'fatex',
    label: 'FATE-X — 98 graduate algebra problems',
    blurb:
      'Graduate abstract/commutative algebra, ordered by increasing difficulty. Far harder than miniF2F.',
    note: 'frenzymath/FATE-X, 98/100 problems (2 excluded — see below). Every statement is a single self-contained theorem: the 52 that originally needed a preceding class/def/open were rewritten to inline their supporting declarations, each rewrite machine-verified on Leak XII to prove the ORIGINAL FATE-X theorem from the rewritten one, so the benchmark is provably no easier than the source. 2 problems (#9, #41) are excluded outright — genuine Lean/Mathlib v4.28→v4.32 API drift (FATE-X targets v4.28.0; our verifier group runs v4.32.0) that no statement rewrite can fix without changing the mathematical content.',
    problems: FATEX_RUNNABLE.map((p) => ({
      id: p.id,
      statement: p.statement,
      informal: p.informal,
    })),
    sampleSizes: [
      { label: 'Smoke test — first 5', value: 5 },
      { label: 'Easier end — first 25', value: 25 },
      { label: 'First half — first 50', value: 50 },
      { label: 'Full FATE-X — all 98', value: 0 },
    ],
  },
];

export const DEFAULT_BENCHMARK = BENCHMARKS[0].id;

export function benchmarkById(id: string | null | undefined): BenchmarkDef | null {
  return BENCHMARKS.find((b) => b.id === id) ?? null;
}
