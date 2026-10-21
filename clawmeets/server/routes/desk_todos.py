# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/desk_todos.py

Desk to-do routes — the My Desk right-rail plate. User-scoped tasks that
are either captured by the owner or published by one of their agents.

Routes:

- ``GET  /me/desk/todos`` — user JWT (browser); the owner's ordered plate.
- ``POST /me/desk/todos`` — user JWT; capture a task ``{text, labels?}``.
- ``PATCH /me/desk/todos/{id}`` — user JWT **or the owner's assistant bearer**;
  partial update (archive it, save a draft + its recipient, edit text).
  ``draft_recipient_id`` / ``draft_recipient_name`` are three-way: key absent →
  untouched, JSON null → clear, string → set.
- ``GET /me/desk/todos/{id}/attachments/{attachment_id}`` — user JWT **or the
  owner's assistant bearer**; the stored raw bytes, with the stored
  ``content_type`` and a ``Content-Disposition`` naming the original filename.
- ``POST /me/desk/todos/{id}/projects`` — user JWT **or the owner's
  assistant**; ``{project_id}``. Link a project or DM thread to a to-do.
- ``DELETE /me/desk/todos/{id}/projects/{project_id}`` — same auth; unlink one.
- ``GET /me/desk/todos/{id}/projects`` — same auth; the to-do's associations,
  resolved, with dangling ids listed rather than hidden.
- ``POST /me/desk/todos/reorder`` — user JWT; ``{ordered_ids: [...]}``.
- ``DELETE /me/desk/todos/{id}`` — user JWT, the publishing agent, or the
  owner's assistant (which may retract any item on its owner's plate).
- ``PUT  /me/desk/todos`` — **agent token** (``Authorization: Bearer
  <agent_token>`` + ``X-Agent-ID``). Server resolves
  ``owner_user_id = Agent(agent_id).registered_by``, records the agent as
  the publisher (``by_agent_id``, hidden; used only for delete authorization),
  resolves ``suggest`` in the owner's namespace into
  ``draft_recipient_id`` / ``draft_recipient_name``, and pushes the task onto
  the owner's plate. Publish accepts only ``text``, ``labels``,
  ``draft_prompt`` and ``suggest`` — what the owner sees and can edit.

Every mutation pushes ``DESK_TODO_SYNC`` to the owner so the desk refetches.

**Attachments** are real stored bytes, written only by the owner. Bytes ride
PATCH base64-inlined on
the same request as the rest of the save, so the write is atomic — there is no
"text saved but files did not" state to write a message for. PATCH carries the
COMPLETE desired state as one ordered array of ``{keep: id}`` and
``{filename, content_b64}`` entries; anything stored whose id is absent is
deleted, which is what makes the shape structurally duplicate-proof. The key
being absent from the body means untouched, so a done-toggle or a label edit
can never nuke a to-do's files. ``PUT`` publish does NOT accept attachments —
an agent may never park bytes on its owner's plate.

**Labels.** All three write paths accept ``labels`` and PATCH additionally
accepts ``add_labels`` / ``remove_labels``. Every label key is read UNTYPED —
``Any`` on POST/PUT, raw-body key presence on PATCH — so that a bad value
produces the contract's coded 400 string rather than FastAPI's 422, whose
``detail`` is a list and would break the client's one-line parse rule.

