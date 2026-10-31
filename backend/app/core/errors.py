from fastapi import Request
from fastapi.responses import JSONResponse


class DomainError(Exception):
    """Business-rule failure rendered as application/problem+json."""

    status = 422

    def __init__(self, code: str, detail: str, status: int | None = None, errors: list | None = None):
        super().__init__(detail)
        self.code = code
        self.detail = detail
        if status is not None:
            self.status = status
        self.errors = errors or []


class NotFound(DomainError):
    status = 404

    def __init__(self, what: str, ident: str | None = None):
        super().__init__("NOT_FOUND", f"{what} not found" + (f": {ident}" if ident else ""))


class Conflict(DomainError):
    status = 409


class Forbidden(DomainError):
    status = 403

    def __init__(self, detail: str = "You are not authorized for this action"):
        super().__init__("FORBIDDEN", detail)


class PreconditionFailed(DomainError):
    status = 412

    def __init__(self, detail: str = "Resource changed since it was read; reload and review"):
        super().__init__("ETAG_MISMATCH", detail)


async def domain_error_handler(_request: Request, exc: DomainError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status,
        media_type="application/problem+json",
        content={
            "type": f"https://pcx.local/problems/{exc.code.lower()}",
            "title": exc.code,
            "status": exc.status,
            "detail": exc.detail,
            "errors": exc.errors,
        },
    )
