"""Simulated Oracle Fusion SCM stock authority.

Modes come from `app.integrations.sim_state` (default ACK):
    ACK        -> apply the stock effect and return an external reference
    REJECT     -> business rejection surfaced as an IntegrationException
    TIMEOUT    -> TIMEOUT_UNKNOWN: the effect may or may not have been applied; reconcile first
    TRANSIENT  -> retryable failure with backoff
"""

from sqlalchemy.orm import Session

from app.core.outbox import HandlerResult, register_handler
from app.integrations import sim_state
from app.models import AllocationRecord, Receipt, StockTransaction, utcnow

TARGET = "ORACLE"


def _mode() -> str:
    return sim_state.get_mode(TARGET)


def _result(external_ref_prefix: str, ident: str) -> HandlerResult:
    mode = _mode()
    if mode == "REJECT":
        return HandlerResult("REJECTED", message="Simulated Oracle rejection: stock account or organisation is invalid")
    if mode == "TIMEOUT":
        return HandlerResult("TIMEOUT_UNKNOWN", message="Simulated Oracle timeout after posting; reconcile before replay")
    if mode == "TRANSIENT":
        return HandlerResult("TRANSIENT_FAILURE", message="Simulated Oracle transient failure")
    return HandlerResult("ACKNOWLEDGED", external_ref=f"{external_ref_prefix}-{ident[:8].upper()}")


@register_handler(TARGET, "receipt.create")
def receipt_create(db: Session, msg) -> HandlerResult:
    receipt = db.get(Receipt, msg.payload.get("receipt_id"))
    if receipt is None:
        return HandlerResult("REJECTED", message="Receipt not found")
    result = _result("ORA-RCPT", receipt.id)
    if result.status == "ACKNOWLEDGED":
        receipt.state = "CONFIRMED"
        receipt.oracle_receipt_ref = result.external_ref
    elif result.status == "REJECTED":
        receipt.state = "REJECTED"
    elif result.status == "TIMEOUT_UNKNOWN":
        receipt.state = "UNKNOWN"
    return result


@register_handler(TARGET, "stock_txn.post")
def stock_txn_post(db: Session, msg) -> HandlerResult:
    txn = db.get(StockTransaction, msg.payload.get("stock_transaction_id"))
    if txn is None:
        return HandlerResult("REJECTED", message="Stock transaction not found")
    result = _result("ORA-TXN", txn.request_ref)
    if result.status == "ACKNOWLEDGED":
        txn.state = "CONFIRMED"
        txn.oracle_txn_id = result.external_ref
        txn.confirmed_at = utcnow()
        txn.message = None
    elif result.status == "REJECTED":
        txn.state = "REJECTED"
        txn.message = result.message
    elif result.status == "TIMEOUT_UNKNOWN":
        txn.state = "UNKNOWN"
        txn.message = result.message
    return result


@register_handler(TARGET, "reservation.create")
def reservation_create(db: Session, msg) -> HandlerResult:
    allocation = db.get(AllocationRecord, msg.payload.get("allocation_id"))
    if allocation is None:
        return HandlerResult("REJECTED", message="Allocation not found")
    result = _result("ORA-RSV", allocation.id)
    if result.status == "ACKNOWLEDGED":
        allocation.state = "CONFIRMED"
        allocation.oracle_ref = result.external_ref
    elif result.status == "REJECTED":
        allocation.state = "REJECTED"
    return result


@register_handler(TARGET, "reservation.release")
def reservation_release(db: Session, msg) -> HandlerResult:
    allocation = db.get(AllocationRecord, msg.payload.get("allocation_id"))
    if allocation is None:
        return HandlerResult("REJECTED", message="Allocation not found")
    result = _result("ORA-RSVR", allocation.id)
    if result.status == "ACKNOWLEDGED":
        allocation.oracle_ref = result.external_ref
    return result


@register_handler(TARGET, "project_transfer.create")
def project_transfer_create(db: Session, msg) -> HandlerResult:
    allocation = db.get(AllocationRecord, msg.payload.get("allocation_id"))
    if allocation is None:
        return HandlerResult("REJECTED", message="Allocation not found")
    result = _result("ORA-XFER", allocation.id)
    if result.status == "ACKNOWLEDGED":
        allocation.state = "CONFIRMED"
        allocation.oracle_ref = result.external_ref
    elif result.status == "REJECTED":
        allocation.state = "REJECTED"
    return result
