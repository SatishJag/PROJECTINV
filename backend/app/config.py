from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", env_prefix="PCX_", extra="ignore")

    database_url: str = f"sqlite:///{(BACKEND_DIR / 'data' / 'pcx.db').as_posix()}"
    secret_key: str = "dev-only-change-me-0123456789abcdef"
    session_ttl_minutes: int = 720
    demo_mode: bool = True
    demo_password: str = "Demo!2026"
    public_base_url: str = "http://localhost:8000"
    web_origin: str = "http://localhost:5173"

    # Procore: SIMULATED needs no credentials; SANDBOX/PRODUCTION use the real OAuth/REST API.
    procore_mode: str = "SIMULATED"
    procore_client_id: str = ""
    procore_client_secret: str = ""
    procore_redirect_uri: str = "http://localhost:8000/api/integrations/procore/oauth/callback"
    procore_webhook_secret: str = ""

    # Origins allowed to frame the UI (Procore embedded Full Screen / Side Panel apps).
    frame_ancestors: str = "'self' https://app.procore.com https://us02.procore.com https://uk01.procore.com https://sandbox.procore.com"

    run_outbox_worker: bool = True
    outbox_poll_seconds: float = 5.0
    benchmark_min_sample: int = 3


@lru_cache
def get_settings() -> Settings:
    return Settings()
