'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { MathMarkdown } from '@/components/math-markdown';

const TOOLCHAIN = 'leanprover/lean4:v4.29.1';

// Generation needs no tools/MCP — run claude lean so each call carries ~4k
// tokens of context instead of ~17k (default system prompt + tool schemas),
// which drastically cuts subscription rate-limit pressure when looping.
const GEN_RUN_OPTIONS = {
  // No cap (0): hard/nested problems can take a long time to reason through, and
  // the "Terminate" button now controls it (which kills claude server-side via
  // the bridge's disconnect handler, so an uncapped run can't run away).
  timeoutMs: 0,
  systemPrompt:
    'You are a creative competition-math problem setter. Follow the user instructions exactly and respond with ONLY the requested JSON object.',
  disallowedTools:
    'Bash Read Edit Write Glob Grep WebFetch WebSearch Task TodoWrite NotebookEdit',
  strictMcpConfig: true,
  excludeDynamicSections: true,
};

// The model's context window, for a rough "% of context used" readout.
const CONTEXT_WINDOW = 200000;

function fmtElapsed(startMs: number | null): string {
  if (startMs == null) return '';
  const s = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

// Compute the next timestamp for a wall-clock time like "8:30pm" in the viewer's
// local timezone (best effort — assumes the browser tz matches the reset tz).
function nextTimeToday(hour12: number, minute: number, ampm?: string): number {
  let hour = hour12;
  if (ampm) {
    const pm = /p/i.test(ampm);
    if (pm && hour < 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  }
  const now = new Date();
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// Detect Claude's usage/session-limit message (e.g. "You've hit your session
// limit · resets 8:30pm (Europe/London)") in stdout/stderr, and parse the reset
// time so the worker can pause and auto-resume.
function detectSessionLimit(text: string): {
  hit: boolean;
  message?: string;
  resetText?: string;
  resetAt?: number;
} {
  const t = (text || '').trim();
  if (!/limit/i.test(t)) return { hit: false };
  if (
    !/(session|usage|rate)\s*limit|hit your|limit (reached|exceeded)/i.test(t)
  )
    return { hit: false };
  const m = t.match(/reset[s]?\b[^0-9]*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  const resetAt = m
    ? nextTimeToday(Number(m[1]), m[2] ? Number(m[2]) : 0, m[3])
    : undefined;
  return {
    hit: true,
    message: t.slice(0, 200),
    resetText: m?.[0]?.trim(),
    resetAt,
  };
}

function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

type GenMode = 'standard' | 'hard' | 'nested';

const MODE_LABEL: Record<GenMode, string> = {
  standard: 'Standard',
  hard: 'Hard',
  nested: 'Nested insights',
};

const BASE_REQS = `You are a creative competition-math problem setter. Invent ONE original problem.

Core requirements:
- Creative and NON-standard: not a textbook exercise, not a famous/known competition problem, not a classic named result. Fresh setup and phrasing.
- The answer is a specific INTEGER.
- Give presentation metadata: a short evocative title, a 1-3 word subtitle, a difficulty of exactly "Easy" | "Medium" | "Hard" | "Extreme", and points = 50 for Easy, 100 for Medium, 150 for Hard, 200 for Extreme.`;

const MODE_BLOCKS: Record<GenMode, string> = {
  standard: `
- Solvable BY HAND with at most a basic calculator via an elegant insight, NOT brute force.
- Provide a Lean 4 theorem stating the exact answer, provable in Mathlib. Prefer a statement decidable by decide/native_decide over a SMALL finite domain (Fin n, Finset.range/Icc, functions between small Fin types) so it is machine-checkable. It MUST be true.`,
  hard: `
- HARD MODE. The problem must NOT be solvable by a short brute-force script: avoid small finite search spaces. Use large or unbounded domains, a general n, or structures where naive enumeration is infeasible. It must hinge on a genuine, non-obvious insight, yet still be solvable by hand to a specific integer.
- The Lean 4 theorem must NOT be provable by decide/native_decide over an enumerable domain. State a GENERAL or closed-form fact (a formula in n, an identity, a divisibility/inequality, a characterization) that requires real Mathlib tactics — induction, algebra, known lemmas — to prove. It MUST be true. Still attempt to make it provable in Mathlib.`,
  nested: `
- NESTED INSIGHTS MODE. The solution must require chaining 2-3 DISTINCT, non-obvious insights, each unlocking the next — no single trick suffices, and it is definitely not brute-forceable. A strong solver needs a genuine multi-step derivation to reach the integer answer.
- The Lean 4 theorem must be a GENERAL / closed-form statement (NOT decide/native_decide over a finite domain), provable in Mathlib only with substantive, multi-step reasoning. It MUST be true. Still attempt to make it provable in Mathlib.`,
};

const RESPONSE_FORMAT = `

Assume "import Mathlib" is present; do NOT include imports.
Respond with ONLY this JSON object, nothing else:
{"questionTitle":"<short evocative title>","subtitle":"<1-3 word tagline>","problem":"<self-contained statement>","answer":<integer>,"difficulty":"Easy|Medium|Hard|Extreme","points":<50|100|150|200>,"insight":"<key trick(s), 1-3 sentences>","lean":"theorem name : <statement encoding the integer answer> := by sorry"}`;

interface LiveProblem {
  title: string;
  subtitle?: string;
  difficulty?: string;
}

interface LogEntry {
  id: number;
  ts: number;
  level: 'error' | 'warn' | 'info';
  message: string;
  // Optional payload, e.g. the raw generation output that failed to parse.
  detail?: string;
}

// Serialize a log entry to a self-contained, copy-pasteable block (includes the
// full raw output) so it can be dropped straight into a bug report.
function formatLogEntry(e: LogEntry): string {
  const head = `[${new Date(e.ts).toISOString()}] ${e.level.toUpperCase()}: ${e.message}`;
  return e.detail
    ? `${head}\n----- raw output -----\n${e.detail}\n----------------------`
    : head;
}

// Summarise problems that already exist (here + live on CompeteMath) so the
// model can deliberately avoid repeating topics/structures.
function buildAvoidContext(
  gen: { questionTitle?: string; problem?: string }[],
  live: LiveProblem[],
): string {
  const genLines = gen
    .slice(0, 60)
    .map(
      (g) =>
        `- "${g.questionTitle ?? 'untitled'}"${g.problem ? `: ${g.problem.replace(/\s+/g, ' ').slice(0, 110)}` : ''}`,
    );
  const liveLines = live
    .slice(0, 120)
    .map((p) => `- "${p.title}"${p.subtitle ? ` — ${p.subtitle}` : ''}`);
  const parts: string[] = [];
  if (genLines.length)
    parts.push(`Already generated here:\n${genLines.join('\n')}`);
  if (liveLines.length)
    parts.push(`Already live on CompeteMath:\n${liveLines.join('\n')}`);
  return parts.join('\n\n');
}

function buildPrompt(mode: GenMode, avoid: string): string {
  const avoidBlock = avoid
    ? `\n\nAVOID DUPLICATION. Do NOT create anything close in topic, structure, or mechanism to the problems below — choose a genuinely different area of mathematics and a fresh device:\n${avoid}`
    : '';
  return BASE_REQS + MODE_BLOCKS[mode] + avoidBlock + RESPONSE_FORMAT;
}

interface GenProblem {
  questionTitle?: string;
  subtitle?: string;
  problem?: string;
  answer?: number;
  difficulty?: string;
  points?: number;
  insight?: string;
  lean?: string;
}

interface StagedItem extends GenProblem {
  id: string;
  proof?: string;
  toolchain?: string;
  createdAt?: string;
}

interface GeneratedItem extends StagedItem {
  verified: boolean;
  error?: string | null;
  queued?: boolean;
}

interface Health {
  staging: { ok: boolean; length?: number; error?: string };
  prod: { ok: boolean; length?: number; error?: string };
}

type GenFilter = 'all' | 'verified' | 'failed';

// LLMs emit JSON whose string values contain raw LaTeX backslashes (\sum,
// \lfloor, …) and sometimes literal newlines/tabs — both invalid inside a JSON
// string, so JSON.parse throws. Walk the candidate string-aware and escape those
// so the (otherwise well-formed) object parses. Only applied as a fallback.
function repairJsonStrings(s: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inStr) {
      out += c;
      if (c === '"') inStr = true;
      continue;
    }
    // Inside a string value.
    if (c === '\\') {
      const next = s[i + 1];
      if (next && '"\\/bfnrtu'.includes(next)) {
        out += c + next; // keep a valid escape intact
        i++;
      } else {
        out += '\\\\'; // lone backslash (LaTeX) → escape it
      }
    } else if (c === '"') {
      // A `"` really closes the string only if the next non-space char is a
      // JSON delimiter (, } ] :) or the end. Otherwise it's an unescaped quote
      // inside the value (e.g. a "friendly" pair) — escape it.
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      const nxt = s[j];
      if (
        nxt === undefined ||
        nxt === ',' ||
        nxt === '}' ||
        nxt === ']' ||
        nxt === ':'
      ) {
        out += c;
        inStr = false;
      } else {
        out += '\\"';
      }
    } else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else out += c;
  }
  return out;
}

// Return the first BALANCED {...} object starting at `start`, respecting strings
// (so braces inside the Lean code or problem text don't end it early). Handles
// prose that trails the object and contains stray braces.
function firstJsonObject(s: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function extractJson(text: string): GenProblem | null {
  if (!text) return null;
  let s = text.trim();
  // Unwrap a ```json … ``` fence if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  if (start === -1) return null;
  // Two candidate slices: the first balanced object (best for trailing prose),
  // and first-{ to last-} (best when unescaped quotes confuse brace matching).
  const balanced = firstJsonObject(s, start);
  const lastEnd = s.lastIndexOf('}');
  const greedy = lastEnd > start ? s.slice(start, lastEnd + 1) : null;
  const candidates: string[] = [];
  for (const c of [balanced, greedy]) {
    if (c && !candidates.includes(c)) candidates.push(c);
  }
  // For each candidate try strict, then a repaired version (raw LaTeX
  // backslashes, literal newlines, unescaped inner quotes).
  for (const cand of candidates) {
    for (const attempt of [cand, repairJsonStrings(cand)]) {
      try {
        return JSON.parse(attempt) as GenProblem;
      } catch {
        /* try the next candidate */
      }
    }
  }
  return null;
}

function metaLine(p: GeneratedItem | StagedItem, withDate = false): string {
  return [
    p.difficulty,
    p.points ? `${p.points}pts` : null,
    p.answer != null ? `ans ${p.answer}` : null,
    withDate && (p as GeneratedItem).createdAt
      ? new Date((p as GeneratedItem).createdAt as string).toLocaleString()
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

// Read a bridge connection from localStorage. `useWork` prefers the dedicated
// Work-loop bridge (lca.workBridgeUrl); verification uses the shared bridge so
// generation and proving can run in parallel on two bridges.
function connFor(useWork: boolean) {
  try {
    const base = JSON.parse(localStorage.getItem('lca.connection') || '{}');
    const workUrl = localStorage.getItem('lca.workBridgeUrl') || '';
    return useWork && workUrl ? { ...base, bridgeUrl: workUrl } : base;
  } catch {
    return {} as { bridgeUrl?: string; token?: string };
  }
}

export function AdminPipeline() {
  const [work, setWork] = useState(false);
  const [genStage, setGenStage] = useState<'idle' | 'generating' | 'saving'>(
    'idle',
  );
  const [stats, setStats] = useState({
    generated: 0,
    verified: 0,
    failed: 0,
    errors: 0,
  });
  const [log, setLog] = useState<LogEntry[]>([]);
  const [logOpen, setLogOpen] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);

  const copy = useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  }, []);

  const pushLog = useCallback(
    (level: LogEntry['level'], message: string, detail?: string) => {
      setLog((l) =>
        [
          {
            id: Date.now() + Math.random(),
            ts: Date.now(),
            level,
            message,
            detail,
          },
          ...l,
        ].slice(0, 100),
      );
    },
    [],
  );

  const pauseForLimit = useCallback(
    (lim: { message: string; resetText?: string; resetAt?: number }) => {
      if (limitPausedRef.current) return;
      limitPausedRef.current = true;
      setLimitPause(lim);
      pushLog(
        'warn',
        `Paused — Claude session/usage limit reached${
          lim.resetText ? ` (${lim.resetText})` : ''
        }. Work auto-resumes at reset.`,
        lim.message,
      );
    },
    [pushLog],
  );

  const [queued, setQueued] = useState<number | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [items, setItems] = useState<StagedItem[]>([]);
  const [generated, setGenerated] = useState<GeneratedItem[]>([]);
  const [genCap, setGenCap] = useState(200);
  const [genFilter, setGenFilter] = useState<GenFilter>('all');
  const [previewIds, setPreviewIds] = useState<string[]>([]);
  const [mode, setMode] = useState<GenMode>('standard');
  const [liveProblems, setLiveProblems] = useState<LiveProblem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [workBridgeUrl, setWorkBridgeUrl] = useState('');
  const [generatingOne, setGeneratingOne] = useState(false);

  // Verification queue (client-side): problems awaiting proof, processed serially
  // by a single verifier so generation and proving stay decoupled.
  const [verifyQueue, setVerifyQueue] = useState<GeneratedItem[]>([]);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [verifyPaused, setVerifyPaused] = useState<string | null>(null);
  const [verifyActivity, setVerifyActivity] = useState<
    Array<{ id: number; tool: string }>
  >([]);

  // Live monitoring: start timestamps drive elapsed timers; usage accumulates
  // token/cost metadata reported by the bridge.
  const [genStartedAt, setGenStartedAt] = useState<number | null>(null);
  const [verifyStartedAt, setVerifyStartedAt] = useState<number | null>(null);
  const [, setNowTick] = useState(0);
  const [usage, setUsage] = useState({
    calls: 0,
    tokens: 0,
    costUsd: 0,
    lastTokens: 0,
    lastCostUsd: 0,
  });

  // Auto-pause when Claude's session/usage limit is hit; auto-resume at reset.
  const [limitPause, setLimitPause] = useState<{
    message: string;
    resetText?: string;
    resetAt?: number;
  } | null>(null);

  const workRef = useRef(false);
  const genAbortRef = useRef<AbortController | null>(null);
  const verifyAbortRef = useRef<AbortController | null>(null);
  const limitPausedRef = useRef(false);
  const queueRef = useRef<GeneratedItem[]>([]);
  const verifyingIdRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  // Refs so generateOne reads the latest mode + existing problems for the prompt
  // without depending on that state (which would restart the Work loop).
  const modeRef = useRef<GenMode>('standard');
  const generatedRef = useRef<GeneratedItem[]>([]);
  const liveRef = useRef<LiveProblem[]>([]);

  const syncQueue = () => setVerifyQueue([...queueRef.current]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    generatedRef.current = generated;
  }, [generated]);

  // Tick once a second while something is running (or paused), so elapsed timers
  // and the limit countdown update live.
  useEffect(() => {
    if (genStartedAt == null && verifyStartedAt == null && !limitPause) return;
    const id = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [genStartedAt, verifyStartedAt, limitPause]);

  const recordUsage = useCallback((u: any, costUsd: number | null) => {
    const t =
      (u?.input_tokens ?? 0) +
      (u?.cache_creation_input_tokens ?? 0) +
      (u?.cache_read_input_tokens ?? 0) +
      (u?.output_tokens ?? 0);
    if (!t && !costUsd) return;
    const cost = costUsd ?? 0;
    setUsage((s) => ({
      calls: s.calls + 1,
      tokens: s.tokens + t,
      costUsd: s.costUsd + cost,
      lastTokens: t,
      lastCostUsd: cost,
    }));
  }, []);

  const callBridge = useCallback(
    (useWork: boolean, path: string, init?: RequestInit) => {
      const conn = connFor(useWork);
      let base = (conn.bridgeUrl || 'http://localhost:4123').replace(/\/$/, '');
      // Tolerate a bare host:port (e.g. "localhost:4123") — fetch needs a scheme.
      if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
      return fetch(`${base}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          'x-bridge-token': conn.token || '',
          ...(init?.headers || {}),
        },
      });
    },
    [],
  );

  const fetchMcp = async (): Promise<Array<{ name: string; url: string }>> => {
    try {
      const r = await fetch('/api/mcp/servers');
      if (!r.ok) return [];
      const s = await r.json();
      return Array.isArray(s)
        ? s
            .filter((x: any) => x?.url && x?.name && x?.isActive !== false)
            .map((x: any) => ({ name: x.name, url: x.url }))
        : [];
    } catch {
      return [];
    }
  };

  // Prove via the SHARED bridge; collect tool activity for display. THROWS on a
  // connectivity/protocol failure (unreachable bridge, non-2xx, no completion
  // event) so the verifier can treat that as transient and keep the item queued,
  // rather than mis-marking it "failed". Returns an outcome only on a real
  // `done` event.
  const proveStream = useCallback(
    async (
      lean: string,
      mcpServers: Array<{ name: string; url: string }>,
      signal?: AbortSignal,
    ) => {
      let res: Response;
      try {
        res = await callBridge(false, '/prove-stream', {
          method: 'POST',
          body: JSON.stringify({ theorem: lean, mcpServers }),
          signal,
        });
      } catch {
        if (signal?.aborted) throw new Error('__aborted__');
        throw new Error("couldn't reach the verification (shared) bridge");
      }
      if (!res.ok || !res.body) {
        throw new Error(`prove bridge returned ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let content = ''; // accumulate text to detect a session-limit message
      let outcome: { verified: boolean; proof: string } | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const events = buf.split('\n\n');
        buf = events.pop() || '';
        for (const e of events) {
          if (!e.startsWith('data:')) continue;
          try {
            const d = JSON.parse(e.replace(/^data:\s*/, ''));
            if (d.type === 'message-annotation' && d.tool) {
              setVerifyActivity((a) => [
                ...a.slice(-9),
                { id: Date.now() + a.length, tool: String(d.tool) },
              ]);
            }
            if (typeof d.content === 'string') content += d.content;
            if (typeof d.message === 'string') content += ` ${d.message}`;
            if (d.type === 'done')
              outcome = { verified: !!d.verified, proof: d.proof || '' };
          } catch {
            /* ignore */
          }
        }
      }
      // Surface a usage-limit hit so the verifier pauses instead of failing.
      const lim = detectSessionLimit(content);
      if (lim.hit) throw Object.assign(new Error('__limit__'), { limit: lim });
      if (!outcome) throw new Error('prove stream ended without a result');
      return outcome;
    },
    [callBridge],
  );

  const patchGenerated = async (id: string, patch: Record<string, unknown>) => {
    const res = await fetch('/api/admin/generated', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, ...patch }),
    });
    if (res.ok) {
      const j = await res.json();
      if (j.item)
        setGenerated((g) => g.map((x) => (x.id === j.item.id ? j.item : x)));
    }
  };

  // The single verifier: pulls the head of the queue, proves it on the shared
  // bridge, persists the outcome (clearing the DB `queued` flag), and moves on.
  // A connectivity/protocol failure PAUSES the loop and leaves the item queued —
  // so a bridge that's down never mis-marks problems as failed.
  const runVerifier = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setVerifyPaused(null);
    try {
      while (queueRef.current.length > 0) {
        // Stop proving while paused for a usage limit (auto-resumes on reset).
        if (limitPausedRef.current) break;
        const item = queueRef.current[0];
        verifyingIdRef.current = item.id;
        setVerifyingId(item.id);
        setVerifyActivity([]);
        const ctrl = new AbortController();
        verifyAbortRef.current = ctrl;
        setVerifyStartedAt(Date.now());

        let verified = false;
        let proof = '';
        try {
          const mcpServers = await fetchMcp();
          const out = await proveStream(
            item.lean as string,
            mcpServers,
            ctrl.signal,
          );
          verified = out.verified;
          proof = out.proof;
        } catch (e) {
          const title =
            item.questionTitle || item.problem?.slice(0, 60) || item.id;
          if (ctrl.signal.aborted) {
            // User terminated THIS verification — mark it and move to the next.
            await patchGenerated(item.id, {
              verified: false,
              error: 'Verification terminated by you',
              queued: false,
            });
            setStats((s) => ({ ...s, failed: s.failed + 1 }));
            pushLog('warn', `Verification terminated: ${title}`);
            queueRef.current = queueRef.current.filter((x) => x.id !== item.id);
            syncQueue();
            continue;
          }
          const lim = (e as { limit?: Parameters<typeof pauseForLimit>[0] })
            .limit;
          if (lim) {
            // Usage limit — leave this item queued and pause everything.
            pauseForLimit(lim);
            break;
          }
          // Transient — keep the item queued (DB flag stays true) and stop.
          const msg = String((e as Error)?.message || e);
          setVerifyPaused(msg);
          pushLog('warn', `Verification paused: ${msg} (items stay queued)`);
          break;
        }

        // Genuine outcome: persist it and clear the queued flag.
        await patchGenerated(item.id, {
          verified,
          proof,
          error: verified ? null : 'Lean proof did not verify',
          queued: false,
        });
        setStats((s) => ({
          ...s,
          verified: s.verified + (verified ? 1 : 0),
          failed: s.failed + (verified ? 0 : 1),
        }));
        pushLog(
          verified ? 'info' : 'warn',
          `${verified ? 'Proved' : 'Did not verify'}: ${
            item.questionTitle || item.problem?.slice(0, 60) || item.id
          }`,
        );
        queueRef.current = queueRef.current.filter((x) => x.id !== item.id);
        syncQueue();
      }
    } finally {
      verifyingIdRef.current = null;
      verifyAbortRef.current = null;
      setVerifyingId(null);
      setVerifyStartedAt(null);
      runningRef.current = false;
    }
  }, [proveStream, pushLog, pauseForLimit]);

  const terminateVerification = () => verifyAbortRef.current?.abort();

  const resumeNow = useCallback(() => {
    limitPausedRef.current = false;
    setLimitPause(null);
    // Generation loop resumes on its own (it polls limitPausedRef); kick the
    // verifier back into gear for any still-queued items.
    runVerifier();
  }, [runVerifier]);

  // Auto-resume at the parsed reset time (+30s buffer). If no reset time could
  // be parsed, stays paused until the user resumes manually.
  useEffect(() => {
    if (!limitPause?.resetAt) return;
    const ms = Math.max(0, limitPause.resetAt - Date.now()) + 30000;
    const id = setTimeout(resumeNow, ms);
    return () => clearTimeout(id);
  }, [limitPause, resumeNow]);

  // Add to the verification queue — persists queued=true so it survives reloads.
  const enqueueVerify = useCallback(
    async (item: GeneratedItem) => {
      if (
        verifyingIdRef.current === item.id ||
        queueRef.current.some((x) => x.id === item.id)
      ) {
        return;
      }
      queueRef.current = [...queueRef.current, { ...item, queued: true }];
      syncQueue();
      await patchGenerated(item.id, { queued: true });
      runVerifier();
    },
    [runVerifier],
  );

  const removeFromVerifyQueue = async (id: string) => {
    queueRef.current = queueRef.current.filter((x) => x.id !== id);
    syncQueue();
    await patchGenerated(id, { queued: false });
  };

  // Rebuild the in-memory queue from the DB `queued` flags (on load), preserving
  // FIFO order, and resume verifying.
  const rebuildQueue = useCallback(
    (list: GeneratedItem[]) => {
      queueRef.current = list
        .filter((g) => g.queued)
        .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
      syncQueue();
      if (queueRef.current.length > 0) runVerifier();
    },
    [runVerifier],
  );

  // ---- loaders (hydrate on mount / manual refresh) ----------------------

  const loadQueue = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/problems');
      if (!r.ok) return;
      const j = await r.json();
      setHealth(j.health ?? null);
      setItems(Array.isArray(j.items) ? j.items : []);
      setQueued(j.queued ?? null);
    } catch {
      /* ignore */
    }
  }, []);

  const loadGenerated = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/generated');
      if (!r.ok) return;
      const j = await r.json();
      const list: GeneratedItem[] = Array.isArray(j.items) ? j.items : [];
      setGenerated(list);
      if (typeof j.cap === 'number') setGenCap(j.cap);
      rebuildQueue(list);
    } catch {
      /* ignore */
    }
  }, [rebuildQueue]);

  const loadAll = useCallback(() => {
    loadQueue();
    loadGenerated();
  }, [loadQueue, loadGenerated]);

  useEffect(() => {
    loadAll();
    setWorkBridgeUrl(localStorage.getItem('lca.workBridgeUrl') || '');
    const savedMode = localStorage.getItem('lca.genMode') as GenMode | null;
    if (savedMode && savedMode in MODE_LABEL) setMode(savedMode);
    // Pull already-live CompeteMath problems so generation can avoid them.
    fetch('/api/admin/live-problems')
      .then((r) => (r.ok ? r.json() : { problems: [] }))
      .then((j) => {
        const p: LiveProblem[] = Array.isArray(j.problems) ? j.problems : [];
        liveRef.current = p;
        setLiveProblems(p);
      })
      .catch(() => {
        /* live context is best-effort */
      });
  }, [loadAll]);

  const persistMode = (m: GenMode) => {
    setMode(m);
    localStorage.setItem('lca.genMode', m);
  };

  const persistWorkBridgeUrl = (value: string) => {
    setWorkBridgeUrl(value);
    if (value.trim()) localStorage.setItem('lca.workBridgeUrl', value.trim());
    else localStorage.removeItem('lca.workBridgeUrl');
  };

  // ---- generation (produces unverified problems, enqueues them) ---------

  // Generate ONE problem on the work bridge, save it unverified, and enqueue it
  // for verification. Returns nothing; throws on generation failure.
  const generateOne = useCallback(async () => {
    const bridgeUrl =
      (connFor(true).bridgeUrl as string) || 'http://localhost:4123';
    const ctrl = new AbortController();
    genAbortRef.current = ctrl;
    setGenStartedAt(Date.now());
    setGenStage('generating');
    try {
      const prompt = buildPrompt(
        modeRef.current,
        buildAvoidContext(generatedRef.current, liveRef.current),
      );
      let genRes: Response;
      try {
        genRes = await callBridge(true, '/run', {
          method: 'POST',
          body: JSON.stringify({ prompt, options: GEN_RUN_OPTIONS }),
          signal: ctrl.signal,
        });
      } catch {
        if (ctrl.signal.aborted)
          throw new Error('Generation terminated by you');
        throw new Error(
          `Couldn't reach the generation bridge at ${bridgeUrl}. Check a bridge is running there, the URL is a full http:// URL, and you're on Chrome/Edge/Firefox.`,
        );
      }
      if (!genRes.ok) {
        const body = await genRes.text().catch(() => '');
        const detail = `${JSON.stringify(
          {
            bridge: bridgeUrl,
            httpStatus: genRes.status,
            mode: modeRef.current,
          },
          null,
          2,
        )}\n\n----- response body -----\n${body || '(empty)'}`;
        throw Object.assign(
          new Error(`Bridge /run failed (${genRes.status})`),
          {
            detail,
          },
        );
      }
      const genData = await genRes.json();
      recordUsage(genData.usage, genData.costUsd);
      const raw = String(genData.text || genData.proof || '');
      const gen = extractJson(raw);
      if (!gen?.lean) {
        // Rich diagnostic: the bridge's own metadata explains an empty/failed run
        // (timeout, non-zero exit, claude stderr like a rate limit) — the actual
        // cause, not just the symptom. Plus the full raw output for parse issues.
        const stderr = String(genData.stderr || '').trim();
        // Session/usage limit → surface a limit marker so the loop pauses.
        const lim = detectSessionLimit(`${raw}\n${stderr}`);
        if (lim.hit) {
          throw Object.assign(
            new Error(
              `Session limit reached${lim.resetText ? ` — ${lim.resetText}` : ''}`,
            ),
            { limit: lim, detail: raw || stderr },
          );
        }
        const reason = raw
          ? 'could not parse a problem from the output'
          : genData.timedOut
            ? `generation timed out after ${genData.durationMs ?? '?'}ms`
            : genData.ok === false
              ? `claude exited ${genData.exitCode ?? '?'}${stderr ? `: ${stderr.split('\n')[0].slice(0, 120)}` : ' (no stderr)'}`
              : 'empty output (claude returned no text)';
        const meta = {
          mode: modeRef.current,
          bridge: bridgeUrl,
          httpStatus: genRes.status,
          ok: genData.ok,
          exitCode: genData.exitCode,
          timedOut: genData.timedOut,
          durationMs: genData.durationMs,
          textLength: raw.length,
          promptChars: prompt.length,
        };
        const detail = `${JSON.stringify(meta, null, 2)}${
          stderr ? `\n\n----- stderr -----\n${stderr}` : ''
        }\n\n----- raw output (${raw.length} chars) -----\n${raw || '(empty)'}`;
        throw Object.assign(new Error(`Discarded — ${reason}`), { detail });
      }
      setStats((s) => ({ ...s, generated: s.generated + 1 }));

      setGenStage('saving');
      const res = await fetch('/api/admin/generated', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...gen,
          verified: false,
          proof: '',
          error: null,
          queued: true,
          toolchain: TOOLCHAIN,
        }),
      });
      if (res.ok) {
        const j = await res.json();
        if (j.item) {
          setGenerated((g) => [j.item, ...g.filter((x) => x.id !== j.item.id)]);
          // Already persisted queued=true; just add to the in-memory queue.
          if (!queueRef.current.some((x) => x.id === j.item.id)) {
            queueRef.current = [...queueRef.current, j.item];
            syncQueue();
          }
          runVerifier();
        }
      }
    } finally {
      genAbortRef.current = null;
      setGenStartedAt(null);
      setGenStage('idle');
    }
  }, [callBridge, runVerifier, recordUsage]);

  const terminateGeneration = () => genAbortRef.current?.abort();

  // Manual: add one fresh unproven generation to the verify queue.
  const addUnprovenGeneration = useCallback(async () => {
    setGeneratingOne(true);
    try {
      await generateOne();
    } catch (e) {
      const err = e as Error & { detail?: string };
      setStats((s) => ({ ...s, errors: s.errors + 1 }));
      pushLog('error', err.message, err.detail);
    } finally {
      setGeneratingOne(false);
    }
  }, [generateOne, pushLog]);

  // The Work loop: keep generating (each generation enqueues itself).
  useEffect(() => {
    workRef.current = work;
    if (!work) {
      setGenStage('idle');
      return;
    }
    let cancelled = false;
    (async () => {
      while (!cancelled && workRef.current) {
        // Hold while paused for a usage limit (auto-resumes when the limit clears).
        if (limitPausedRef.current) {
          await new Promise((res) => setTimeout(res, 4000));
          continue;
        }
        try {
          await generateOne();
        } catch (e) {
          const err = e as Error & {
            detail?: string;
            limit?: { message: string; resetText?: string; resetAt?: number };
          };
          if (err.limit) {
            pauseForLimit(err.limit);
          } else {
            setStats((s) => ({ ...s, errors: s.errors + 1 }));
            pushLog('error', err.message, err.detail);
          }
          await new Promise((res) => setTimeout(res, 3000));
        }
      }
      if (!cancelled) setGenStage('idle');
    })();
    return () => {
      cancelled = true;
    };
  }, [work, generateOne, pushLog, pauseForLimit]);

  // ---- per-item actions -------------------------------------------------

  // "Verify again" simply (re)enqueues the problem — the verifier handles it.
  const verifyAgain = (item: GeneratedItem) => {
    if (item.lean) enqueueVerify(item);
  };

  const addToStaging = useCallback(async (item: GeneratedItem | StagedItem) => {
    if (!item.lean) return;
    setBusy(`stage:${item.id}`);
    try {
      const res = await fetch('/api/admin/problems', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          questionTitle: item.questionTitle ?? null,
          subtitle: item.subtitle ?? null,
          problem: item.problem ?? null,
          answer: item.answer ?? null,
          difficulty: item.difficulty ?? null,
          points: item.points ?? null,
          insight: item.insight ?? null,
          lean: item.lean,
          proof: item.proof ?? '',
          toolchain: item.toolchain ?? TOOLCHAIN,
        }),
      });
      if (res.ok) {
        const j = await res.json();
        if (j.staged)
          setItems((it) => [
            j.staged,
            ...it.filter((x) => x.id !== j.staged.id),
          ]);
        if (typeof j.queued === 'number') setQueued(j.queued);
      }
    } finally {
      setBusy(null);
    }
  }, []);

  const removeGenerated = useCallback(async (id: string) => {
    setBusy(`del:${id}`);
    try {
      const res = await fetch(
        `/api/admin/generated?id=${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      if (res.ok) {
        setGenerated((g) => g.filter((x) => x.id !== id));
        // The record is gone; just drop it from the in-memory queue.
        queueRef.current = queueRef.current.filter((x) => x.id !== id);
        syncQueue();
      }
    } finally {
      setBusy(null);
    }
  }, []);

  const dropStaged = (id: string) => {
    setItems((it) => it.filter((x) => x.id !== id));
    setQueued((q) => (typeof q === 'number' ? Math.max(0, q - 1) : q));
  };

  const removeItem = useCallback(async (id: string) => {
    setBusy(`del:${id}`);
    try {
      const res = await fetch(
        `/api/admin/problems?id=${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      if (res.ok) dropStaged(id);
    } finally {
      setBusy(null);
    }
  }, []);

  const promoteItem = useCallback(async (id: string) => {
    setBusy(`promote:${id}`);
    try {
      const r = await fetch('/api/admin/problems/promote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!r.ok) throw new Error((await r.text()) || `failed (${r.status})`);
      dropStaged(id);
    } catch (e) {
      setHealth((h) =>
        h
          ? { ...h, prod: { ok: false, error: String((e as Error).message) } }
          : h,
      );
    } finally {
      setBusy(null);
    }
  }, []);

  // ---- derived ----------------------------------------------------------

  const statusOf = (g: GeneratedItem) => {
    if (verifyingId === g.id) return 'verifying';
    if (verifyQueue.some((x) => x.id === g.id)) return 'queued';
    if (g.verified) return 'proved';
    if (g.error) return 'failed';
    return 'unverified';
  };

  const badgeClass: Record<string, string> = {
    verifying: 'bg-amber-500/15 text-amber-600 animate-pulse',
    queued: 'bg-blue-500/15 text-blue-600',
    proved: 'bg-emerald-500/15 text-emerald-600',
    failed: 'bg-red-500/15 text-red-500',
    unverified: 'bg-muted text-muted-foreground',
  };

  const filtered = generated.filter(
    (g) =>
      genFilter === 'all' ||
      (genFilter === 'verified' ? g.verified : !g.verified),
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Content pipeline</h1>
          <p className="text-sm text-muted-foreground">
            Generate → queue for proof → review → publish.
          </p>
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link href="/">← Back to chat</Link>
        </Button>
      </div>

      {/* Usage-limit pause banner */}
      {limitPause && (
        <div className="mb-4 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium text-amber-700">
                ⏸ Paused — Claude usage limit reached
              </p>
              <p className="mt-0.5 text-xs text-amber-700/90">
                {limitPause.message}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {limitPause.resetAt
                  ? `Auto-resumes at ${new Date(limitPause.resetAt).toLocaleTimeString()} (in ${fmtCountdown(limitPause.resetAt - Date.now())}).`
                  : 'No reset time detected — resume manually when your limit refreshes.'}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-8 shrink-0"
              onClick={resumeNow}
            >
              Resume now
            </Button>
          </div>
        </div>
      )}

      {/* Work / generation control */}
      <div className="rounded-lg border p-4">
        <div className="flex items-center justify-between">
          <div>
            <Label htmlFor="admin-work" className="text-base">
              Work
            </Label>
            <p className="text-xs text-muted-foreground">
              While on: continuously generate problems and add them to the
              verification queue below.
            </p>
          </div>
          <Switch id="admin-work" checked={work} onCheckedChange={setWork} />
        </div>

        <div className="mt-3">
          <Label className="text-xs">Difficulty mode</Label>
          <div className="mt-1 flex flex-wrap gap-1 text-xs">
            {(['standard', 'hard', 'nested'] as GenMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => persistMode(m)}
                className={cn(
                  'rounded border px-2 py-1',
                  mode === m
                    ? 'border-foreground bg-foreground text-background'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {mode === 'standard' &&
              'Elegant, hand-solvable; Lean proof usually machine-checkable (decide).'}
            {mode === 'hard' &&
              'No brute-force / small-search solution; Lean theorem is general (not decide) — harder to auto-prove, but the workflow still tries.'}
            {mode === 'nested' &&
              'Requires chaining 2-3 distinct insights; general (non-decide) Lean statement. Hardest to prove automatically.'}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            De-duplicating against {generated.length} generated +{' '}
            {liveProblems.length} live CompeteMath problems.
          </p>
        </div>

        <div className="mt-3">
          <Label htmlFor="admin-work-bridge" className="text-xs">
            Generation bridge URL (optional)
          </Label>
          <Input
            id="admin-work-bridge"
            value={workBridgeUrl}
            placeholder="defaults to your shared bridge"
            className="mt-1 h-8 max-w-sm text-xs"
            onChange={(e) => persistWorkBridgeUrl(e.target.value)}
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Generation runs here (e.g. http://localhost:4124); verification runs
            on your shared bridge, so the two can work in parallel.
          </p>
        </div>

        <div className="mt-4 grid grid-cols-4 gap-2 text-center">
          <Stat label="Generated" value={stats.generated} />
          <Stat
            label="Verified"
            value={stats.verified}
            tone="text-emerald-600"
          />
          <Stat label="Failed" value={stats.failed} />
          <Stat label="Queued" value={queued ?? '—'} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium">Generation:</span>
          {genStartedAt != null ? (
            <span className="flex items-center gap-1.5 text-amber-600">
              <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
              {genStage} ({MODE_LABEL[mode]}) · {fmtElapsed(genStartedAt)}
              <button
                type="button"
                onClick={terminateGeneration}
                className="ml-1 rounded border border-red-500/40 px-1.5 py-0.5 text-red-500 hover:bg-red-500/10"
              >
                Terminate
              </button>
            </span>
          ) : (
            <span className="capitalize text-muted-foreground">{genStage}</span>
          )}
          {stats.errors > 0 && (
            <span className="text-red-500">· {stats.errors} errors</span>
          )}
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-7 px-2 text-xs"
            disabled={generatingOne || genStartedAt != null}
            onClick={addUnprovenGeneration}
          >
            {generatingOne ? 'Generating…' : '+ Generate one → queue'}
          </Button>
        </div>

        {/* Usage / metadata */}
        <div className="mt-3 grid grid-cols-3 gap-2 rounded-md border p-2 text-center text-[11px]">
          <div>
            <div className="font-semibold">{usage.calls}</div>
            <div className="text-muted-foreground">claude calls</div>
          </div>
          <div>
            <div className="font-semibold">{fmtTokens(usage.tokens)}</div>
            <div className="text-muted-foreground">total tokens</div>
          </div>
          <div>
            <div className="font-semibold">${usage.costUsd.toFixed(3)}</div>
            <div className="text-muted-foreground">session cost</div>
          </div>
        </div>
        {usage.lastTokens > 0 && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Last generation: {fmtTokens(usage.lastTokens)} tokens ($
            {usage.lastCostUsd.toFixed(3)}) —{' '}
            {((usage.lastTokens / CONTEXT_WINDOW) * 100).toFixed(1)}% of the{' '}
            {fmtTokens(CONTEXT_WINDOW)} context window.
          </p>
        )}
      </div>

      {/* Activity / error log */}
      <div className="mt-8">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            Log{' '}
            <span className="text-sm font-normal text-muted-foreground">
              ({log.length})
            </span>
          </h2>
          {log.length > 0 && (
            <div className="flex items-center gap-3 text-xs">
              <button
                type="button"
                onClick={() =>
                  copy('all', log.map(formatLogEntry).join('\n\n'))
                }
                className="text-muted-foreground underline-offset-2 hover:underline"
              >
                {copied === 'all' ? 'Copied ✓' : 'Copy all'}
              </button>
              <button
                type="button"
                onClick={() => setLog([])}
                className="text-muted-foreground underline-offset-2 hover:underline"
              >
                Clear
              </button>
            </div>
          )}
        </div>
        <p className="mb-2 text-[11px] text-muted-foreground">
          Something break? Hit “Copy all” (or a row’s “copy”) and paste it to
          Claude — each entry includes the full raw output, so the exact failure
          can be diagnosed.
        </p>
        <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2">
          {log.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Errors, discarded generations, and verification results appear
              here.
            </p>
          )}
          {log.map((e) => (
            <div key={e.id} className="text-xs">
              <div className="flex items-start gap-2">
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {new Date(e.ts).toLocaleTimeString()}
                </span>
                <span
                  className={cn(
                    'break-words',
                    e.level === 'error'
                      ? 'text-red-500'
                      : e.level === 'warn'
                        ? 'text-amber-600'
                        : 'text-muted-foreground',
                  )}
                >
                  {e.message}
                </span>
                <div className="ml-auto flex shrink-0 gap-2 text-[10px] text-muted-foreground">
                  <button
                    type="button"
                    className="underline-offset-2 hover:underline"
                    onClick={() => copy(String(e.id), formatLogEntry(e))}
                  >
                    {copied === String(e.id) ? 'copied ✓' : 'copy'}
                  </button>
                  {e.detail && (
                    <button
                      type="button"
                      className="underline-offset-2 hover:underline"
                      onClick={() =>
                        setLogOpen((s) => {
                          const n = new Set(s);
                          if (n.has(e.id)) n.delete(e.id);
                          else n.add(e.id);
                          return n;
                        })
                      }
                    >
                      {logOpen.has(e.id) ? 'hide raw' : 'view raw'}
                    </button>
                  )}
                </div>
              </div>
              {e.detail && logOpen.has(e.id) && (
                <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[10px]">
                  {e.detail}
                </pre>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Verification queue */}
      <div className="mt-8">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            Verification queue{' '}
            <span className="text-sm font-normal text-muted-foreground">
              ({verifyQueue.length})
            </span>
          </h2>
          {verifyPaused && verifyQueue.length > 0 && !verifyingId && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => runVerifier()}
            >
              Resume verifying
            </Button>
          )}
        </div>
        {verifyPaused && (
          <div className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-600">
            <span className="font-medium">Paused: </span>
            <span className="font-mono">{verifyPaused}</span>. Items stay
            queued; fix the shared bridge and resume.
          </div>
        )}
        {verifyingId && verifyStartedAt != null && (
          <div className="mb-2 flex items-center gap-2 text-xs text-amber-600">
            <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
            Verifying · {fmtElapsed(verifyStartedAt)}
            <button
              type="button"
              onClick={terminateVerification}
              className="rounded border border-red-500/40 px-1.5 py-0.5 text-red-500 hover:bg-red-500/10"
            >
              Terminate
            </button>
          </div>
        )}
        {verifyingId && verifyActivity.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {verifyActivity.map((t) => (
              <span
                key={t.id}
                className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {t.tool}
              </span>
            ))}
          </div>
        )}
        <div className="space-y-1.5">
          {verifyQueue.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing queued. Turn Work on, hit “Generate one”, or “Verify
              again” on any problem below.
            </p>
          )}
          {verifyQueue.map((q, i) => {
            const active = verifyingId === q.id;
            return (
              <div
                key={q.id}
                className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase',
                      active ? badgeClass.verifying : badgeClass.queued,
                    )}
                  >
                    {active ? 'verifying' : `#${i + 1}`}
                  </span>
                  <span className="truncate">
                    {q.questionTitle || q.problem || 'Untitled problem'}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 px-2 text-xs text-red-500 hover:text-red-600"
                  disabled={active}
                  title={active ? 'Currently verifying' : 'Remove from queue'}
                  onClick={() => removeFromVerifyQueue(q.id)}
                >
                  Remove
                </Button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Generated history */}
      <div className="mt-8">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            Generated{' '}
            <span className="text-sm font-normal text-muted-foreground">
              ({generated.length}/{genCap})
            </span>
          </h2>
          <div className="flex items-center gap-1 text-xs">
            {(['all', 'verified', 'failed'] as GenFilter[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setGenFilter(f)}
                className={cn(
                  'rounded px-2 py-1 capitalize',
                  genFilter === f
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {f}
              </button>
            ))}
            <button
              type="button"
              onClick={loadGenerated}
              className="ml-1 text-muted-foreground underline-offset-2 hover:underline"
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="space-y-2">
          {filtered.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No {genFilter === 'all' ? '' : `${genFilter} `}problems yet.
            </p>
          )}
          {filtered.map((g) => {
            const status = statusOf(g);
            return (
              <div key={g.id} className="rounded-lg border p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase',
                          badgeClass[status],
                        )}
                      >
                        {status}
                      </span>
                      <span className="truncate font-medium">
                        {g.questionTitle || g.problem || 'Untitled problem'}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {metaLine(g, true)}
                    </p>
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={() =>
                      setPreviewIds((p) =>
                        p.includes(g.id)
                          ? p.filter((x) => x !== g.id)
                          : [...p, g.id],
                      )
                    }
                  >
                    {previewIds.includes(g.id) ? 'Hide preview' : 'Preview'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    disabled={status === 'queued' || status === 'verifying'}
                    onClick={() => verifyAgain(g)}
                  >
                    {status === 'queued'
                      ? 'Queued'
                      : status === 'verifying'
                        ? 'Verifying…'
                        : 'Verify again'}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 px-2 text-xs"
                    disabled={busy === `stage:${g.id}`}
                    onClick={() => addToStaging(g)}
                    title="Add this problem to the staging review queue"
                  >
                    {busy === `stage:${g.id}` ? 'Adding…' : 'Add to staging'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-red-500 hover:text-red-600"
                    disabled={busy === `del:${g.id}`}
                    onClick={() => removeGenerated(g.id)}
                  >
                    Delete
                  </Button>
                </div>

                {previewIds.includes(g.id) && (
                  <div className="mt-3 space-y-3 border-t pt-3">
                    {g.problem && <MathMarkdown>{g.problem}</MathMarkdown>}
                    {g.insight && (
                      <div className="rounded bg-muted/40 p-2 text-xs">
                        <span className="font-medium">Insight. </span>
                        <MathMarkdown>{g.insight}</MathMarkdown>
                      </div>
                    )}
                    {!g.verified && g.error && (
                      <p className="text-xs text-red-500">Reason: {g.error}</p>
                    )}
                    {g.lean && (
                      <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11px]">
                        {g.lean}
                      </pre>
                    )}
                    {g.verified && g.proof && (
                      <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-emerald-500/10 p-2 text-[11px]">
                        {g.proof}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <Separator className="my-8" />

      {/* Review queue */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            Review queue{' '}
            <span className="text-sm font-normal text-muted-foreground">
              ({health?.staging.length ?? items.length})
            </span>
          </h2>
          <div className="flex items-center gap-2 text-xs">
            <HealthChip label="Staging" state={health?.staging} />
            <HealthChip label="Prod" state={health?.prod} />
            <button
              type="button"
              onClick={loadQueue}
              className="text-muted-foreground underline-offset-2 hover:underline"
            >
              Refresh
            </button>
          </div>
        </div>

        {(health?.staging.error || health?.prod.error) && (
          <div className="mb-2 space-y-1 rounded-md border border-red-500/40 bg-red-500/5 p-2 text-[11px] text-red-500">
            {health?.staging.error && (
              <p>
                <span className="font-medium">Staging: </span>
                <span className="break-all font-mono">
                  {health.staging.error}
                </span>
              </p>
            )}
            {health?.prod.error && (
              <p>
                <span className="font-medium">Prod: </span>
                <span className="break-all font-mono">{health.prod.error}</span>
              </p>
            )}
          </div>
        )}

        <div className="space-y-2">
          {items.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {health && !health.staging.ok
                ? 'Staging Redis unreachable — see the error above.'
                : 'Queue is empty.'}
            </p>
          )}
          {items.map((it) => (
            <div key={it.id} className="rounded-lg border p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {it.questionTitle || it.problem || 'Untitled problem'}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {metaLine(it)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 px-2 text-xs"
                    disabled={busy === `promote:${it.id}` || !health?.prod.ok}
                    onClick={() => promoteItem(it.id)}
                    title={
                      health?.prod.ok
                        ? 'Publish to the production weekly-problems queue'
                        : 'Prod Redis unreachable'
                    }
                  >
                    {busy === `promote:${it.id}` ? '…' : 'Push to prod'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-red-500 hover:text-red-600"
                    disabled={busy === `del:${it.id}`}
                    onClick={() => removeItem(it.id)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <p className="mt-8 text-xs text-muted-foreground">
        Requires your bridge running (Local Agent → set it up). Verifying never
        auto-stages — “Add to staging” is manual. “Push to prod” publishes to
        the main CompeteMath queue and archives the Lean proof to the database.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: string;
}) {
  return (
    <div className="rounded-md border p-2">
      <div className={cn('text-lg font-semibold', tone)}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

function HealthChip({
  label,
  state,
}: {
  label: string;
  state?: { ok: boolean; length?: number; error?: string };
}) {
  const ok = state?.ok;
  return (
    <span
      className={cn(
        'flex items-center gap-1 rounded border px-1.5 py-0.5',
        ok === undefined
          ? 'text-muted-foreground'
          : ok
            ? 'border-emerald-500/40 text-emerald-600'
            : 'border-red-500/40 text-red-500',
      )}
      title={state?.error || undefined}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          ok === undefined
            ? 'bg-muted-foreground'
            : ok
              ? 'bg-emerald-500'
              : 'bg-red-500',
        )}
      />
      {label}
      {ok && state?.length != null ? ` · ${state.length}` : ''}
      {ok === false ? ' · error' : ''}
    </span>
  );
}
