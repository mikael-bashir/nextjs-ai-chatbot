import { MINIF2F_TEST } from './minif2f';
import { FATEX } from './fatex';

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
    label: 'FATE-X — 100 graduate algebra problems',
    blurb:
      'Graduate abstract/commutative algebra, ordered by increasing difficulty. Far harder than miniF2F.',
    note: 'frenzymath/FATE-X. 38 of the 100 carry supporting declarations (a custom class/def the theorem is stated over) inside the statement. ⚠️ FATE-X pins Lean/Mathlib v4.28.0 while the Leak XI/XII/XIV verifier group runs v4.32.0 — most statements elaborate unchanged, but Mathlib drift means a few may simply fail to elaborate.',
    problems: FATEX.map((p) => ({
      id: p.id,
      statement: p.statement,
      informal: p.informal,
    })),
    sampleSizes: [
      { label: 'Smoke test — first 5', value: 5 },
      { label: 'Easier end — first 25', value: 25 },
      { label: 'First half — first 50', value: 50 },
      { label: 'Full FATE-X — all 100', value: 0 },
    ],
  },
];

export const DEFAULT_BENCHMARK = BENCHMARKS[0].id;

export function benchmarkById(id: string | null | undefined): BenchmarkDef | null {
  return BENCHMARKS.find((b) => b.id === id) ?? null;
}
