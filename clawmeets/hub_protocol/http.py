# SPDX-License-Identifier: MIT
"""
clawmeets/hub_protocol/http.py

Bodies of the hub's HTTP routes, and the hub statement every route and frame
uses to tell a deployment something with the hub's signature on it.

  GET  /.well-known/clawmeets-hub-keys.json  -> HubKeySet (defined in keys.py)
  GET  /v1/info                              -> InfoResponse
  POST /v1/deployments                       RegisterRequest -> RegisterResponse
  POST /v1/deployments/{id}/verify-email     VerifyEmailRequest -> VerifyEmailResponse
  POST /v1/deployments/{id}/revoke           RevokeBody -> RevokedResponse
  POST /v1/deployments/{id}/owners           OwnerVerifyStart -> OwnerVerifyResponse
  POST /v1/deployments/{id}/owners/{ref}/verify  OwnerVerifyConfirm -> OwnerVerifyResponse
  any error                                  HttpError {"detail": {...}}

and one route a DEPLOYMENT serves, which the hub fetches to verify a
registration's public_url:

  GET  {public_url}/.well-known/clawmeets-deployment.json  -> DeploymentDocument

Every deployment-signed body is signed by the identity key over its purpose
tag plus the whole body minus sig (canonical.signing_payload), and carries
``aud`` (the canonical hub URL) so it cannot be replayed at another hub. A
body that names a deployment in its path also names it in ``deployment_id``,
inside the signature; the hub checks the two agree.

**Owners.** An owner is one user of a deployment, named to the hub only by an
``owner_ref``: an opaque id the deployment derives from its own secret and
the user's id, stable per (deployment, user) and meaningless anywhere else.
The hub lists an agent only once its owner has proved an email address, with
a code the HUB mails (so a deployment cannot claim an address it does not
control): ``OwnerVerifyStart`` then ``OwnerVerifyConfirm``. A first
registration may carry the enrolling user's ``owner_ref``; the code that
activates the deployment then verifies that owner too.
"""
from __future__ import annotations

from typing import Annotated, ClassVar, Literal

from pydantic import Field, StringConstraints, model_validator

from clawmeets.hub_protocol.canonical import Purpose
from clawmeets.hub_protocol.codes import WireCode
from clawmeets.hub_protocol.constants import MAX_NOTE_CHARS
from clawmeets.hub_protocol.ids import (
    AgentName,
    Count,
    DeploymentName,
    EpochS,
    Fingerprint,
    HubUrl,
    OpaqueId,
    PublicKeyB64,
    SignatureB64,
    WireModel,
)
from clawmeets.hub_protocol.keys import HubKeyEntry, HubKeySet, KidSig

__all__ = [
    "HubKeyEntry", "HubKeySet", "KidSig", "ProtocolInfo", "Limits", "InfoResponse",
    "RegisterRequest", "RegisterResponse", "VerifyEmailRequest", "VerifyEmailResponse",
    "OwnerVerifyStart", "OwnerVerifyConfirm", "OwnerVerifyResponse", "OwnerStatus",
    "RevokeBody", "RevokedResponse", "Statement", "ErrorDetail", "HttpError",
    "DEPLOYMENT_DOC_PATH", "DeploymentDocument",
]

#: Where a deployment serves its signed DeploymentDocument, under its public_url.
DEPLOYMENT_DOC_PATH = "/.well-known/clawmeets-deployment.json"

Reason = Annotated[str, StringConstraints(max_length=MAX_NOTE_CHARS)]
Email = Annotated[str, StringConstraints(pattern=r"^[^@\s]{1,64}@[^@\s]{1,189}$")]
TosVersion = Annotated[str, StringConstraints(min_length=1, max_length=40)]
EmailCode = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9]{4,16}$")]
#: An owner's state at the hub, as OwnerVerifyResponse reports it.
OwnerStatus = Literal["code_sent", "verified"]


class ProtocolInfo(WireModel):
    current: Annotated[int, Field(ge=1)]
    min_supported: Annotated[int, Field(ge=1)]
    sunset: EpochS | None = None


class Limits(WireModel):
    max_file_bytes: Count
    max_files: Count
    max_envelope_bytes: Count
    max_text_bytes: Count
    heartbeat_s: Count


class InfoResponse(WireModel):
    protocol: ProtocolInfo
    limits: Limits


class RegisterRequest(WireModel):
    """Signed by the new identity key. A first registration carries
    contact_email. A reclaim (reclaim=true) comes in two forms: without an
    email, the automatic same-key reclaim after close code 4004; with one,
    the operator's new-key reclaim (``hub register --reclaim --email``),
    which the hub confirms by email like a first registration."""

    SIGNING_PURPOSE: ClassVar[Purpose] = Purpose.REGISTER

    v: Annotated[int, Field(ge=1)]
    aud: HubUrl
    name: DeploymentName
    label: Annotated[str, StringConstraints(min_length=1, max_length=80)]
    identity_pubkey: PublicKeyB64
    contact_email: Annotated[str, StringConstraints(pattern=r"^[^@\s]{1,64}@[^@\s]{1,189}$")] | None = None
    tos_version: Annotated[str, StringConstraints(min_length=1, max_length=40)]
    public_url: Annotated[str, StringConstraints(pattern=r"^https://", max_length=200)] | None = None
    reclaim: bool | None = None
    # The enrolling user: the code that activates the deployment verifies
    # this owner too (contact_email is their address). Absent = no owner.
    owner_ref: OpaqueId | None = None
    ts: EpochS
    sig: SignatureB64 | None = None

    @model_validator(mode="after")
    def _new_registration_has_email(self) -> "RegisterRequest":
        if not self.reclaim and self.contact_email is None:
            raise ValueError("a new registration needs contact_email")
        return self