The two owner-authenticated paths — POST and PATCH — also **auto-register** any
slug with no registry row, and emit one ``DESK_LABEL_SYNC`` per row created. PUT
publish deliberately does NOT: an agent's label lands on the item and renders as
an unregistered dashed chip until the owner adopts it. The item is the agent's
to write; the vocabulary is the owner's to curate.
"""
from __future__ import annotations

import base64
import logging
from typing import TYPE_CHECKING, Any
from urllib.parse import quote as _urlquote

from fastapi import APIRouter, Body, Header, HTTPException, Request, Response

from clawmeets.api.control import (
    ControlEnvelope,
    ControlMessageType,
    DeskLabelSyncPayload,
    DeskTodoSyncPayload,
)
from clawmeets.models.agent import Agent
from clawmeets.models.desk_label import auto_register
from clawmeets.models.desk_todo import (
    AttachmentError,
    add_todo,
    associate_todo,
    delete_todo,
    dissociate_todo,
    get_todo,
    guess_content_type,
    list_todos,
    normalize_attachment_name,
    patch_todo,
    read_attachment_blob,
    publish_agent_todo,
    reorder_todos,
    todo_files_dir,
)
from clawmeets.models.desk_todo_link import (
    AssociationRefused,
    as_wire,
    check_association_target,
    resolve_associations,
)
from clawmeets.models.project import Project
from clawmeets.server.routes._batch import accessible_projects
from clawmeets.server.routes.files import _check_upload_size, _validate_filename
from clawmeets.server.routes.messages import _max_message_attachments_bytes

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")


def create_desk_todos_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["desk-todos"])

    def _dir():
        return ctx.model_ctx.participants_dir

    async def _resolve_agent_caller(authorization: str, x_agent_id: str) -> Agent:
        if not x_agent_id:
            raise HTTPException(401, "Missing X-Agent-ID header")
        await ctx.auth.check_agent_token(x_agent_id, authorization)
        agent = Agent.get(x_agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {x_agent_id!r} not found")
        if not agent.registered_by:
            raise HTTPException(
                400, f"Agent {agent.name!r} has no owner — cannot publish to-dos"
            )
        return agent

    def _decode_attachment_entries(raw: object, todo_id: str, owner_user_id: str) -> list[dict]:
        """Validate + decode the inbound desired-state array, returning the
        model's input form: ``{"keep": id}`` passes through, everything else
        becomes ``{"name", "raw", "content_type"}``.

        Raises ``HTTPException`` with a PLAIN-STRING ``detail`` on every
        failure. That is not a style preference: the client parses ``detail`` as
        one line and renders it verbatim, and FastAPI's own 422 carries a LIST
        of dicts — which is exactly why ``attachments`` is read untyped off the
        raw body rather than declared as a typed ``Body`` param, the same rule
        the three label keys and the recipient pair already follow.

        Per entry, in order: shape, base64, filename, per-file size, type.
        ``_validate_filename`` is not needed for path safety — no client string
        ever reaches a path segment here — but the name IS echoed back in a
        ``Content-Disposition`` header by the download route, so it is rejected
        outright before ``normalize_attachment_name`` scrubs what survives.

        NOT checked here: the per-to-do total. That is a property of the
        post-reconcile STORED set, so it needs the plate, so it belongs inside
        the lock — the model checks it. This function only ever sees new bytes.

        Why this lives in the route and not the model: ``_check_upload_size``
        and ``_validate_filename`` come from ``server/routes/files.py``, which
        is NOT shipped in the runner wheel, while ``models/desk_todo.py`` IS.
        Importing them from the model would install cleanly and crash on first
        use on every released runner.
        """
        shape_error = (
            "attachments must be a list of {keep} or {filename, content_b64} entries"
        )
        if raw is None:
            return []
        if not isinstance(raw, list):
            raise HTTPException(400, shape_error)

        files_dir = todo_files_dir(_dir(), owner_user_id, todo_id)
        out: list[dict] = []
        for entry in raw:
            if not isinstance(entry, dict):
                raise HTTPException(400, shape_error)
            if "keep" in entry:
                keep = entry["keep"]
                if not isinstance(keep, str) or not keep:
                    raise HTTPException(400, shape_error)
                out.append({"keep": keep})
                continue
            filename = entry.get("filename")
            content_b64 = entry.get("content_b64")
            if not isinstance(filename, str) or not isinstance(content_b64, str):
                raise HTTPException(400, shape_error)
            try:
                blob = base64.b64decode(content_b64, validate=True)
            except (ValueError, TypeError):
                raise HTTPException(400, f"file {filename!r} is not valid base64")
            try:
                _validate_filename(filename, files_dir)
            except ValueError as e:
                raise HTTPException(400, str(e))
            _check_upload_size(blob, filename)
            name = normalize_attachment_name(filename)
            out.append(
                {"name": name, "raw": blob, "content_type": guess_content_type(name)}
            )
        return out


    async def _broadcast(owner_user_id: str, action: str, todo_id: str | None) -> None:
        envelope = ControlEnvelope(
            type=ControlMessageType.DESK_TODO_SYNC,
            payload=DeskTodoSyncPayload(action=action, id=todo_id),
        )
        delivered = await ctx.ws_hub.send_to(owner_user_id, envelope)
        if delivered:
            logger.info(
                f"Sent DESK_TODO_SYNC({action}) to user {owner_user_id[:8]}"
            )

    async def _auto_register(owner_user_id: str, slugs: list[str]) -> None:
        """Adopt any unregistered slug the owner just wrote, and tell their other
        tabs about it.

        Called ONLY from the two owner-authenticated paths. Best-effort by
        contract — ``auto_register`` never raises, because the to-do write has
        already succeeded and must not be failed by a bookkeeping side effect.

        The envelope matters more than it looks: without it, a client that wires
        its registry refetch only to the six registry endpoints holds a stale
        registry after its OWN capture, and renders a label it just adopted as
        dashed-unregistered.
        """
        for slug in await auto_register(_dir(), owner_user_id, slugs):
            await ctx.ws_hub.send_to(
                owner_user_id,
                ControlEnvelope(
                    type=ControlMessageType.DESK_LABEL_SYNC,
                    payload=DeskLabelSyncPayload(action="add", slug=slug),
                ),
            )

    @router.get("/me/desk/todos")
    async def list_my_todos(
        authorization: str = Header(default=""),
        x_agent_id: str = Header(default="", alias="X-Agent-ID"),
    ):
        """List the owner's plate. User JWT (browser) OR agent bearer +
        ``X-Agent-ID`` (agent CLI introspection); the agent path maps to the
        agent's owner."""
        owner_id = await ctx.auth.resolve_viewer(authorization, x_agent_id or None)
        if owner_id is None:
            raise HTTPException(401, "Authentication required")
        return as_wire(list_todos(_dir(), owner_id), ctx.model_ctx)

    @router.post("/me/desk/todos")
    async def capture_todo(
        text: str = Body(..., embed=True),
        labels: Any = Body(default=None, embed=True),
        authorization: str = Header(default=""),
    ):
        """Capture a task. Owner JWT.

        ``labels`` is declared ``Any`` ON PURPOSE: a ``list[str]`` annotation
        makes FastAPI answer a non-list with a 422 whose ``detail`` is a LIST OF
        DICTS, which breaks the contract's client-side parse rule. Untyped plus
        the model's ``normalize_labels`` means every label failure on every path
        is a coded 400 string. Same on PUT.
        """
        user = await ctx.auth.get_current_user(authorization)
        try:
            todo = await add_todo(_dir(), user.id, text, labels=labels)
        except ValueError as e:
            raise HTTPException(400, str(e))
        await _broadcast(user.id, "add", todo.id)
        await _auto_register(user.id, todo.labels)
        return as_wire([todo], ctx.model_ctx)[0]

    @router.patch("/me/desk/todos/{todo_id}")
    async def patch_my_todo(
        todo_id: str,
        request: Request,
        archived: bool | None = Body(default=None, embed=True),
        text: str | None = Body(default=None, embed=True),
        draft_prompt: str | None = Body(default=None, embed=True),
        drafted: bool | None = Body(default=None, embed=True),
        authorization: str = Header(default=""),
    ):
        """Partially update a to-do on the owner's plate.

        Accepts the owner's browser JWT **or** the owner's own
        ``{username}-assistant`` bearer, which is what lets "mark the Provi PO
        one away" work from a DM (``clawmeets todo archive <id>``). Every other
        agent's token fails to resolve and gets 401 — the plate stays
        publish-only for the other 49 agents."""
        user = await ctx.auth.resolve_user_from_credential(authorization)
        # draft_recipient_* are three-way (absent → untouched, null → clear,
        # string → set), so we detect key *presence* off the raw body rather
        # than a Body default — FastAPI can't carry a non-serializable sentinel
        # default, and a plain None default can't distinguish absent from null.
        try:
            body = await request.json()
        except Exception:
            body = {}
        recipient_fields: dict[str, str | None] = {}
        # The three label keys ride the SAME key-presence block, for the same
        # reason plus one more. `labels` is three-way exactly like the recipient
        # pair — absent leaves the stored list alone, null or [] clears, a list
        # replaces. `add_labels` / `remove_labels` need no three-way handling
        # (absent and empty both mean no-op) but are still read from the raw body
        # rather than declared as `list[str]` params, because a typed param
        # answers a non-list with FastAPI's 422 and its LIST-shaped `detail`.
        # Values are passed through UNVALIDATED — normalize_labels owns the type
        # check and raises the coded 400.
        label_fields: dict[str, object] = {}
        # `attachments` rides the SAME raw-body key-presence block, for the same
        # two reasons plus one more. It is three-way — absent leaves the stored
        # files alone (a done-toggle or a label edit must never nuke them), null
        # or [] removes all, a list reconciles to exactly that desired state —
        # and a typed param would answer a bad value with FastAPI's 422 and its
        # LIST-shaped `detail`. The extra reason: absence is also the DELETE
        # signal inside a list, so "key absent" and "empty list" mean opposite
        # things here and collapsing them would silently destroy files.
        attachment_fields: dict[str, object] = {}
        if isinstance(body, dict):
            # RUNNER-WHEEL SKEW ONLY, not general compatibility. The runner
            # wheel versions independently of the server, so an OLD runner
            # sends {"status": "done"} to a NEW server. Ignoring it silently
            # would be a 200 that changes nothing on the owner's plate — the
            # worst failure shape available here, because the owner is told the
            # to-do was filed away and it was not. `archived` always wins when
            # both are present. Retired in the same release as the hidden
            # `todo done` / `todo reopen` CLI aliases.
            if archived is None and isinstance(body.get("status"), str):
                archived = body["status"] == "done"
                logger.warning(
                    "PATCH /me/desk/todos: legacy 'status' key mapped to "
                    "'archived' — the sender is an out-of-date runner wheel"
                )
            for key in ("draft_recipient_id", "draft_recipient_name"):
                if key in body:
                    val = body[key]
                    recipient_fields[key] = val if isinstance(val, str) else None
            for key in ("labels", "add_labels", "remove_labels"):
                if key in body:
                    label_fields[key] = body[key]
            if "attachments" in body:
                attachment_fields["attachments"] = _decode_attachment_entries(
                    body["attachments"], todo_id, user.id
                )
                attachment_fields["total_limit"] = _max_message_attachments_bytes()
        try:
            todo = await patch_todo(
                _dir(),
                user.id,
                todo_id,
                archived=archived,
                text=text,
                draft_prompt=draft_prompt,
                drafted=drafted,
                **recipient_fields,
                **label_fields,
                **attachment_fields,
            )
        # Before the broad `except ValueError`, or a 413 would degrade into a
        # 400 — AttachmentError subclasses ValueError precisely so that a
        # forgotten clause fails safe, not so that this one can be omitted.
        except AttachmentError as e:
            raise HTTPException(e.status, str(e))
        except ValueError as e:
            raise HTTPException(400, str(e))
        if todo is None:
            raise HTTPException(404, f"To-do {todo_id!r} not found")
        await _broadcast(user.id, "patch", todo.id)
        await _auto_register(user.id, todo.labels)
        # The derivation runs even on a bare archive toggle that changed no
        # association: one batched lookup over THIS row's ids, not zero. A row
        # with no ids costs no disk work at all.
        return as_wire([todo], ctx.model_ctx)[0]

    def _content_disposition(name: str) -> str:
        """Build ``attachment; filename="<ascii>"; filename*=UTF-8''<pct>``.

        BOTH parameters, always, and the second one is not decoration. Starlette
        encodes response headers as latin-1, so a stored name with any
        non-ASCII character — a CJK filename, a curly apostrophe, an accented
        letter — turns a working download into a 500 on encode. The ASCII
        fallback (non-ASCII, plus ``"`` and ``\\``, replaced by ``_``) is what
        makes the header encodable at all; ``filename*`` is what makes the real
        name survive to a client that understands RFC 6266 — and every current
        browser prefers it when present.
        """
        ascii_name = "".join(
            "_" if (ord(ch) > 126 or ch in '"\\') else ch for ch in name
        ) or "file"
        return (
            f'attachment; filename="{ascii_name}"; '
            f"filename*=UTF-8''{_urlquote(name, safe='')}"
        )

    @router.get("/me/desk/todos/{todo_id}/attachments/{attachment_id}")
    async def download_todo_attachment(
        todo_id: str,
        attachment_id: str,
        authorization: str = Header(default=""),
    ) -> Response:
        """Serve one stored attachment's raw bytes to its owner.

        Auth is ``resolve_user_from_credential`` — the owner's browser JWT OR
        the owner's own ``{username}-assistant`` bearer — which is PATCH's auth
        and nothing wider. Every other agent's token fails to resolve and gets
        401: the plate stays publish-only for the other 49 agents, and their
        tokens cannot read a user's private files.

        The route is user-scoped, so the owner is DERIVED from the credential
        and the lookup is ``get_todo(dir, user.id, todo_id)``. A foreign user's
        JWT therefore searches THEIR OWN plate, finds nothing, and gets 404 — it
        never learns whether that to-do id exists at all. 403 is not reachable
        here without scanning other users' plates to establish that the id
        exists somewhere, which would turn this route into an existence oracle
        for other people's to-do ids; 404 is both the natural answer and the
        privacy-correct one.

        404 on three conditions, deliberately indistinguishable: unknown to-do,
        unknown attachment id, and a descriptor whose bytes are missing from
        disk — the last being the broken-chip case the design surfaces on
        purpose rather than papering over.

        Returns the STORED ``content_type``, not a re-guess of the name: the
        guess already happened once, at store time, over the normalized name,
        and a second guess could disagree with the row that was sha256'd.

        Not inlined into ``GET /me/desk/todos`` on purpose — that endpoint
        refetches on every ``DESK_TODO_SYNC``, and putting 20 MB of base64 into
        a list that reloads on every plate mutation is a different product.
        """
        user = await ctx.auth.resolve_user_from_credential(authorization)
        todo = get_todo(_dir(), user.id, todo_id)
        if todo is None:
            raise HTTPException(404, f"To-do {todo_id!r} not found")
        descriptor = next(
            (a for a in todo.attachments if a.id == attachment_id), None
        )
        if descriptor is None:
            raise HTTPException(404, f"Attachment {attachment_id!r} not found")
        raw = read_attachment_blob(_dir(), user.id, todo_id, attachment_id)
        if raw is None:
            raise HTTPException(404, f"Attachment {attachment_id!r} not found")
        return Response(
            content=raw,
            media_type=descriptor.content_type,
            headers={"Content-Disposition": _content_disposition(descriptor.name)},
        )


    # =====================================================================
    # Associations — a to-do and the projects (or DM threads) it spawned.
    #
    # All three take PATCH's auth and nothing wider:
    # ``resolve_user_from_credential`` accepts the owner's browser JWT or the
    # owner's own ``{username}-assistant`` bearer. Every other agent's token
    # fails to resolve and gets 401, which keeps the plate publish-only for the
    # other 49 agents — an agent may put work ON its owner's desk, never wire
    # up what that desk points at.
    #
    # The route owns authorization and the model owns the write, and the split
    # is forced rather than tidy: the visibility predicate lives in
    # ``routes/_batch.py``, which is BUSL and is NOT shipped in the runner
    # wheel, while ``models/desk_todo_link.py`` IS. A model importing it would
    # install cleanly and crash on first use on every released runner.
    # =====================================================================

    async def _load_target(user_id: str, todo_id: str):
        todo = get_todo(_dir(), user_id, todo_id)
        if todo is None:
            raise HTTPException(404, f"To-do {todo_id!r} not found")
        return todo

    @router.post("/me/desk/todos/{todo_id}/projects")
    async def associate_project(
        todo_id: str,
        project_id: str = Body(..., embed=True),
        authorization: str = Header(default=""),
    ):
        """Link a project or DM thread to a to-do. Returns the to-do in wire
        shape, so the caller sees the ``state`` its own write just produced.

        Resolution and authorization, in this order, producing exactly two
        refusal sentences and no generic one (AC-3.5):

        1. the to-do is gone                      -> 404 ``To-do '…' not found``
        2. the id resolves to nothing, **or** resolves but this owner cannot
           see it                                 -> 404, sentence A
        3. visible but ``created_by != user.id``  -> 403, sentence B
        4. otherwise                              -> associate + broadcast

        Clauses 2 and 3 are decided by
        :func:`~clawmeets.models.desk_todo_link.check_association_target`, which
        owns both sentences so they cannot be phrased one way here and another
        way at the next call site. They are BARE — no ``labels.<code>:`` prefix
        — because that prefix exists for the browser to dispatch on and rewrite
        the copy, and neither of these has that shape: the 404 already names the
        id the owner typed and the 403 already names the project.

        Clause 2 is deliberately ONE answer for two different facts. Splitting
        them would make this route an existence oracle for other people's
        project ids, which is the same reason the attachment download route
        above answers 404 rather than 403.

        Clause 3 is the RENAME predicate (``created_by == user.id``),
        deliberately not the wider "can see it" predicate — a project shared to
        the owner as a viewer is visible and still refused. That scoping is what
        keeps "which to-dos does this project affect?" answerable from one file
        read with no reverse index, because the only plate that can reference a
        project is its creator's.

        A DM-thread id passes untouched and is never refused as "not a project":
        ``_create_own_dm_thread_project`` writes ``created_by = user.id``, so an
        own-DM thread satisfies clause 3 by construction. That matters because
        the desk's **command** button spawns a DM thread and it is the feature's
        most common creation path (AC-3.3).

        IDEMPOTENT: associating a project the to-do already carries is a 200
        no-op, not a 409 — the same rule ``add_labels`` follows and for the same
        reason, that the owner's assistant retries commands.
        """
        user = await ctx.auth.resolve_user_from_credential(authorization)
        await _load_target(user.id, todo_id)

        requested = (project_id or "").strip()
        if not requested:
            raise HTTPException(400, "project_id cannot be empty")

        # Resolve, then filter by visibility, then hand the decision to the
        # model. `accessible_projects` returns {} for an id the owner may not
        # see, which collapses to the same `None` an unresolvable id gives —
        # which is exactly the 404-covers-both rule above, expressed as data
        # rather than as a branch.
        resolved = Project.get_many([requested], ctx.model_ctx)
        visible = accessible_projects(resolved, user, ctx.model_ctx)
        try:
            check_association_target(visible.get(requested), user.id, requested)
        except AssociationRefused as e:
            raise HTTPException(e.status, e.sentence)

        todo = await associate_todo(_dir(), user.id, todo_id, requested)
        if todo is None:
            raise HTTPException(404, f"To-do {todo_id!r} not found")
        await _broadcast(user.id, "associate", todo.id)
        return as_wire([todo], ctx.model_ctx)[0]

    @router.delete("/me/desk/todos/{todo_id}/projects/{project_id}")
    async def dissociate_project(
        todo_id: str,
        project_id: str,
        authorization: str = Header(default=""),
    ):
        """Unlink a project from a to-do. Returns the to-do in wire shape.

        **Takes NO ownership check, on purpose.** Removing an association is how
        an owner clears a DANGLING id — one whose project has been deleted — and
        a dangling id by definition no longer resolves, so an ownership check on
        the way out would make exactly the rows that most need removing the ones
        that cannot be removed. Nothing is leaked by the asymmetry: the write is
        scoped to the caller's OWN plate either way, so the worst a caller can
        do is remove an id from their own to-do.

        Idempotent in the other direction too: removing an id the to-do does not
        carry is a 200 no-op.
        """
        user = await ctx.auth.resolve_user_from_credential(authorization)
        todo = await dissociate_todo(_dir(), user.id, todo_id, project_id)
        if todo is None:
            raise HTTPException(404, f"To-do {todo_id!r} not found")
        await _broadcast(user.id, "dissociate", todo.id)
        return as_wire([todo], ctx.model_ctx)[0]

    @router.get("/me/desk/todos/{todo_id}/projects")
    async def list_todo_projects(
        todo_id: str,
        authorization: str = Header(default=""),
    ):
        """The to-do's associations, resolved. A DM thread appears on exactly
        the same footing as a regular project — same id space, same row shape.

        A dangling id is LISTED, not hidden: an association the owner cannot see
        is one they cannot remove either, and ``dissociate`` is the only way
        out. Its row is ``{"id", "resolved": false, "contributes": false}`` —
        the three keys that are present on every row, resolved or not, so the
        client types them required and never has to read an ABSENT
        ``contributes`` as falsy. The descriptive keys are OMITTED on such a
        row, never emitted as ``null``.

        Row shape is owned by
        :func:`~clawmeets.models.desk_todo_link.resolve_associations`; this
        route is auth plus a lookup.
        """
        user = await ctx.auth.resolve_user_from_credential(authorization)
        todo = await _load_target(user.id, todo_id)
        return resolve_associations(todo, ctx.model_ctx)

    @router.post("/me/desk/todos/reorder")
    async def reorder_my_todos(
        ordered_ids: list[str] = Body(..., embed=True),
        authorization: str = Header(default=""),
    ):
        user = await ctx.auth.get_current_user(authorization)
        todos = await reorder_todos(_dir(), user.id, ordered_ids)
        await _broadcast(user.id, "reorder", None)
        return as_wire(todos, ctx.model_ctx)

    @router.delete("/me/desk/todos/{todo_id}")
    async def delete_my_todo(
        todo_id: str,
        authorization: str = Header(default=""),
        x_agent_id: str = Header(default="", alias="X-Agent-ID"),
    ):
        """Delete a to-do. Owner JWT, the publishing agent's token (an agent may
        retract only a to-do it published), or the owner's assistant.

        The assistant is exempt from the ``by_agent_id`` check: "clear that off
        my plate" has to work on browser-captured items and on items another
        agent published, or the assistant cannot manage the list at all. The
        ``DESK_TODO_SYNC`` fan-out below is the mitigation — a mistaken
        retraction shows up on the owner's desk immediately rather than
        quietly."""
        owner_user_id: str | None = None
        if x_agent_id:
            agent = await _resolve_agent_caller(authorization, x_agent_id)
            existing = get_todo(_dir(), agent.registered_by, todo_id)
            if existing is None:
                raise HTTPException(404, f"To-do {todo_id!r} not found")
            if existing.by_agent_id != agent.id and not ctx.auth.is_owner_assistant(agent):
                raise HTTPException(
                    403,
                    "Only the publishing agent, the owner's assistant, or the "
                    "owning user can delete this to-do",
                )
            owner_user_id = agent.registered_by
        else:
            user = await ctx.auth.get_current_user(authorization)
            owner_user_id = user.id

        existed = await delete_todo(_dir(), owner_user_id, todo_id)
        if not existed:
            raise HTTPException(404, f"To-do {todo_id!r} not found")
        await _broadcast(owner_user_id, "delete", todo_id)
        return {"status": "deleted", "id": todo_id}

    @router.put("/me/desk/todos")
    async def publish_todo(
        text: str = Body(..., embed=True),
        suggest: str | None = Body(default=None, embed=True),
        draft_prompt: str | None = Body(default=None, embed=True),
        labels: Any = Body(default=None, embed=True),
        authorization: str = Header(default=""),
        x_agent_id: str = Header(default="", alias="X-Agent-ID"),
    ):
        """Publish an agent's to-do onto the owner's plate. Called by the
        publishing agent via ``clawmeets todo publish``; never the web UI.

        NO auto-registration here, by rule — this is the one write path where
        the caller is not the owner. An agent's label lands on the item and
        renders as an unregistered dashed chip until the owner adopts it.
        Without that line, fifty agents each inventing ``desk`` /
        ``office-stuff`` / ``at-office`` silently fill the owner's group list,
        and a stray ``kind: "state"`` would be worse still — at-most-one-state
        makes every extra state a mutually-exclusive choice nobody made."""
        agent = await _resolve_agent_caller(authorization, x_agent_id)

        # Resolve the suggested recipient in the owner's namespace (accepts a
        # short or full agent name) into the same pair the owner's recipient
        # picker writes. Best-effort: an unresolved name still publishes, with
        # the name stored and a null id (the take-over falls back to the
        # assistant).
        recipient_id: str | None = None
        recipient_name: str | None = None
        if suggest:
            resolved = Agent.get_by_name_for_owner(
                suggest, agent.registered_by, ctx.model_ctx
            )
            if resolved is not None:
                recipient_id = resolved.id
                recipient_name = resolved.name
            else:
                recipient_name = suggest

        try:
            todo = await publish_agent_todo(
                _dir(),
                agent.registered_by,
                by_agent_id=agent.id,
                text=text,
                draft_prompt=draft_prompt,
                draft_recipient_id=recipient_id,
                draft_recipient_name=recipient_name,
                labels=labels,
            )
        except ValueError as e:
            raise HTTPException(400, str(e))

        await _broadcast(agent.registered_by, "publish", todo.id)
        return as_wire([todo], ctx.model_ctx)[0]

    return router
