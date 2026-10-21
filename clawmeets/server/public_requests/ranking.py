# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/public_requests/ranking.py

How well a public agent fits a plain-words request. Pure functions, no I/O:
the candidates come in already shaped (``candidates.Candidate``) and the
ranked list goes out; the browser only ever sees the result.

``fit`` (0-97) counts request terms that land in the agent's profile fields,
weighted per field; ``rep`` (0-40) is how many users retained it, on a log
scale. ``score = fit * 0.8 + rep * 0.2``. Agents under ``MIN_FIT`` are not
matches at all, and at most ``MAX_MATCHES`` come back.

Ratings do not exist, so ``rep`` is the retain-count term only, and an agent
on another server (whose retains this server cannot count) gets 0.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Iterable, Sequence

MIN_FIT = 20
MAX_MATCHES = 12
FIT_CAP = 97

#: Label (shown in "Why it matched") -> weight per term that hits it.
FIELD_WEIGHTS: dict[str, float] = {
    "Name": 2.0,
    "Expertise": 2.5,
    "Teams": 2.0,
    "Description": 1.0,
    "Starter questions": 1.0,
}
#: A whole expertise phrase ("offer negotiation") appearing in the request.
PHRASE_WEIGHT = 2.2

_STOPWORDS = frozenset("""
    the and for help what after one with that this from have has had are was were will would
    could should can you your yours our their them they there here about into over under than
    then when where which who whom why how all any some more most much many such very just only
    also not but its it's i'm i've get got make want need like please me my mine
""".split())
_SPLIT = re.compile(r"[^a-z0-9$]+")
_SUFFIXES = ("ations", "ation", "ings", "ing", "ions", "ion", "ers", "ed", "es", "er", "s", "e")


@dataclass(frozen=True)
class Candidate:
    """One public agent, in the shape ranking reads."""

    agent_ref: str
    name: str
    description: str = ""
    expertise: Sequence[str] = ()
    teams: Sequence[str] = ()
    starter_questions: Sequence[str] = ()
    retained_count: int = 0
    online: bool = False

    def fields(self) -> dict[str, str]:
        return {
            "Name": self.name.replace("-", " "),
            "Expertise": " ".join(self.expertise),
            "Teams": " ".join(self.teams),
            "Description": self.description,
            "Starter questions": " ".join(self.starter_questions),
        }


@dataclass(frozen=True)
class Ranked:
    candidate: Candidate
    fit: int
    rep: int
    score: float
    why: dict[str, list[str]] = field(default_factory=dict)


def _stem(word: str) -> str:
    for suffix in _SUFFIXES:
        if word.endswith(suffix) and len(word) - len(suffix) >= 4:
            return word[: -len(suffix)]
    return word


def stems(text: str) -> dict[str, str]:
    """The request's search terms: stem -> the word the user wrote, in
    first-seen order. Matching uses the stem, "Why it matched" the word."""
    out: dict[str, str] = {}
    for word in _SPLIT.split(text.lower()):
        word = word.strip("$")
        if len(word) <= 2 or word in _STOPWORDS or word.isdigit():
            continue
        out.setdefault(_stem(word), word)
    return out


def terms(text: str) -> list[str]:
    """The request's stemmed search terms, in first-seen order."""
    return list(stems(text))


def _hits(term: str, text: str) -> bool:
    """``term`` starts a word of ``text`` (so "negotiat" hits "negotiation")."""
    return re.search(r"(^|[^a-z0-9])" + re.escape(term), text) is not None


def why(candidate: Candidate, request_terms: Iterable[str]) -> dict[str, list[str]]:
    """Field label -> the request terms that hit it (fields with none left out)."""
    request_terms = list(request_terms)
    out: dict[str, list[str]] = {}
    for label, text in candidate.fields().items():
        lowered = text.lower()
        hits = [t for t in request_terms if _hits(t, lowered)]
        if hits:
            out[label] = hits
    return out


def phrase_hits(candidate: Candidate, request: str) -> list[str]:
    """Multi-word expertise phrases that appear whole in the request."""
    lowered = request.lower()
    return [p for p in candidate.expertise if " " in p.strip() and _hits(p.strip().lower(), lowered)]


def fit(candidate: Candidate, request: str) -> tuple[int, dict[str, list[str]]]:
    """The fit score and, per field, the request's own words that hit it."""
    words = stems(request)
    matched = why(candidate, words)
    s = len(phrase_hits(candidate, request)) * PHRASE_WEIGHT
    s += sum(len(hits) * FIELD_WEIGHTS[label] for label, hits in matched.items())
    shown = {label: [words[h] for h in hits] for label, hits in matched.items()}
    return min(FIT_CAP, round(100 * (1 - math.exp(-s / 9)))), shown


def rep(retained_count: int) -> int:
    return round(min(40.0, math.log10(max(0, retained_count) + 1) * 12))


def rank(candidates: Iterable[Candidate], request: str) -> list[Ranked]:
    """Matches, best first: fit >= MIN_FIT, at most MAX_MATCHES. Ties go to
    the agent that is online, then by name, so the order is stable."""
    out: list[Ranked] = []
    for c in candidates:
        f, matched = fit(c, request)
        if f < MIN_FIT:
            continue
        r = rep(c.retained_count)
        out.append(Ranked(candidate=c, fit=f, rep=r, score=round(f * 0.8 + r * 0.2, 2), why=matched))
    out.sort(key=lambda x: (-x.score, not x.candidate.online, x.candidate.name))
    return out[:MAX_MATCHES]
