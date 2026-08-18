'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  RefreshCw,
  Download,
  ShieldCheck,
  ShieldAlert,
  Skull,
  Trash2,
} from 'lucide-react';

interface RiverRow {
  id: string;
  created_at: string;
  problem_title: string | null;
  difficulty: string | null;
  theorem_name: string | null;
  sorried_theorem: string;
  strategy: string | null;
  model: string | null;
  models_used: string[] | null;
  nl_seed_used: boolean | null;
  cost_driver_usd: number | null;
  cost_seed_usd: number | null;
  max_iters: number | null;
  dead_ends_shared: number | null;
  dead_ends_known: number | null;
  interceptor_notes: number | null;
  interceptor_aborts: number | null;
  mechanic_notes: number | null;
  consults: number | null;
  verified: boolean | null;
  refuted: boolean | null;
  cost_usd: number | null;
  cost_cap_hit: boolean | null;
  compute_budget_ms: number | null;
  time_elapsed_s: number | null;
  llm_calls: number | null;
  tool_calls: number | null;
  blueprint_iterations: number | null;
  nodes_total: number | null;
  nodes_solved: number | null;
  nodes_forfeited: number | null;
  nodes_negated: number | null;
  lean_toolchain: string | null;
  mathlib_version: string | null;
  error: string | null;
  bridge_build: string | null;
}

interface UltraRow {
  id: string;
  created_at: string;
  problem_title: string | null;
  difficulty: string | null;
  theorem_name: string | null;
  sorried_theorem: string;
  strategy: string | null;
  model: string | null;
  models_used: string[] | null;
  verified: boolean | null;
  refuted: boolean | null;
  cost_usd: number | null;
  tokens: number | null;
  cost_cap_hit: boolean | null;
  compute_budget_ms: number | null;
  time_elapsed_s: number | null;
  llm_calls: number | null;
  tool_calls: number | null;
  max_iters: number | null;
  blueprint_iterations: number | null;
  nodes_total: number | null;
  nodes_solved: number | null;
  nodes_forfeited: number | null;
  nodes_negated: number | null;
  lean_toolchain: string | null;
  mathlib_version: string | null;
  error: string | null;
  bridge_build: string | null;
}

interface StrongholdRow {
  id: string;
  created_at: string;
  problem_title: string | null;
  difficulty: string | null;
  theorem_name: string | null;
  sorried_theorem: string;
  model: string | null;
  models_used: string[] | null;
  strategy: string | null;
  verified: boolean | null;
  refuted: boolean | null;
  cost_usd: number | null;
  compute_budget_ms: number | null;
  time_elapsed_s: number | null;
  llm_calls: number | null;
  tool_calls: number | null;
  have_case_count: number | null;
  checkpoint_used: boolean | null;
  lean_toolchain: string | null;
  mathlib_version: string | null;
  error: string | null;
  bridge_build: string | null;
}

// Short labels for the Leak River variants (the `strategy` column).
const RIVER_LABELS: Record<string, string> = {
  'river-stone': 'Stone · control',
  'river-gate': 'Gate · ledger',
  'river-delta': 'Delta · ledger+NL',
  'river-vintage': 'Vintage · watchers',
  architect: 'Stone · control (legacy tag)',
};

// Display names for the Claude strategies. `have-tree` is shown as "Leak
// Stronghold Dark"; the stored value stays `have-tree` so existing rows, queued
// items and saved checkpoints keep resolving.
const STRONGHOLD_LABELS: Record<string, string> = {
  'have-tree': 'Stronghold Dark · planner+minions',
  'have-surround': 'Stronghold Surround · parallel minion waves',
  'finality-1': 'Finality I · timed refinement',
  'stronghold-force': 'Stronghold Force · recursive decomposer',
  'stronghold-forte': 'Stronghold Forte · reliable handoff + opening pool',
  'stronghold-keep': 'Stronghold Keep · flat → gated siege → flat finisher',
  'stronghold-impenetrable': 'Stronghold Impenetrable · apply? recon sweep → Surround',
  'control-oneshot': 'Control I · flat one-shot, Leak IV only',
  'control-oneshot-2': 'Control II · flat one-shot, + Leak I search',
  'control-oneshot-3': 'Control III · blind prover + Leak IV gate',
  'control-oneshot-4': 'Control IV · Control II + Leak II Pantograph',
  have: 'Have · single context',
};