class RevokeBody(WireModel):
    """The deployment's own signed revoke. The same body goes to POST
    /v1/deployments/{id}/revoke and in the WS revoke frame, and the hub
    forwards it verbatim in a key_revoked statement. Signed by signer_fp's key."""

    SIGNING_PURPOSE: ClassVar[Purpose] = Purpose.REVOKE

    aud: HubUrl
    deployment_id: OpaqueId
    kind: Literal["agent_cert", "identity"]
    serial: OpaqueId | None = None          # kind == agent_cert
    fingerprint: Fingerprint | None = None  # kind == identity: the key being revoked
    signer_fp: Fingerprint
    ts: EpochS
    sig: SignatureB64 | None = None

    @model_validator(mode="after")
    def _one_subject(self) -> "RevokeBody":
        if self.kind == "agent_cert" and (self.serial is None or self.fingerprint is not None):
            raise ValueError("an agent_cert revoke names a serial and no fingerprint")
        if self.kind == "identity" and (self.fingerprint is None or self.serial is not None):
            raise ValueError("an identity revoke names a fingerprint and no serial")
        return self


class Statement(WireModel):
    """Signed by the hub key `kid` over the statement minus sig. The subject
    fields that apply depend on kind (StatementKind)."""

    SIGNING_PURPOSE: ClassVar[Purpose] = Purpose.STATEMENT

    kind: WireCode
    reason: Reason | None = None
    at: EpochS
    hub_url: HubUrl
    kid: OpaqueId
    subject_deployment_id: OpaqueId | None = None
    subject_fingerprint: Fingerprint | None = None
    subject_agent: AgentName | None = None
    serial: OpaqueId | None = None
    genesis_fp: Fingerprint | None = None
    revoked_fps: list[Fingerprint] | None = None
    deployment_revoke: RevokeBody | None = None     # key_revoked: the deployment's revoke, verbatim
    sig: SignatureB64 | None = None


class RegisterResponse(WireModel):
    deployment_id: OpaqueId
    status: WireCode            # RegisterStatus
    statement: Statement


class VerifyEmailRequest(WireModel):
    SIGNING_PURPOSE: ClassVar[Purpose] = Purpose.VERIFY_EMAIL

    aud: HubUrl
    deployment_id: OpaqueId
    code: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9]{4,16}$")]
    ts: EpochS
    sig: SignatureB64 | None = None


class VerifyEmailResponse(WireModel):
    status: WireCode
    statement: Statement


class OwnerVerifyStart(WireModel):
    """Ask the hub to mail ``email`` a code for ``owner_ref``. Signed by the
    deployment's current identity key; the deployment must be active. Sending
    it again re-sends a code (and may change the address while unverified)."""

    SIGNING_PURPOSE: ClassVar[Purpose] = Purpose.OWNER_VERIFY_START

    aud: HubUrl
    deployment_id: OpaqueId
    owner_ref: OpaqueId
    email: Email
    tos_version: TosVersion
    ts: EpochS
    sig: SignatureB64 | None = None


class OwnerVerifyConfirm(WireModel):
    SIGNING_PURPOSE: ClassVar[Purpose] = Purpose.OWNER_VERIFY_CONFIRM

    aud: HubUrl
    deployment_id: OpaqueId
    owner_ref: OpaqueId
    code: EmailCode
    ts: EpochS
    sig: SignatureB64 | None = None


class OwnerVerifyResponse(WireModel):
    owner_ref: OpaqueId
    status: OwnerStatus


class RevokedResponse(WireModel):
    revoked_fps: list[Fingerprint]


class ErrorDetail(WireModel):
    code: WireCode              # ErrorCode
    message: Reason | None = None
    retry_after: Count | None = None
    min_supported: Annotated[int, Field(ge=1)] | None = None


class HttpError(WireModel):
    """Every hub HTTP error body: {"detail": {"code", "message"?, "retry_after"?, "min_supported"?}}."""

    detail: ErrorDetail


class DeploymentDocument(WireModel):
    """What a deployment serves at ``{public_url}`` + DEPLOYMENT_DOC_PATH so
    the hub can verify it controls that URL. Signed by the identity key
    ``fingerprint`` names. ``deployment_id`` is None before the first
    registration has been answered (the hub checks the URL before it issues
    an id); ``genesis_fp`` is None until then too."""

    SIGNING_PURPOSE: ClassVar[Purpose] = Purpose.DEPLOYMENT_DOC

    aud: HubUrl
    public_url: Annotated[str, StringConstraints(pattern=r"^https://", max_length=200)]
    fingerprint: Fingerprint
    genesis_fp: Fingerprint | None = None
    deployment_id: OpaqueId | None = None
    ts: EpochS
    sig: SignatureB64 | None = None
