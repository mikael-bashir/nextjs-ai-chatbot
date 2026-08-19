---
title: Leak XII
emoji: 🧮
colorFrom: blue
colorTo: green
sdk: docker
pinned: false
---

# Leak XII — `lean_compile` gateway

The Goedel-Architect blueprint compile gate: structural safeguards ->
warm-daemon Lean compile (Mathlib v4.32.0 + [LeanArchitect](https://github.com/hanwenzhu/LeanArchitect)
preloaded) -> blueprint graph validation. Node-mode canonical rebuild +
negation channel. See the `architect` strategy in
[nextjs-ai-chatbot](https://github.com/mikael-bashir/nextjs-ai-chatbot).

**First request after any cold start/wake takes ~1-2 min** while the Lean
daemon imports Mathlib. `/health` reports `ready` once warm.

Set the `LEAK_SERVICE_TOKEN` Space secret to require
`Authorization: Bearer <token>` on every request except `/health`.

Recommended hardware: `cpu-upgrade` (8 vCPU / 32 GB) — a single warm daemon
with Mathlib + Architect imported needs several GB resident.