// The Lean toolchain that certified a row. Shown on every table because the two
// verifier groups are on DIFFERENT Lean versions — a row without it isn't
// reproducible. "—" means the row predates toolchain recording.
function Toolchain({
  lean,
  mathlib,
}: {
  lean: string | null;
  mathlib: string | null;
}) {
  if (!lean && !mathlib) return null;
  const short = (lean || '').replace(/^leanprover\/lean4:/, '');
  return (
    <span
      title={`Certified on Lean ${lean || '?'} · Mathlib ${mathlib || '?'}`}
      className="rounded bg-sky-500/10 px-1.5 py-0.5 text-sky-700 dark:text-sky-400"
    >
      {short || '?'}
      {mathlib && mathlib !== short ? ` · mathlib ${mathlib}` : ''}
    </span>
  );
}

function fmtNum(v: number | null | undefined, digits = 0): string {
  return v == null ? '—' : v.toFixed(digits);
}

function fmtMs(v: number | null | undefined): string {
  if (v == null) return '—';
  const m = v / 60_000;
  return m >= 1 ? `${m.toFixed(1)}m` : `${Math.round(v / 1000)}s`;
}

function Outcome({
  verified,
  refuted,
}: {
  verified: boolean | null;
  refuted: boolean | null;
}) {
  if (verified)
    return <ShieldCheck className="size-3.5 shrink-0 text-emerald-500" />;
  if (refuted) return <Skull className="size-3.5 shrink-0 text-violet-500" />;
  return <ShieldAlert className="size-3.5 shrink-0 text-amber-500" />;
}

