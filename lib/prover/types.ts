// Normalized prover activity events — the single shape the reusable
// <ProverConsole> renders, regardless of source (bridge /prove-stream today,
// the Burr backend later). The bridge emits a rawer SSE shape; the client
// runner (run-prover-stream.ts) maps it into these.

export type ProverEventKind =
  | 'received' // problem accepted by the prover
  | 'system' // init: model, mcp servers, available tools
  | 'formalising' // turning the statement into a Lean theorem
  | 'thinking' // model reasoning
  | 'text' // model output / status line
  | 'tool_call' // a tool was invoked (name + input)
  | 'tool_result' // tool returned output (ok)
  | 'tool_error' // tool returned/raised an error
  | 'verified' // guardrail passed — proof accepted
  | 'rejected' // guardrail failed — unverified
  | 'error' // fatal/transport error
  | 'done'; // terminal outcome

export interface ProverMetrics {
  tools_invoked?: number;
  llm_invocations?: number;
  time_elapsed?: number; // seconds
  /** Running total dollar cost (sum of `total_cost_usd` across every claude
   *  sub-run in this proof — planner + minions + finisher + node proves). */
  cost_usd?: number;
  /** Running total tokens across all sub-runs. */
  tokens?: number;
  /** Architect (Leak River) only: latest blueprint iteration reached. */
  blueprint_iterations?: number;
  /** Architect only: refinement-iteration budget this run was given. */
  max_iters?: number;
  /** Architect only: cost split — driver (Grok, from tokens) vs NL seed
   *  (local Sonnet, from the CLI's reported total_cost_usd). Sums to cost_usd. */
  cost_driver_usd?: number;
  cost_seed_usd?: number;
  /** Architect only: cumulative driver token counts, so cost can be recomputed
   *  independently of whatever prices were in effect at run time. */
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  /** Every model that actually served a call (incl. ladder fallbacks + seed). */
  models_used?: string[];
  /** Architect only: whether an NL proof seeded blueprint generation. */
  nl_seed_used?: boolean;
  /** river-gate / river-delta only: dead-end facts injected into node prompts,
   *  and distinct facts the run learned. Absent on the control (no ledger). */
  dead_ends_shared?: number;
  dead_ends_known?: number;
  /** Architect only: provable node count in the current/final blueprint. */
  nodes_total?: number;
  /** Architect only: nodes with a registered solve (proof or negation). */
  nodes_solved?: number;
  /** Architect only: nodes that ran out of budget without solving/disproving. */
  nodes_forfeited?: number;
  /** Architect only: nodes machine-disproved (negation registered). */
  nodes_negated?: number;
  /** Architect only: true once the run stopped because it hit the hard dollar cap. */
  cost_cap_hit?: boolean;
  /** Free-text tag identifying the bridge build/experiment batch (BRIDGE_BUILD_TAG). */
  bridge_build?: string;
}

export interface ProverEvent {
  /** Monotonic id for React keys / ordering. */
  id: number;
  /** epoch ms when observed. */
  ts: number;
  kind: ProverEventKind;
  /** One-line human summary (always present). */
  label: string;
  /** Tool name, for tool_* kinds. */
  tool?: string;
  /** Tool input / request payload (stringified). */
  input?: string;
  /** Tool output / response / detail (may be long — the console truncates). */
  detail?: string;
  metrics?: ProverMetrics;
  /** Present on `done`/`verified`. */
  verified?: boolean;
  proof?: string;
  /** Present on `done` when the theorem was machine-disproved (a false master). */
  refuted?: boolean;
  counterexample?: string;
  /** The Lean `¬theorem` script the daemon compiled to certify the disproof. */
  disproof?: string;
}

export interface ProverOutcome {
  verified: boolean;
  proof: string;
  /** Actual dollar cost of the whole proof run (summed across sub-runs). */
  costUsd?: number;
  /** The master was proven FALSE (counterexample verified by Lean). */
  refuted?: boolean;
  counterexample?: string;
  /** The machine-checked `¬theorem` disproof script. */
  disproof?: string;
  /** Terminal metrics snapshot from the `done` frame (llm/tool counts, time
   *  elapsed, and — architect runs only — blueprint/node stats). Used to
   *  populate the Leak River / Leak Stronghold research tables. */
  metrics?: ProverMetrics;
}
