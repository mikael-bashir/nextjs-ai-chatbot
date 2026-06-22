"""
Hierarchical context management for the AI chat agent.

Architecture (applied in order):
  1. System messages      — always included verbatim
  2. First user message   — always pinned (original intent / task framing)
  3. Rolling summary      — replaces the compressed "middle" section
  4. Important anchors    — up to N high-scoring middle messages kept verbatim
  5. Recent window        — last K messages always verbatim

The rolling summary is generated lazily on the first compression event and
extended incrementally as the conversation grows — so the steady-state cost
is a small extension call, not a full re-summarise.

Summary calls use the free Grok model so no credits are ever spent here.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

logger = logging.getLogger(__name__)

# ── Tuning constants ──────────────────────────────────────────────────────────

RECENT_WINDOW = 10       # messages always kept verbatim at the tail
COMPRESS_AT = 16         # start compressing once conv exceeds this many messages
                         # (8 full turns before any pruning)
ANCHOR_COUNT = 3         # how many high-importance middle messages to keep verbatim
ANCHOR_MIN_SCORE = 1.5   # only anchor if importance score exceeds this
MAX_MSG_CHARS = 600      # truncation for individual messages in the summary prompt
SUMMARY_MAX_TOKENS = 600 # max tokens the summariser may produce
CACHE_TTL = 7_200        # 2 h in-memory TTL (seconds)

# ── In-memory cache ───────────────────────────────────────────────────────────
# key: "{chat_id}:{count_of_summarised_messages}"
# val: (summary_text, unix_timestamp)
_cache: dict[str, tuple[str, float]] = {}
_lock = asyncio.Lock()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _text(msg: dict) -> str:
    c = msg.get("content", "")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return " ".join(p.get("text", "") for p in c if isinstance(p, dict))
    return str(c)


def importance(msg: dict) -> float:
    """Heuristic importance score for a single message."""
    t = _text(msg).lower()
    s = 0.0

    # Code is extremely high value — exact syntax is easy to summarise badly
    s += t.count("```") * 3.5

    # Errors / tracebacks — agent needs the exact text
    if any(w in t for w in ("error:", "exception:", "traceback", "typeerror", "syntaxerror",
                             "valueerror", "failed to", "cannot", "undefined")):
        s += 3.0

    # Explicit user instructions
    if any(w in t for w in ("always ", "never ", "important:", "note:", "remember",
                             "must ", "do not", "don't", "please ensure", "make sure")):
        s += 2.5

    # URLs / file paths (often referenceable artefacts)
    if "http" in t or "/" in t or "\\" in t:
        s += 1.0

    # Questions set the agenda
    s += t.count("?") * 0.7

    # Structured lists carry information density
    if any(t.lstrip().startswith(p) for p in ("1.", "- ", "* ", "#")):
        s += 1.0

    # Length bonus (long messages tend to carry more info), capped at +2
    s += min(len(t) / 800, 2.0)

    return s


def _cache_key(chat_id: str, count: int) -> str:
    return f"{chat_id}:{count}"


def _evict(chat_id: str) -> None:
    now = time.time()
    dead = [k for k, (_, ts) in _cache.items()
            if k.startswith(f"{chat_id}:") and now - ts > CACHE_TTL]
    for k in dead:
        del _cache[k]


def _format_for_prompt(messages: list[dict]) -> str:
    lines = []
    for m in messages:
        role = m.get("role", "?").upper()
        text = _text(m)[:MAX_MSG_CHARS]
        if text.strip():
            lines.append(f"{role}: {text}")
    return "\n\n".join(lines)


# ── LLM calls ─────────────────────────────────────────────────────────────────

async def _llm(prompt: list[dict], model: str) -> str:
    """Single non-streaming LLM call for summarisation."""
    # Lazy import to avoid circular dependency
    from app.api.lib.leak_utils import llm_router
    try:
        resp = await llm_router.acompletion(
            model=model,
            messages=prompt,
            temperature=0.1,
            max_tokens=SUMMARY_MAX_TOKENS,
            stream=False,
        )
        return (resp.choices[0].message.content or "").strip()
    except Exception as exc:
        logger.warning(f"[ContextMgr] LLM summarisation error: {exc}")
        return ""


SUMMARISE_SYSTEM = (
    "You are a conversation summariser embedded in an AI assistant. "
    "Given a conversation excerpt, extract ALL key facts, decisions, code snippets, "
    "errors, variable names, and important context. "
    "Write a dense bulleted summary that another AI could use as a drop-in replacement "
    "for the original messages. Preserve exact technical details."
)

EXTEND_SYSTEM = (
    "You are a conversation summariser embedded in an AI assistant. "
    "You have an existing summary and must incorporate new conversation content into it. "
    "Preserve every fact from the existing summary and add important new information. "
    "Remove or merge redundant points. Keep it dense and precise."
)


async def _fresh_summary(messages: list[dict], model: str) -> str:
    text = _format_for_prompt(messages)
    if not text.strip():
        return ""
    return await _llm([
        {"role": "system", "content": SUMMARISE_SYSTEM},
        {"role": "user", "content": f"Summarise this conversation:\n\n{text}"},
    ], model)


async def _extend_summary(existing: str, new_messages: list[dict], model: str) -> str:
    if not new_messages:
        return existing
    new_text = _format_for_prompt(new_messages)
    if not new_text.strip():
        return existing
    return await _llm([
        {"role": "system", "content": EXTEND_SYSTEM},
        {"role": "user", "content": (
            f"Existing summary:\n{existing}\n\n"
            f"New conversation to add:\n{new_text}\n\n"
            f"Write the updated summary:"
        )},
    ], model)


# ── Main entry point ──────────────────────────────────────────────────────────

async def build_context(
    messages: list[dict],
    chat_id: str,
    model: str = "grok-free-pool",
) -> list[dict]:
    """
    Return an optimised version of messages for the given conversation.
    Returns messages unchanged if compression is not yet needed.
    """
    system_msgs = [m for m in messages if m.get("role") == "system"]
    conv_msgs   = [m for m in messages if m.get("role") != "system"]

    # Short conversation — nothing to do
    if len(conv_msgs) <= COMPRESS_AT:
        return messages

    # ── Partition ──────────────────────────────────────────────────────────
    first  = conv_msgs[:1]                    # pin original framing
    middle = conv_msgs[1:-RECENT_WINDOW]      # candidates for compression
    recent = conv_msgs[-RECENT_WINDOW:]       # always verbatim

    mid_count = len(middle)

    # ── Get or generate the rolling summary ───────────────────────────────
    async with _lock:
        _evict(chat_id)
        key = _cache_key(chat_id, mid_count)

        if key in _cache:
            summary, _ = _cache[key]
            logger.info(f"[ContextMgr] cache hit {key}")
        else:
            # Find the best existing partial summary to extend from
            existing_entries = sorted(
                [(k, v) for k, v in _cache.items() if k.startswith(f"{chat_id}:")],
                key=lambda x: int(x[0].split(":", 1)[1]),
            )

            if existing_entries:
                prev_key, (prev_summary, _) = existing_entries[-1]
                prev_count = int(prev_key.split(":", 1)[1])
                delta = middle[prev_count:]  # only new messages since last summary
                logger.info(
                    f"[ContextMgr] extending {chat_id}: {prev_count} → {mid_count} "
                    f"({len(delta)} new msgs)"
                )
                summary = await _extend_summary(prev_summary, delta, model)
            else:
                logger.info(f"[ContextMgr] fresh summary {chat_id}: {mid_count} msgs")
                summary = await _fresh_summary(middle, model)

            _cache[key] = (summary, time.time())

    # ── Select importance anchors from middle ──────────────────────────────
    # High-scoring messages that are better kept verbatim than paraphrased
    scored = sorted(enumerate(middle), key=lambda x: importance(x[1]), reverse=True)
    anchor_idxs: set[int] = set()
    for idx, msg in scored[:ANCHOR_COUNT]:
        if importance(msg) >= ANCHOR_MIN_SCORE:
            anchor_idxs.add(idx)
    anchors = [middle[i] for i in sorted(anchor_idxs)]

    # ── Assemble final context ─────────────────────────────────────────────
    result: list[dict] = []
    result.extend(system_msgs)
    result.extend(first)

    if summary:
        result.append({
            "role": "system",
            "content": (
                "[EARLIER CONVERSATION — key points extracted by context manager]\n"
                + summary
            ),
        })

    result.extend(anchors)
    result.extend(recent)

    logger.info(
        f"[ContextMgr] {len(messages)} msgs → {len(result)} msgs "
        f"({len(anchors)} anchors, {len(recent)} recent)"
    )
    return result
