# Step 1 feed — deferred follow-ups

Findings from the Step 1 → PCX feed reviews (2026-11-11) that were deliberately left for later. None blocks the
feed; each is small. Numbers refer to the final review.

- **M1** The "exceptions" link on the Step 1 pages cannot filter to Step 1. Needs `?source=` on `GET /exceptions`
  and a source filter in `Exceptions.tsx`.
- **M3** A Step 1 change that returns a record to its approved values still creates an empty draft. Cancel the open
  draft and skip `add_revision` when nothing differs from the approved revision.
- **M4** Two concurrent first-ever syncs can return 500 from the crosswalk `IntegrityError` (unique
  `step1_item_id`). Map it to 409.
- **M6** A cost-code change on a linked record is not re-matched to WBS. Open a `MAPPING` exception when the linked
  WBS element no longer has the record's cost code.
- **M7** A Step 1 project that disappears is never reconciled, and `project_ids` naming a PCX project with no
  Step 1 counterpart returns `SUCCEEDED` with `projects: []`.
- `project_ids: []` is accepted and records an empty run (carried over from the earlier CLAUDE.md list).
- No test pins that an unchanged record whose WBS is still missing keeps its `MAPPING` exception open (carried over).
- Items page: decided rows do not show the chosen equipment class.
- `StateBadge` has no `PARTIAL` / `SUCCEEDED` tones of its own.
- A FAILED run whose `error` is null shows no failure callout (and so no "Last good sync" line).
- The equipment-classes query key on the items page differs from the shared `['ref', 'equipment-classes']`.
- Row buttons on the items page lack per-row `aria-label`s.
- `backend/app/services/step1_sync.py` is about 600 lines. Split the change and reconcile rules into their own module
  if it grows further.
