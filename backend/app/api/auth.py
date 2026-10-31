from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.common import row
from app.config import get_settings
from app.core.auth import ROLES, Principal, current_principal, issue_token, verify_password
from app.core.errors import DomainError
from app.db import get_db
from app.models import Tenant, User

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginIn(BaseModel):
    email: str
    password: str
    tenant_code: str = "DEMO"


def _user_out(u: User) -> dict:
    return row(u, exclude={"project_scope"}, role_list=u.roles.split(","))


@router.post("/login")
def login(body: LoginIn, db: Session = Depends(get_db)):
    tenant = db.scalar(select(Tenant).where(Tenant.code == body.tenant_code))
    user = tenant and db.scalar(select(User).where(User.tenant_id == tenant.id, User.email == body.email.lower().strip()))
    if not user or not user.active or not verify_password(body.password, user.password_hash):
        raise DomainError("INVALID_CREDENTIALS", "Email or password is incorrect", status=401)
    return {"token": issue_token(user.id, user.tenant_id), "user": _user_out(user)}


@router.get("/me")
def me(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    user = db.get(User, p.user_id)
    return {"user": _user_out(user), "roles": sorted(p.roles), "can_see_commercial": p.can_see_commercial}


@router.get("/demo-accounts")
def demo_accounts(db: Session = Depends(get_db)):
    """Local demo only: lists seeded accounts for the sign-in chooser."""
    if not get_settings().demo_mode:
        return {"demo_mode": False, "accounts": []}
    users = db.scalars(select(User).where(User.active.is_(True)).order_by(User.email))
    return {
        "demo_mode": True,
        "password_hint": "Shared demo password is set by PCX_DEMO_PASSWORD (default Demo!2026)",
        "accounts": [{"email": u.email, "name": u.name, "roles": u.roles.split(",")} for u in users],
        "role_catalogue": ROLES,
    }
