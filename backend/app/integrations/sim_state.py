"""Process-local response mode for the Oracle / Planon / Procore simulators."""

import threading

TARGETS = ("ORACLE", "PLANON", "PROCORE")
MODES = ("ACK", "REJECT", "TIMEOUT", "TRANSIENT")

_lock = threading.Lock()
_modes: dict[str, str] = {t: "ACK" for t in TARGETS}


def get_mode(target: str) -> str:
    with _lock:
        return _modes.get(target, "ACK")


def set_mode(target: str, mode: str) -> None:
    if target not in TARGETS or mode not in MODES:
        raise ValueError(f"Unknown simulator target/mode: {target}/{mode}")
    with _lock:
        _modes[target] = mode


def all_modes() -> dict[str, str]:
    with _lock:
        return dict(_modes)


def reset() -> None:
    with _lock:
        for t in TARGETS:
            _modes[t] = "ACK"
