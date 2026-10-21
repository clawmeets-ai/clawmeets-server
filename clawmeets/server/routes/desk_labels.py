# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/desk_labels.py

HTTP surface for the My Desk label registry — the owner's GTD contexts (see
``clawmeets/models/desk_label.py``). Every label is a context; the ``state``
kind is retired and whether an item's work is running is derived on the to-do
itself, as ``DeskTodo.state``.

- ``GET    /me/desk/labels``               — the owner's vocabulary, in order.
- ``POST   /me/desk/labels``               — create one ``{name, slug?, kind?, color?}``.
- ``PATCH  /me/desk/labels/{slug}``        — display name and/or colour, in place.
- ``POST   /me/desk/labels/reorder``       — ``{ordered_slugs: [...]}``.
- ``DELETE /me/desk/labels/{slug}``        — remove it, detaching from every to-do.
- ``POST   /me/desk/labels/{slug}/merge``  — ``{into}``; rewrites referencing to-dos.

Shapes mirror ``desk_sops.py`` one-for-one, so there is nothing new to learn
here. The two differences are both worth knowing about:

**The auth is deliberately asymmetric with the SOP library.** The GET is open
to any agent bearer, where every SOP verb including its read is assistant-only.
That is not an oversight: it lets a publishing agent check the owner's existing
vocabulary and write ``office`` instead of inventing ``desk``, which is the main
defence against fifty agents drifting the group list apart. Writes stay narrow
— owner JWT or the owner's own ``{username}-assistant``.

**delete and merge fan out TWO envelopes**, because they change two documents.
``DESK_TODO_SYNC`` goes first, mirroring the write order. See ``_broadcast_both``.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from fastapi import APIRouter, Header, HTTPException, Request

from clawmeets.api.control import (
    ControlEnvelope,
    ControlMessageType,
    DeskLabelSyncPayload,
    DeskTodoSyncPayload,
)
from clawmeets.models.desk_label import (
    create_label,
    delete_label,
    list_labels,
    merge_label,
    patch_label,
    reorder_labels,
)
from clawmeets.models.desk_todo import LabelError
from clawmeets.models.user import User

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")


