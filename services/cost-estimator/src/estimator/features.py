"""Deterministic structural features extracted from a Lean 4 theorem signature.

No labels, no difficulty tag — everything here is computed from the theorem text
alone, which is exactly what production receives. These are a cheap "hardness
fingerprint" that complements the semantic embedding: quantifier structure,
logical connectives, the arithmetic surface, term size and nesting, and whether
the goal looks finitely `decide`-able.

Kept intentionally simple and regex-based (µs to run). The names are stable —
they become model feature columns, so append rather than reorder.
"""
from __future__ import annotations

import re
from typing import Dict

# Domain/type surface that tends to correlate with proof effort.
_TYPE_TOKENS = [
    "Nat", "Int", "Rat", "Real", "Complex", "Prime", "gcd", "lcm",
    "Finset", "Fintype", "Matrix", "Polynomial", "Set", "List",
    "deriv", "integral", "tendsto", "Continuous", "∑", "∏", "∫",
]

_NUM_RE = re.compile(r"\d+")
_BINDER_RE = re.compile(r"\([^()]*:[^()]*\)")
_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_']*")


def _count(hay: str, *needles: str) -> int:
    return sum(hay.count(n) for n in needles)


def _max_paren_depth(s: str) -> int:
    depth = mx = 0
    for ch in s:
        if ch in "([{":
            depth += 1
            mx = max(mx, depth)
        elif ch in ")]}":
            depth = max(0, depth - 1)
    return mx


def _quantifier_alternations(s: str) -> int:
    """Count ∀/∃ order switches — alternation depth is a classic hardness signal."""
    seq = [c for c in s if c in "∀∃"]
    return sum(1 for a, b in zip(seq, seq[1:]) if a != b)


def extract_features(signature: str) -> Dict[str, float]:
    s = signature or ""
    low = s
    nums = _NUM_RE.findall(s)
    max_num = max((len(n) for n in nums), default=0)  # digit-length ~ magnitude
    idents = _IDENT_RE.findall(s)
    binders = _BINDER_RE.findall(s)

    feats: Dict[str, float] = {
        "char_len": float(len(s)),
        "token_len": float(len(s.split())),
        "ident_count": float(len(idents)),
        "distinct_idents": float(len(set(idents))),
        "n_forall": float(_count(low, "∀", "\\forall")),
        "n_exists": float(_count(low, "∃", "\\exists")),
        "n_arrow": float(_count(low, "→", "->")),
        "n_iff": float(_count(low, "↔", "<->")),
        "n_and": float(_count(low, "∧", "/\\")),
        "n_or": float(_count(low, "∨", "\\/")),
        "n_not": float(_count(low, "¬")),
        "n_eq": float(low.count("=") - low.count("==") - low.count("!=")),
        "n_le_lt": float(_count(low, "≤", "≥", "<", ">")),
        "n_binders": float(len(binders)),
        "quant_alternations": float(_quantifier_alternations(s)),
        "paren_depth": float(_max_paren_depth(s)),
        "n_numerals": float(len(nums)),
        "max_numeral_digits": float(max_num),
        "has_decide": 1.0 if re.search(r"\b(?:decide|native_decide)\b", s) else 0.0,
        "has_sum_prod_int": 1.0 if _count(s, "∑", "∏", "∫") else 0.0,
        "n_operators": float(_count(low, "+", "-", "*", "/", "^", "%", "∣", "∘")),
    }
    for t in _TYPE_TOKENS:
        feats[f"has_{re.sub(chr(92)+'W', '_', t)}"] = 1.0 if t in s else 0.0
    return feats


# Stable, sorted feature order → the model's column layout.
FEATURE_NAMES = sorted(extract_features("theorem t : 1 = 1 := rfl").keys())


def feature_vector(signature: str):
    import numpy as np

    f = extract_features(signature)
    return np.array([f.get(name, 0.0) for name in FEATURE_NAMES], dtype="float32")
