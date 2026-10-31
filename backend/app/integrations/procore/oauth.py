"""Procore OAuth 2.0: authorization code (with signed single-use state), refresh rotation and
client credentials (Developer Managed Service Account). Tokens are stored only encrypted."""

import secrets
import threading
from dataclasses import dataclass
from datetime import timedelta
from urllib.parse import urlencode

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from sqlalchemy import inspect as sa_inspect
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.core.crypto import decrypt, encrypt, sha256_hex
from app.core.errors import DomainError
from app.integrations.procore import settings as ps
from app.integrations.procore.transport import ProcoreAuthError, ProcoreRejected, ProcoreUnavailable, Transport, error_text
from app.models import IdempotencyRecord, ProcoreConnection, utcnow

DEFAULT_TTL = 5400
STATE_ROUTE = "procore.oauth.state"

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def connection_lock(conn_id: str) -> threading.Lock:
    """Serializes token refresh per connection (refresh tokens rotate; a race would orphan one)."""
    with _locks_guard:
        return _locks.setdefault(conn_id, threading.Lock())


@dataclass
class TokenSet:
    access_token: str
    refresh_token: str | None
    expires_in: int


def client_credentials_pair() -> tuple[str, str]:
    s = get_settings()
    if ps.mode() == ps.SIMULATED:
        return s.procore_client_id or "sim-client", s.procore_client_secret or "sim-secret"
    if not s.procore_client_id or not s.procore_client_secret:
        raise DomainError("PROCORE_NOT_CONFIGURED", "PCX_PROCORE_CLIENT_ID and PCX_PROCORE_CLIENT_SECRET must be set", status=409)
    return s.procore_client_id, s.procore_client_secret


# ---------------------------------------------------------------- state (CSRF)


def _state_serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_settings().secret_key, salt="pcx-procore-oauth-state")


def build_state(tenant_id: str, user_id: str, company_id: str | None) -> str:
    return _state_serializer().dumps({"tid": tenant_id, "uid": user_id, "cid": company_id, "n": secrets.token_urlsafe(12)})


def consume_state(db: Session, state: str) -> dict:
    """Verify signature + expiry, then burn the nonce so a state can be used exactly once."""
    try:
        data = _state_serializer().loads(state, max_age=ps.procore_settings().oauth_state_ttl_seconds)
    except SignatureExpired as exc:
        raise DomainError("OAUTH_STATE_EXPIRED", "Authorization took too long; start again", status=400) from exc
    except BadSignature as exc:
        raise DomainError("OAUTH_STATE_INVALID", "OAuth state is invalid", status=400) from exc
    used = db.scalar(
        select(IdempotencyRecord).where(
            IdempotencyRecord.tenant_id == data["tid"], IdempotencyRecord.route == STATE_ROUTE, IdempotencyRecord.key == data["n"]
        )
    )
    if used:
        raise DomainError("OAUTH_STATE_REUSED", "OAuth state was already used", status=400)
    db.add(
        IdempotencyRecord(
            tenant_id=data["tid"], principal=data["uid"], route=STATE_ROUTE, key=data["n"], request_hash=sha256_hex(state), status_code=200, response=None
        )
    )
    db.flush()
    return data


def authorize_url(state: str) -> str:
    login, _ = ps.base_urls()
    client_id, _ = client_credentials_pair()
    q = urlencode({"response_type": "code", "client_id": client_id, "redirect_uri": get_settings().procore_redirect_uri, "state": state})
    return f"{login}/oauth/authorize?{q}"


# ---------------------------------------------------------------- token endpoint


def _token_call(transport: Transport, form: dict) -> TokenSet:
    client_id, client_secret = client_credentials_pair()
    r = transport.request("POST", "login", "/oauth/token", data={**form, "client_id": client_id, "client_secret": client_secret})
    if r.status == 200 and isinstance(r.body, dict) and r.body.get("access_token"):
        return TokenSet(r.body["access_token"], r.body.get("refresh_token"), int(r.body.get("expires_in") or DEFAULT_TTL))
    if r.status >= 500 or r.status == 429:
        raise ProcoreUnavailable(f"Procore token endpoint unavailable ({r.status})", r.status)
    if r.status in (400, 401):
        raise ProcoreAuthError(f"Procore rejected the token request: {error_text(r.body)}", r.status)
    raise ProcoreRejected(f"Unexpected token response ({r.status})", r.status)


def exchange_code(transport: Transport, code: str) -> TokenSet:
    return _token_call(transport, {"grant_type": "authorization_code", "code": code, "redirect_uri": get_settings().procore_redirect_uri})


def refresh_grant(transport: Transport, refresh_token: str) -> TokenSet:
    return _token_call(transport, {"grant_type": "refresh_token", "refresh_token": refresh_token})


def client_credentials_grant(transport: Transport) -> TokenSet:
    return _token_call(transport, {"grant_type": "client_credentials"})


def revoke(transport: Transport, token: str) -> None:
    client_id, client_secret = client_credentials_pair()
    transport.request("POST", "login", "/oauth/revoke", data={"token": token, "client_id": client_id, "client_secret": client_secret})


# ---------------------------------------------------------------- persistence


def store_tokens(conn: ProcoreConnection, tokens: TokenSet) -> None:
    conn.access_token_enc = encrypt(tokens.access_token)
    # Client credentials never return a refresh token; keep None rather than a stale one.
    conn.refresh_token_enc = encrypt(tokens.refresh_token) if tokens.refresh_token else None
    conn.token_expires_at = utcnow() + timedelta(seconds=tokens.expires_in)


def clear_tokens(conn: ProcoreConnection) -> None:
    conn.access_token_enc = None
    conn.refresh_token_enc = None
    conn.token_expires_at = None


def access_token(conn: ProcoreConnection) -> str | None:
    return decrypt(conn.access_token_enc)


def refresh_token(conn: ProcoreConnection) -> str | None:
    return decrypt(conn.refresh_token_enc)


def renew(db: Session, conn: ProcoreConnection, transport: Transport, *, force: bool = False, skew_seconds: int = 120) -> str:
    """Return a usable access token, refreshing under a per-connection lock.

    The rotated pair is committed *before* it is used so a crash cannot strand the only valid
    refresh token in memory.
    """
    with connection_lock(conn.id):
        state = sa_inspect(conn)
        if state.persistent and conn not in db.dirty:
            db.refresh(conn)  # another worker may have rotated the pair already
        token = access_token(conn)
        fresh = conn.token_expires_at and conn.token_expires_at > utcnow() + timedelta(seconds=skew_seconds)
        if token and fresh and not force:
            return token
        if conn.auth_mode == "CLIENT_CREDENTIALS" or conn.auth_mode == "SIMULATED":
            tokens = client_credentials_grant(transport)
        else:
            rt = refresh_token(conn)
            if not rt:
                raise ProcoreAuthError("No refresh token stored; re-authorize the Procore connection")
            tokens = refresh_grant(transport, rt)
        store_tokens(conn, tokens)
        conn.last_error = None
        db.commit()
        return tokens.access_token
