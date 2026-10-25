# SPDX-License-Identifier: MIT
"""
clawmeets/models/public_request.py

A user's public request: one plain-words ask, the agents the hub picked for
it, and what happened with each.

Each sent match points at the ordinary thread that carries the conversation
(a same-server Front Desk thread or a hub thread), so answers and replies live
where every other conversation lives. This record holds only what no thread
knows: the hub's picks at the time of asking, who was sent to, and what the
user dismissed or used. The agent card is snapshotted so the list reads the
same later.

The hub is the only ranker. Each hub match's thread is the ask's
pre-committed slot, ``p_fit`` is the hub's estimate that the agent can help
(``fit`` is the same as a whole percent), and ``answer_yourself`` means no
agent clearly fit so the user's own assistant got the request, in
``fallback_project_id``.

Persisted one file per request at
``{server_dir}/public-requests/<user_id>/<request_id>.json``.
"""
from __future__ import annotations

import re
import uuid
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, Field, ValidationError

from clawmeets.utils.file_io import FileUtil

PUBLIC_REQUESTS_DIR = "public-requests"
MAX_TEXT = 4000

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


class RequestMatch(BaseModel):
    #: The agent's id in the retain routes (``{genesis}~{name}`` / ``local:{id}``).
    agent_ref: str
    kind: Literal["local", "hub"]
    #: The local agent's id; None for an agent on another server.
    agent_id: Optional[str] = None
    name: str
    display_name: str
    owner: str
    #: The hub agent's server, as its listing names it (hub matches only).
    deployment_name: Optional[str] = None
    description: str = ""
    expertise: list[str] = Field(default_factory=list)
    teams: list[str] = Field(default_factory=list)
    retained_count: int = 0
    online: bool = False
    #: ``p_fit`` as a whole percent, and the hub's rank score.
    fit: int
    score: float
    #: The thread the request went out on; None until sent.
    project_id: Optional[str] = None
    sent_at: Optional[float] = None
    #: Why sending failed (an error code), when it did.
    send_error: Optional[str] = None
    dismissed: bool = False
    #: The ask slot (= the thread's project id for a hub agent), the ask and
    #: plan that picked it, and the hub's fit estimate (0..1).
    slot: Optional[str] = None
    ask_id: Optional[str] = None
    plan_id: Optional[str] = None
    p_fit: Optional[float] = None
    #: The user picked this agent's answer ("Use this answer").
    used: bool = False
    #: Outcome kinds already reported to the hub for this match.
    outcomes_reported: list[str] = Field(default_factory=list)


class PublicRequest(BaseModel):
    id: str
    user_id: str
    text: str
    created_at: float
    #: Rank order, best first. Never reordered after creation.
    matches: list[RequestMatch] = Field(default_factory=list)
    #: The first ask and its plan.
    ask_id: Optional[str] = None
    plan_id: Optional[str] = None
    #: No agent clearly fit: the request went to the user's own assistant.
    answer_yourself: bool = False
    fallback_project_id: Optional[str] = None
    #: The assistant that got it (its DM thread is ``fallback_project_id``).
    fallback_agent_name: Optional[str] = None

    def match(self, agent_ref: str) -> Optional[RequestMatch]:
        return next((m for m in self.matches if m.agent_ref == agent_ref), None)


def new_id() -> str:
    return uuid.uuid4().hex


def _dir(base_dir: Path, user_id: str) -> Path:
    if not _ID_RE.match(user_id or ""):
        raise ValueError(f"invalid user id {user_id!r}")
    return Path(base_dir) / PUBLIC_REQUESTS_DIR / user_id


def load(base_dir: Path, user_id: str, request_id: str) -> Optional[PublicRequest]:
    if not _ID_RE.match(request_id or ""):
        return None
    data = FileUtil.read(_dir(base_dir, user_id) / f"{request_id}.json", "json")
    return PublicRequest.model_validate(data) if isinstance(data, dict) else None


def save(base_dir: Path, request: PublicRequest) -> PublicRequest:
    FileUtil.write(_dir(base_dir, request.user_id) / f"{request.id}.json",
                   request.model_dump(mode="json"), "json")
    return request


def list_for(base_dir: Path, user_id: str) -> list[PublicRequest]:
    """The user's requests, newest first."""
    folder = _dir(base_dir, user_id)
    out = []
    for name in FileUtil.list_dir(folder):
        if not name.endswith(".json"):
            continue
        data = FileUtil.read(folder / name, "json")
        if not isinstance(data, dict):
            continue
        try:
            out.append(PublicRequest.model_validate(data))
        except ValidationError:
            continue                                # a record this build cannot read
    out.sort(key=lambda r: r.created_at, reverse=True)
    return out