// One research table's viewer: refresh, export-CSV, and a compact scrollable
// row list. Both Leak River and Leak Stronghold reuse this shell with
// system-specific extra columns rendered per row.
function ResearchTable<T extends { id: string; created_at: string }>({
  title,
  subtitle,
  endpoint,
  renderExtra,
}: {
  title: string;
  subtitle: string;
  endpoint: string;
  renderExtra: (row: T) => React.ReactNode;
}) {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(endpoint);
      if (res.ok) setRows((await res.json()).rows ?? []);
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    load();
  }, [load]);

  const handleDelete = useCallback(
    async (id: string, label: string) => {
      if (!confirm(`Delete this row permanently?\n\n${label}`)) return;
      setDeletingId(id);
      try {
        const res = await fetch(`${endpoint}?id=${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        if (res.ok) {
          setRows((prev) => prev.filter((r) => r.id !== id));
        } else {
          const body = await res.json().catch(() => ({}));
          alert(`Delete failed: ${body.error ?? res.status}`);
        }
      } finally {
        setDeletingId(null);
      }
    },
    [endpoint],
  );

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <span className="text-xs font-semibold">{title}</span>
        <span className="text-[11px] text-muted-foreground">{subtitle}</span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {rows.length} row{rows.length === 1 ? '' : 's'}
        </span>
        <a
          href={`${endpoint}?format=csv`}
          className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] hover:bg-muted"
          title="Download every recorded row as CSV, for plotting"
        >
          <Download className="size-3" />
          Export CSV
        </a>
        <button
          type="button"
          onClick={load}
          className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] hover:bg-muted"
        >
          <RefreshCw className={`size-3 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>
      <div className="max-h-[28rem] divide-y divide-border/50 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No attempts recorded yet — every verify run on this system will
            log a row here automatically.
          </p>
        ) : (
          rows.map((r) => {
            const row = r as unknown as {
              theorem_name: string | null;
              sorried_theorem: string;
              problem_title: string | null;
              difficulty: string | null;
              verified: boolean | null;
              refuted: boolean | null;
              cost_usd: number | null;
              time_elapsed_s: number | null;
              llm_calls: number | null;
              tool_calls: number | null;
              model: string | null;
              models_used: string[] | null;
              error: string | null;
            };
            return (
              <div key={r.id} className="px-3 py-1.5">
                <div className="flex items-center gap-2 text-xs">
                  <Outcome verified={row.verified} refuted={row.refuted} />
                  <span
                    className="truncate font-mono text-[11px]"
                    title={row.sorried_theorem}
                  >
                    {row.theorem_name || row.problem_title || '(untitled)'}
                  </span>
                  {row.difficulty && (
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">
                      {row.difficulty}
                    </span>
                  )}
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/70">
                    {new Date(r.created_at).toLocaleString()}
                  </span>
                  <button
                    type="button"
                    disabled={deletingId === r.id}
                    onClick={() =>
                      handleDelete(
                        r.id,
                        row.theorem_name || row.problem_title || r.id,
                      )
                    }
                    title="Delete this row permanently"
                    className="shrink-0 rounded p-0.5 text-muted-foreground/60 hover:bg-rose-500/10 hover:text-rose-500 disabled:opacity-40"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
                  <span title="Actual dollar cost">
                    ${fmtNum(row.cost_usd, 3)}
                  </span>
                  <span title="Wall-clock time elapsed">
                    {fmtMs((row.time_elapsed_s ?? 0) * 1000)}
                  </span>
                  <span title="LLM calls">{row.llm_calls ?? '—'} llm</span>
                  <span title="Tool calls">{row.tool_calls ?? '—'} tools</span>
                  <span
                    title={
                      row.models_used?.length
                        ? `Models used: ${row.models_used.join(', ')}`
                        : 'Driver model'
                    }
                  >
                    {row.models_used?.length
                      ? row.models_used.join(' + ')
                      : row.model || '—'}
                  </span>
                  {renderExtra(r)}
                  {row.error && (
                    <span
                      className="truncate text-rose-500"
                      title={row.error}
                    >
                      {row.error}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// Leak River — the Goedel-Architect-style blueprint pipeline (Grok driver).
export function AdminLeakRiver() {
  return (
    <ResearchTable<RiverRow>
      title="Leak River — research log"
      subtitle="blueprint pipeline (Grok), one row per attempt"
      endpoint="/api/admin/research/river"
      renderExtra={(r) => (
        <>
          {r.strategy && (
            <span
              className="rounded bg-violet-500/10 px-1.5 py-0.5 font-medium text-violet-600 dark:text-violet-400"
              title="Which Leak River variant ran"
            >
              {RIVER_LABELS[r.strategy] ?? r.strategy}
            </span>
          )}
          <span title="Blueprint iterations reached / budget">
            iter {r.blueprint_iterations ?? '—'}
            {r.max_iters ? `/${r.max_iters}` : ''}
          </span>
          <span title="Nodes solved / total in the final blueprint">
            nodes {r.nodes_solved ?? '—'}/{r.nodes_total ?? '—'}
          </span>
          {!!r.nodes_forfeited && (
            <span title="Nodes forfeited">🏳️ {r.nodes_forfeited}</span>
          )}
          {!!r.nodes_negated && (
            <span title="Nodes machine-disproved">🧨 {r.nodes_negated}</span>
          )}
          {!!r.dead_ends_shared && (
            <span title="Dead-end facts injected into node prompts (distinct facts learned)">
              🚧 {r.dead_ends_shared}
              {r.dead_ends_known ? `/${r.dead_ends_known}` : ''}
            </span>
          )}
          {r.nl_seed_used && <span title="NL proof seed used">NL-seeded</span>}
          {r.cost_seed_usd != null && r.cost_seed_usd > 0 && (
            <span title="Cost split: Grok driver + local Sonnet NL seed">
              (drv ${fmtNum(r.cost_driver_usd, 3)} + seed $
              {fmtNum(r.cost_seed_usd, 3)})
            </span>
          )}
          {r.cost_cap_hit && (
            <span className="text-amber-500" title="Hit the dollar cap">
              💸 cap hit
            </span>
          )}
          <Toolchain lean={r.lean_toolchain} mathlib={r.mathlib_version} />
        </>
      )}
    />
  );
}

// Leak River Vintage — Stone + the oversight watchers (per-node interceptor,
// run-wide mechanic, full-log consultant). Its own table: a separate ablation
// branch off Stone, not a rung of the stone→gate→delta ladder, so its rows
// must not be averaged into the River comparison. Same row shape as River
// plus the watcher counters.
export function AdminLeakVintage() {
  return (
    <ResearchTable<RiverRow>
      title="Leak River Vintage — research log"
      subtitle="Stone + oversight watchers (Grok), one row per attempt"
      endpoint="/api/admin/research/vintage"
      renderExtra={(r) => (
        <>
          <span
            className="rounded bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-400"
            title="Stone's pipeline + interceptor (per node) + mechanic (run-wide)"
          >
            Vintage · watchers
          </span>
          <span title="Blueprint iterations reached / budget">
            iter {r.blueprint_iterations ?? '—'}
            {r.max_iters ? `/${r.max_iters}` : ''}
          </span>
          <span title="Nodes solved / total in the final blueprint">
            nodes {r.nodes_solved ?? '—'}/{r.nodes_total ?? '—'}
          </span>
          {!!r.nodes_forfeited && (
            <span title="Nodes forfeited">🏳️ {r.nodes_forfeited}</span>
          )}
          {!!r.nodes_negated && (
            <span title="Nodes machine-disproved">🧨 {r.nodes_negated}</span>
          )}
          {(r.interceptor_notes ?? 0) + (r.interceptor_aborts ?? 0) > 0 && (
            <span title="Interceptor notes injected (aborts of futile attempts)">
              🕵️ {r.interceptor_notes ?? 0}
              {r.interceptor_aborts ? ` (${r.interceptor_aborts} abort)` : ''}
            </span>
          )}
          {!!r.mechanic_notes && (
            <span title="Mechanic notes issued (to agents, refinement, or the log)">
              🔧 {r.mechanic_notes}
            </span>
          )}
          {!!r.consults && (
            <span title="Stuck-loop consultant fires">🧑‍⚖️ {r.consults}</span>
          )}
          {r.cost_cap_hit && (
            <span className="text-amber-500" title="Hit the dollar cap">
              💸 cap hit
            </span>
          )}
          <Toolchain lean={r.lean_toolchain} mathlib={r.mathlib_version} />
        </>
      )}
    />
  );
}

// Leak Ultra — Stone's pipeline with the local Claude CLI as driver.
export function AdminLeakUltra() {
  return (
    <ResearchTable<UltraRow>
      title="Leak Ultra — research log"
      subtitle="blueprint pipeline (Claude CLI driver), one row per attempt"
      endpoint="/api/admin/research/ultra"
      renderExtra={(r) => (
        <>
          <span
            className="rounded bg-teal-500/10 px-1.5 py-0.5 font-medium text-teal-700 dark:text-teal-400"
            title="Leak Ultra variant"
          >
            {r.strategy === 'ultra-fleeting' ? 'Fleeting' : r.strategy || '—'}
          </span>
          <span title="Blueprint iterations reached / budget">
            iter {r.blueprint_iterations ?? '—'}
            {r.max_iters ? `/${r.max_iters}` : ''}
          </span>
          <span title="Nodes solved / total in the final blueprint">
            nodes {r.nodes_solved ?? '—'}/{r.nodes_total ?? '—'}
          </span>
          {!!r.nodes_forfeited && (
            <span title="Nodes forfeited">🏳️ {r.nodes_forfeited}</span>
          )}
          {!!r.nodes_negated && (
            <span title="Nodes machine-disproved">🧨 {r.nodes_negated}</span>
          )}
          {!!r.tokens && (
            <span title="Total tokens across every CLI sub-run">
              {r.tokens.toLocaleString()} tok
            </span>
          )}
          {r.cost_cap_hit && (
            <span className="text-amber-500" title="Hit the dollar cap">
              💸 cap hit
            </span>
          )}
          <Toolchain lean={r.lean_toolchain} mathlib={r.mathlib_version} />
        </>
      )}
    />
  );
}

// Leak Stronghold — the existing Claude-driven strategies.
export function AdminLeakStronghold() {
  return (
    <ResearchTable<StrongholdRow>
      title="Leak Stronghold — research log"
      subtitle="Claude strategies, one row per attempt"
      endpoint="/api/admin/research/stronghold"
      renderExtra={(r) => (
        <>
          {r.strategy && (
            <span
              className="rounded bg-violet-500/10 px-1.5 py-0.5 font-medium text-violet-600 dark:text-violet-400"
              title={`Strategy (stored value: ${r.strategy})`}
            >
              {STRONGHOLD_LABELS[r.strategy] ?? r.strategy}
            </span>
          )}
          <span title="have-tactic count in the final proof">
            {r.have_case_count ?? '—'} have
          </span>
          {r.checkpoint_used && (
            <span title="Resumed from a saved checkpoint">resumed</span>
          )}
          <Toolchain lean={r.lean_toolchain} mathlib={r.mathlib_version} />
        </>
      )}
    />
  );
}
