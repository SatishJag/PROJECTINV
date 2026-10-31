from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation

from sqlalchemy import String
from sqlalchemy.types import TypeDecorator

MONEY_Q = Decimal("0.0001")
QTY_Q = Decimal("0.000001")
RATE_Q = Decimal("0.000001")


class ExactDecimal(TypeDecorator):
    """Stores Decimal as canonical text so SQLite never rounds through float.

    On Azure SQL / Postgres this maps to DECIMAL(19,4)/(19,6) in a real migration.
    """

    impl = String(40)
    cache_ok = True

    def __init__(self, quantum: Decimal = MONEY_Q):
        super().__init__()
        self.quantum = quantum

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        return str(to_decimal(value).quantize(self.quantum, rounding=ROUND_HALF_EVEN))

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return Decimal(value)


def Money():
    return ExactDecimal(MONEY_Q)


def Qty():
    return ExactDecimal(QTY_Q)


def Rate():
    return ExactDecimal(RATE_Q)


def to_decimal(value) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, float):
        raise TypeError("Float is not accepted for money/quantity; send a decimal string")
    try:
        return Decimal(str(value))
    except InvalidOperation as exc:
        raise ValueError(f"Invalid decimal value: {value!r}") from exc


def money(value) -> Decimal:
    return to_decimal(value).quantize(MONEY_Q, rounding=ROUND_HALF_EVEN)


def dstr(value: Decimal | None) -> str | None:
    """Serialize a Decimal for the API (decimal strings, never floats)."""
    if value is None:
        return None
    return format(value.normalize(), "f")


def allocate_exact(total: Decimal, weights: list[Decimal], quantum: Decimal = MONEY_Q) -> list[Decimal]:
    """Split total by weights so parts sum exactly to total (largest remainder)."""
    if not weights:
        return []
    wsum = sum(weights)
    if wsum == 0:
        raise ValueError("Allocation weights sum to zero")
    raw = [total * w / wsum for w in weights]
    parts = [r.quantize(quantum, rounding="ROUND_DOWN") for r in raw]
    remainder = int(((total - sum(parts)) / quantum).to_integral_value())
    order = sorted(range(len(raw)), key=lambda i: raw[i] - parts[i], reverse=True)
    for i in order[: abs(remainder)]:
        parts[i] += quantum if remainder > 0 else -quantum
    return parts