def create_desk_labels_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["desk-labels"])

    def _dir():
        return ctx.model_ctx.participants_dir

    async def _principal(authorization: str) -> User:
        """Resolve the registry's owner from a write credential.

        Owner browser JWT or the owner's assistant bearer; every other agent
        token raises 401. This one call IS the whole narrowing for the five
        write verbs, so "who may curate the vocabulary" cannot drift between
        handlers.
        """
        return await ctx.auth.resolve_user_from_credential(authorization)

    async def _guard(coro):
        """ONE mapping point for the whole coded-error table.

        Every handler wraps its model call in this, so a code cannot be right in
        one route and mistyped in another, and the ``"<code>: <sentence>"``
        detail string is assembled in exactly one place in the codebase. The
        model already owns which status each condition carries (400 / 404 /
        409); this just forwards it.
        """
        try:
            return await coro
        except LabelError as e:
            raise HTTPException(e.status, str(e))

    async def _broadcast_labels(
        owner_user_id: str,
        action: str,
        slug: str | None = None,
        into: str | None = None,
    ) -> None:
        """Tell every live session this owner holds that the vocabulary moved."""
        envelope = ControlEnvelope(
            type=ControlMessageType.DESK_LABEL_SYNC,
            payload=DeskLabelSyncPayload(action=action, slug=slug, into=into),
        )
        delivered = await ctx.ws_hub.send_to(owner_user_id, envelope)
        if delivered:
            logger.info(f"Sent DESK_LABEL_SYNC({action}) to user {owner_user_id[:8]}")

    async def _broadcast_both(
        owner_user_id: str, action: str, slug: str, into: str | None = None
    ) -> None:
        """delete and merge change BOTH documents, so they send two envelopes.

        ORDER: ``DESK_TODO_SYNC`` first, then ``DESK_LABEL_SYNC``. It mirrors
        the write order, and the transient state it produces — the registry
        still listing a label no item carries — renders as an empty group the
        rail already handles. The reverse order produces the alarming transient
        instead: every chip resolving against a registry row that is already
        gone, i.e. rendered dashed-unregistered for a frame.

        The affected to-do ids are deliberately not enumerated: a delete can
        touch any number of rows, and the client refetches the whole plate
        anyway.
        """
        await ctx.ws_hub.send_to(
            owner_user_id,
            ControlEnvelope(
                type=ControlMessageType.DESK_TODO_SYNC,
                payload=DeskTodoSyncPayload(action="patch", id=None),
            ),
        )
        await _broadcast_labels(owner_user_id, action, slug, into)

    @router.get("/me/desk/labels")
    async def list_my_labels(
        authorization: str = Header(default=""),
        x_agent_id: str = Header(default="", alias="X-Agent-ID"),
    ):
        """The owner's registry in stored order, as ``{"labels": [...]}``.

        Owner JWT **or** any agent bearer + ``X-Agent-ID`` — the same call list
        ``list_my_todos`` makes.

        Best-effort: never 500s on content. An owner who has deleted every label
        gets a 200 holding an empty array — a legitimate empty vocabulary, NOT
        the same thing as a failed fetch. The client has to be able to tell
        those apart to know whether to draw an empty list or a load-failure
        notice; making sure it can is this endpoint's job.

        EVERY ROW COMES BACK ``kind: "context"``. The ``state`` kind is retired
        and ``list_labels`` projects a stored one onto ``context`` as it reads
        (``models/desk_label.py``). No row is rewritten on disk to make that
        true, so this response is a view of the owner's registry and not a
        report of its bytes — the only caller that needs the bytes is a write,
        and writes do not come through here.
        """
        owner_id = await ctx.auth.resolve_viewer(authorization, x_agent_id or None)
        if owner_id is None:
            raise HTTPException(401, "Authentication required")
        return {"labels": [r.model_dump() for r in list_labels(_dir(), owner_id)]}

    @router.post("/me/desk/labels")
    async def create_my_label(
        request: Request,
        authorization: str = Header(default=""),
    ):
        """Create one label. 409 on either collision direction.

        Every key is read off the RAW body rather than declared as a typed
        ``Body`` param, for the reason that governs this whole surface: a typed
        param answers a bad value with FastAPI's 422, whose ``detail`` is a LIST
        of dicts. The contract's client-side parse rule reads ``detail`` as a
        string, so one 422 anywhere in the label surface breaks it. Untyped in,
        hand-validated, coded 400 out.
        """
        user = await _principal(authorization)
        body = await _raw(request)
        label = await _guard(
            create_label(
                _dir(),
                user.id,
                name=_str(body.get("name")),
                slug=_str(body.get("slug")) or None,
                # Present-but-not-a-string must reach the model as an invalid
                # kind rather than collapsing to the default. Colour is
                # forgiving here because it is changeable afterwards; the kind
                # is IMMUTABLE, so silently filing a label on the wrong axis
                # costs a delete-and-re-add plus a manual re-apply.
                kind=body.get("kind", "context") if "kind" in body else "context",
                color=_str(body.get("color")) or None,
            )
        )
        await _broadcast_labels(user.id, "add", label.slug)
        return label.model_dump()

    @router.patch("/me/desk/labels/{slug}")
    async def patch_my_label(
        slug: str,
        request: Request,
        authorization: str = Header(default=""),
    ):
        """Change display name and/or colour. Never touches a to-do.

        Reads key PRESENCE off the raw body — same trick as ``patch_my_todo``
        and ``patch_my_sop``, and needed for the same reason plus one more:
        ``color: null`` must clear where an absent key must not, and a ``kind``
        echo must be distinguishable from an omitted one (an equal echo is an
        accepted no-op; a changed one is ``labels.kind_immutable``).
        """
        user = await _principal(authorization)
        body = await _raw(request)
        fields = {
            key: body[key] for key in ("name", "color", "kind") if key in body
        }
        label = await _guard(patch_label(_dir(), user.id, slug, **fields))
        await _broadcast_labels(user.id, "patch", label.slug)
        return label.model_dump()

    @router.post("/me/desk/labels/reorder")
    async def reorder_my_labels(
        request: Request,
        authorization: str = Header(default=""),
    ):
        """Rewrite the array to match ``ordered_slugs``. Position IS the
        ordering, so this verb is the ordering write. Unknown slugs are ignored
        and omitted rows are appended in prior order — not an error, exactly
        like ``reorder_todos``."""
        user = await _principal(authorization)
        body = await _raw(request)
        raw = body.get("ordered_slugs")
        if not isinstance(raw, list) or any(not isinstance(s, str) for s in raw):
            raise HTTPException(400, str(LabelError.invalid_type()))
        rows = await _guard(reorder_labels(_dir(), user.id, raw))
        await _broadcast_labels(user.id, "reorder", None)
        return {"labels": [r.model_dump() for r in rows]}

    @router.delete("/me/desk/labels/{slug}")
    async def delete_my_label(
        slug: str,
        authorization: str = Header(default=""),
    ):
        """Remove a label, detaching it from every to-do that carries it.

        ``detached_from`` is what the confirm dialog and the assistant read out
        — "it came off 6 items, all still on your plate". Two envelopes.
        """
        user = await _principal(authorization)
        label, detached = await _guard(delete_label(_dir(), user.id, slug))
        await _broadcast_both(user.id, "delete", label.slug)
        return {
            "status": "deleted",
            "slug": label.slug,
            "detached_from": detached,
        }

    @router.post("/me/desk/labels/{slug}/merge")
    async def merge_my_label(
        slug: str,
        request: Request,
        authorization: str = Header(default=""),
    ):
        """Fold ``slug`` into ``into`` on every referencing to-do, then drop the
        source row. Two envelopes.

        ``into`` on the response is what the originating tab reads to make its
        active filter follow the merge; the envelope's own ``into`` is what
        every OTHER tab reads for the same thing.
        """
        user = await _principal(authorization)
        body = await _raw(request)
        into = _str(body.get("into"))
        if not into:
            raise HTTPException(400, str(LabelError.invalid_type()))
        source, target, moved = await _guard(
            merge_label(_dir(), user.id, slug, into)
        )
        await _broadcast_both(user.id, "merge", source.slug, target.slug)
        return {
            "status": "merged",
            "from": source.slug,
            "into": target.slug,
            "moved": moved,
        }

    return router


async def _raw(request: Request) -> dict:
    """The request body as a plain dict, or empty. Never raises — a malformed
    body reaches the hand-validation below as an absent key, which produces a
    coded 400 rather than FastAPI's 422 envelope."""
    try:
        body = await request.json()
    except Exception:
        return {}
    return body if isinstance(body, dict) else {}


def _str(value: object) -> str:
    """A body value as a string, treating every other type — including null —
    as absent. The model owns what an empty value means for each key."""
    return value.strip() if isinstance(value, str) else ""
