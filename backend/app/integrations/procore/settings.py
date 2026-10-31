"""Procore connector settings.

The core `app.config.Settings` carries mode, client id/secret and redirect URI. Connector-only
settings (base URLs per environment, paging, write-back gate) live here so they can be configured
without touching shared config. All values come from environment variables / backend/.env with the
prefix PCX_PROCORE_.
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

from app.config import BACKEND_DIR, get_settings

# Documented Procore hosts (developers.procore.com). Base URLs remain overridable.
ENVIRONMENTS: dict[str, tuple[str, str]] = {
    "PRODUCTION": ("https://login.procore.com", "https://api.procore.com"),
    "SANDBOX": ("https://login-sandbox.procore.com", "https://sandbox.procore.com"),
    "MONTHLY_SANDBOX": ("https://login-sandbox-monthly.procore.com", "https://api-monthly.procore.com"),
}

SIMULATED = "SIMULATED"
LIVE_MODES = {"LIVE", *ENVIRONMENTS}


class ProcoreSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", env_prefix="PCX_PROCORE_", extra="ignore")

    # Used when PCX_PROCORE_MODE=LIVE. PCX_PROCORE_MODE=SANDBOX|PRODUCTION|MONTHLY_SANDBOX also works.
    environment: str = "SANDBOX"
    login_base_url: str = ""
    api_base_url: str = ""
    timeout_seconds: float = 20.0
    per_page: int = 100  # v1 endpoints; kept <= 100 deliberately
    max_pages: int = 200  # hard stop for runaway pagination
    max_rate_limit_wait_seconds: float = 60.0
    max_retries: int = 3
    # Outbound write-back in LIVE mode stays off until payload mappings are validated against the
    # tenant's sandbox (see app-manifest `validation_required`). SIMULATED always writes.
    writeback_enabled: bool = False
    # Public URL Procore posts webhooks to; defaults to PCX_PUBLIC_BASE_URL + receiver path.
    webhook_destination_url: str = ""
    # Hook namespace and trigger list are sent as-is to POST /rest/v1.0/webhooks/hooks[/triggers].
    # Resource names must be checked against the tenant's Webhooks tool before go-live.
    webhook_namespace: str = "pcx-equipment-intelligence"
    webhook_triggers: str = "Projects:create,Projects:update,Purchase Order Contracts:create,Purchase Order Contracts:update,Purchase Order Contracts:delete"
    oauth_state_ttl_seconds: int = 600


@lru_cache
def procore_settings() -> ProcoreSettings:
    return ProcoreSettings()


def mode() -> str:
    """SIMULATED or LIVE."""
    m = (get_settings().procore_mode or SIMULATED).upper()
    return SIMULATED if m == SIMULATED else "LIVE"


def environment() -> str:
    m = (get_settings().procore_mode or SIMULATED).upper()
    if m == SIMULATED:
        return SIMULATED
    if m in ENVIRONMENTS:
        return m
    env = procore_settings().environment.upper()
    return env if env in ENVIRONMENTS else "SANDBOX"


def base_urls(env: str | None = None) -> tuple[str, str]:
    env = env or environment()
    s = procore_settings()
    login, api = ENVIRONMENTS.get(env, ENVIRONMENTS["SANDBOX"])
    return (s.login_base_url or login).rstrip("/"), (s.api_base_url or api).rstrip("/")


def webhook_destination_url() -> str:
    s = procore_settings()
    return s.webhook_destination_url or f"{get_settings().public_base_url.rstrip('/')}/api/integrations/procore/webhooks"
