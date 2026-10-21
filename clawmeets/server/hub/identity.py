# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/hub/identity.py
This deployment's identity key: the Ed25519 key it registers with the hub
and signs every deployment-signed body with.

The key is stored like any channel credential: as a ``hub`` connection row
in ``channels.db`` (``agent_id='__deployment__'``, ``owner_id='__server__'``)
whose secret is the raw private key, base64url, encrypted with
``CLAWMEETS_CHANNEL_SECRET_KEY``. So the key is never on disk unencrypted,
``rotate_secrets`` re-encrypts it with the rest, and no code path can read it
without the server's key. ``hub_registration.identity_connection_id`` names
the row in use. Nothing about the key is shown except its fingerprint (the
row's ``secret_last4`` is the fingerprint's last four characters).
"""
from __future__ import annotations

from cryptography.fernet import MultiFernet
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat

from clawmeets.hub_protocol.canonical import b64url, b64url_decode, fingerprint, public_key_bytes
from clawmeets.server.channels.store import HUB_CHANNEL, ChannelStore

#: The connection row of the deployment's identity key, not of any agent.
DEPLOYMENT_AGENT_ID = "__deployment__"
#: Its owner: the server itself, so no user's connection list shows it.
SERVER_OWNER_ID = "__server__"


def key_fingerprint(key: Ed25519PrivateKey) -> str:
    return fingerprint(public_key_bytes(key))


# A new identity key, stored encrypted in a new connection row labelled with
# the hub URL. Returns the row's id and the key.
def create_identity(
    store: ChannelStore, *, hub_url: str, fernet: MultiFernet, now: float,
) -> tuple[str, Ed25519PrivateKey]:
    key = Ed25519PrivateKey.generate()
    raw = key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    fp = key_fingerprint(key)
    connection = store.create_connection(
        agent_id=DEPLOYMENT_AGENT_ID, owner_id=SERVER_OWNER_ID, channel=HUB_CHANNEL,
        label=hub_url, secret=b64url(raw), fernet=fernet, now=now,
        account_name=fp, secret_last4=fp[-4:],
    )
    return connection.id, key


# The identity key in row `connection_id`. KeyError if the row is gone,
# cryptography.fernet.InvalidToken if no configured key decrypts it.
def load_identity(store: ChannelStore, connection_id: str, fernet: MultiFernet) -> Ed25519PrivateKey:
    secret = store.load_secret(connection_id, fernet).get_secret_value()
    return Ed25519PrivateKey.from_private_bytes(b64url_decode(secret, length=32))


# Delete an identity row (a reclaim's replaced key, or its new key when the
# hub refused it). The key is gone for good.
def drop_identity(store: ChannelStore, connection_id: str, *, now: float) -> None:
    store.remove_connection(connection_id, now=now)
