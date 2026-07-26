---
title: Leak XIV
emoji: 🏁
colorFrom: green
colorTo: yellow
sdk: docker
app_port: 8014
pinned: false
---

# Leak XIV — assembly verifier

The certification gate for the Goedel-Architect pipeline: compiles the fully
assembled, sorry-free final proof end-to-end against Mathlib v4.32.0. The
only exit that counts — node solves and model prose are advisory. See the
`architect` strategy in
[nextjs-ai-chatbot](https://github.com/mikael-bashir/nextjs-ai-chatbot).

Internally lazy (warms its Lean daemon on first `/verify`, naps after 15 min
idle) — this saves RAM inside the Space's own hardware allocation; the
Space-level sleep timer is what actually stops billing.

Set the `LEAK_SERVICE_TOKEN` Space secret to require
`Authorization: Bearer <token>` on every request except `/health`.
