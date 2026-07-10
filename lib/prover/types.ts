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
  /** The master was proven FALSE (counterexample verified by Lean). */
  refuted?: boolean;
  counterexample?: string;
  /** The machine-checked `¬theorem` disproof script. */
  disproof?: string;
}
