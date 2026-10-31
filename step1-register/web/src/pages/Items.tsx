import { useState } from "react";
import { api, qty } from "../api";
import { Card, ErrorNote, Pill, statusTone, useLoad } from "../ui";

export function ItemsPage() {
  const items = useLoad<any[]>(() => api("GET", "/api/items"), []);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const update = async (id: string, body: unknown) => {
    try {
      await api("PATCH", `/api/items/${id}`, body);
      items.reload();
    } catch (e: any) {
      setError(e.message);
    }
  };
  const rows = (items.data ?? []).filter((i) => !filter || `${i.internal_item_code} ${i.name} ${i.specification ?? ""}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Card title="Item catalogue" actions={<input className="search" placeholder="Search items" value={filter} onChange={(e) => setFilter(e.target.value)} />}>
      <p className="muted small">
        An item definition identifies a type or specification of equipment/material and is shared across projects; it never combines project quantities. Each project / work package keeps its own inventory record. Items created from a BOQ start as provisional: identical descriptions do not prove identical specifications.
      </p>
      <ErrorNote error={error ?? items.error} />
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>Item ID</th>
              <th>Name</th>
              <th>Specification</th>
              <th>Base UOM</th>
              <th>Tracking</th>
              <th>Verification</th>
              <th>Used in (project → work package: BOQ qty)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.item_id}>
                <td className="mono">{i.internal_item_code}</td>
                <td>{i.name}</td>
                <td className="wrap">{i.specification}</td>
                <td>{i.base_uom}</td>
                <td>
                  <select value={i.tracking_mode} onChange={(e) => update(i.item_id, { trackingMode: e.target.value })}>
                    <option value="quantity">quantity</option>
                    <option value="lot">lot / batch</option>
                    <option value="serialized">serialized</option>
                  </select>
                </td>
                <td>
                  <Pill tone={statusTone(i.verification_status)}>{i.verification_status}</Pill>{" "}
                  {i.verification_status !== "verified" ? (
                    <button className="btn btn-small" onClick={() => update(i.item_id, { verificationStatus: "verified" })}>
                      Verify
                    </button>
                  ) : null}
                </td>
                <td className="wrap small">
                  {i.usage.map((u: any) => (
                    <div key={u.record_number}>
                      {u.project_name} → {u.work_package}: {qty(u.boq_quantity)} {u.uom} <span className="muted mono">{u.record_number}</span>
                    </div>
                  ))}
                </td>
              </tr>
            ))}
            {!rows.length && !items.loading ? (
              <tr>
                <td colSpan={7} className="empty">
                  No items yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
