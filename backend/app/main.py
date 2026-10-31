import logging
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app import db
from app.api import (
    assets,
    auth,
    costs,
    dashboard,
    handbook,
    integrations,
    inventory,
    logistics,
    planning,
    procurement,
    quality,
    reference,
    sourcing,
)
from app.config import get_settings
from app.core.errors import DomainError, domain_error_handler
from app.core.outbox import process_outbox
from app.integrations import load_handlers

log = logging.getLogger("pcx")
WEB_DIST = Path(__file__).resolve().parents[2] / "web" / "dist"


def _outbox_loop(stop: threading.Event, interval: float) -> None:
    while not stop.wait(interval):
        session = db.SessionLocal()
        try:
            process_outbox(session)
        except Exception:
            log.exception("outbox worker iteration failed")
            session.rollback()
        finally:
            session.close()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings = get_settings()
    db.create_all()
    stop = threading.Event()
    worker = None
    if settings.run_outbox_worker:
        worker = threading.Thread(target=_outbox_loop, args=(stop, settings.outbox_poll_seconds), daemon=True, name="outbox")
        worker.start()
    yield
    stop.set()
    if worker:
        worker.join(timeout=5)


def create_app() -> FastAPI:
    settings = get_settings()
    load_handlers()
    app = FastAPI(title="Procore Equipment Intelligence", version="1.0.0", lifespan=lifespan)
    app.add_exception_handler(DomainError, domain_error_handler)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.web_origin],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["ETag"],
    )

    @app.middleware("http")
    async def frame_policy(request: Request, call_next):
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = f"frame-ancestors {settings.frame_ancestors}"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    for module in (auth, reference, dashboard, planning, sourcing, procurement, inventory, assets, quality, logistics, handbook, costs, integrations):
        app.include_router(module.router)

    @app.get("/api/health")
    def health():
        return {"status": "ok", "procore_mode": settings.procore_mode}

    if WEB_DIST.exists():
        app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="web-assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            if path.startswith("api/"):
                raise DomainError("NOT_FOUND", f"No API route: /{path}", status=404)
            target = WEB_DIST / path
            if path and target.is_file() and WEB_DIST in target.resolve().parents:
                return FileResponse(target)
            return FileResponse(WEB_DIST / "index.html")

    return app


app = create_app()
