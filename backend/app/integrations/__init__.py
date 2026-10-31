"""Integration adapters. Importing this package registers all outbox handlers."""


def load_handlers() -> None:
    from app.integrations import oracle_sim, planon_sim, procore  # noqa: F401
