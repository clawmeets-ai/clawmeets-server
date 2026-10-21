# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/announcements.py

The announcements config route.

- ``GET /announcements`` — authenticated (any logged-in user), returns the
  parsed config verbatim as ``{"announcements": [...]}``.

Two properties are load-bearing and both are about failure modes:

**Never a 5xx.** Every config failure — missing file, unreadable file, invalid
JSON, non-object root, no ``announcements`` array — is a ``200`` with
``{"announcements": []}`` plus a server-side log line. A typo in a config file
that is edited by hand must not break the app shell for every logged-in user.

**No record-level validation.** The response is whatever parsed, including
records the client will reject. Validation is fail-closed and lives in exactly
one place — the client (``src/utils/versionMatch.ts``). Splitting it would
give two copies that must agree forever, which is the mistake this redesign
exists to undo.

``ETag`` + ``If-None-Match`` are what make the client's refetch-on-every-push
cheap while preserving the property that edits take effect with no server
restart (see ``server/announcements.load_announcements``).
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from fastapi import APIRouter, Header, Response
from fastapi.responses import JSONResponse

from clawmeets.server.announcements import load_announcements

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")


def create_announcements_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["announcements"])

    @router.get("/announcements")
    async def get_announcements(
        authorization: str = Header(default=""),
        if_none_match: str = Header(default="", alias="If-None-Match"),
    ):
        """Return the announcements config verbatim as parsed.

        Auth is required (any logged-in user) but the config is global — there
        is nothing per-user in the response, so no principal is threaded
        through. The 401 from ``get_current_user`` propagates; it is the one
        error status this route can produce.
        """
        await ctx.auth.get_current_user(authorization)

        try:
            records, etag = load_announcements(ctx.announcements_path)
        except Exception as e:
            # load_announcements is written not to raise; this is the
            # never-a-5xx guarantee held at the boundary rather than hoped for
            # upstream.
            logger.error(f"announcements: unexpected load failure: {e}", exc_info=True)
            records, etag = [], 'W/"0-0"'

        # If-None-Match is a comma-separated list per RFC 9110. "*" is not
        # meaningful for a GET of a resource that always exists, so it is not
        # special-cased — an unmatched value simply falls through to a 200.
        if if_none_match:
            candidates = {t.strip() for t in if_none_match.split(",")}
            if etag in candidates:
                return Response(status_code=304, headers={"ETag": etag})

        return JSONResponse({"announcements": records}, headers={"ETag": etag})

    return router
