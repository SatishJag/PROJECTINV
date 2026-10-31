"""Local session auth + role model. Production swaps the token issuer (Entra ID / Procore
OAuth identity) without changing the Principal contract or the role checks."""

import base64
import hashlib
import hmac
import os
from dataclasses import dataclass, field

from fastapi import Depends, Header
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from sqlalchemy.orm import Session

from app.config import get_settings
from app.core.errors import DomainError, Forbidden
from app.db import get_db

ROLES = {
    "OWNER": "Owner and project controls",
    "ESTIMATOR": "Estimator / quantity surveyor",
    "ENGINEERING": "Engineering and commissioning",
    "PROCUREMENT": "Procurement",
    "SUPPLIER": "Supplier (external)",
    "INVENTORY": "Inventory and site delivery",
    "FINANCE": "Finance",
    "FM": "FM and asset owner",
    "INTEGRATION": "Product and integration operations",
    "ADMIN": "Administrator (all internal roles)",
}

INTERNAL_ROLES = set(ROLES) - {"SUPPLIER"}


@dataclass(frozen=True)
class Principal:
    user_id: str
    tenant_id: str
    email: str
    name: str
    roles: frozenset[str]
    supplier_id: str | None = None
    project_scope: frozenset[str] = field(default_factory=frozenset)

    def has(self, *roles: str) -> bool:
        if "ADMIN" in self.roles and not (set(roles) == {"SUPPLIER"}):
            return True
        return bool(self.roles.intersection(roles))

    @property
    def is_supplier(self) -> bool:
        return "SUPPLIER" in self.roles and "ADMIN" not in self.roles

    def can_see_project(self, project_id: str | None) -> bool:
        if project_id is None or not self.project_scope:
            return True
        return project_id in self.project_scope

    @property
    def can_see_commercial(self) -> bool:
        return self.has("OWNER", "PROCUREMENT", "FINANCE", "ESTIMATOR")


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(digest).decode()


def verify_password(password: str, stored: str | None) -> bool:
    if not stored or not stored.startswith("scrypt$"):
        return False
    _, salt_b64, digest_b64 = stored.split("$")
    digest = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt_b64), n=2**14, r=8, p=1)
    return hmac.compare_digest(digest, base64.b64decode(digest_b64))


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_settings().secret_key, salt="pcx-session")


def issue_token(user_id: str, tenant_id: str) -> str:
    return _serializer().dumps({"uid": user_id, "tid": tenant_id})


def principal_from_token(db: Session, token: str) -> Principal:
    from app.models import User

    try:
        data = _serializer().loads(token, max_age=get_settings().session_ttl_minutes * 60)
    except SignatureExpired as exc:
        raise DomainError("SESSION_EXPIRED", "Session expired; sign in again", status=401) from exc
    except BadSignature as exc:
        raise DomainError("UNAUTHENTICATED", "Invalid session token", status=401) from exc
    user = db.get(User, data["uid"])
    if not user or not user.active or user.tenant_id != data["tid"]:
        raise DomainError("UNAUTHENTICATED", "User is not active", status=401)
    return principal_from_user(user)


def principal_from_user(user) -> Principal:
    return Principal(
        user_id=user.id,
        tenant_id=user.tenant_id,
        email=user.email,
        name=user.name,
        roles=frozenset(r.strip() for r in user.roles.split(",") if r.strip()),
        supplier_id=user.supplier_id,
        project_scope=frozenset(p for p in (user.project_scope or "").split(",") if p),
    )


def current_principal(authorization: str | None = Header(default=None), db: Session = Depends(get_db)) -> Principal:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise DomainError("UNAUTHENTICATED", "Bearer token required", status=401)
    return principal_from_token(db, authorization.split(" ", 1)[1].strip())


def require_roles(*roles: str):
    """Route dependency: `p: Principal = Depends(require_roles("ENGINEERING"))`."""

    def dep(p: Principal = Depends(current_principal)) -> Principal:
        if not p.has(*roles):
            raise Forbidden(f"Requires one of roles: {', '.join(roles)}")
        return p

    return dep


def require_internal(p: Principal = Depends(current_principal)) -> Principal:
    if p.is_supplier:
        raise Forbidden("Supplier accounts cannot access internal workspaces")
    return p
