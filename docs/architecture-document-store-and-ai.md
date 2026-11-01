# Architecture proposal: BOQ document store, AI search and linking

Status: **proposal for owner decision** (1 Nov 2026)

## Problem

BOQs arrive from Procore in large numbers, and some are large files (Excel workbooks, long PDFs, some scanned). We need
to:
1. keep every original file safely;
2. extract lines and text and make them searchable with AI (semantic and vector search);
3. compare what was extracted with the inventory master data (items, work packages, cost codes), and form links.

Today the original file is stored inside Postgres (`boq_document_revisions.file_content`) and parsed during the request.
That works for the demo but will not scale to heavy files or volume.

## Recommendation

**One relational database with vector search built in, plus a separate file store.** No separate NoSQL database.

```
Procore Documents
      │  webhook / periodic scan (built)
      ▼
File store (object storage)           ← original files, immutable, path = org/project/sha256
      │  job queue (async worker)
      ▼
Extraction                             ← Excel/CSV parser (built); text PDF (built); scanned PDF → OCR service
      │
      ▼
Postgres = system of record
  ├─ relational: projects, work packages, cost assignments, items, BOQ lines, register, allocations (built)
  ├─ vectors (pgvector): BOQ line embeddings, item-definition embeddings, text chunks
  └─ mapping_exceptions: AI proposals waiting for a person
      │
      ▼
Matching: rules first (codes, headings), then vector similarity → proposal → human approves → link
```

### Why one database (Postgres + pgvector) rather than Cosmos DB + SQL

| Need | Postgres + pgvector | Cosmos DB (NoSQL) + a SQL database |
|---|---|---|
| Links must be correct: composite FKs, allocations that reconcile, revisions that supersede | Enforced by the database | Cosmos can't enforce cross-document FKs, so a SQL database is still needed for links |
| Project isolation (BC1 must never see BC2), including in AI search | RLS applies to vector rows automatically | Every search query must filter by project, and one missed filter leaks data |
| Vector similarity in the same query as the relational data | One SQL query: "lines in BC1 whose embedding is close to item X" | Query two stores and join in code |
| Sources of truth | One | Two, with a sync job between them |
| Scale needed (100k–10M lines or chunks) | Comfortable with an HNSW index | Also fine, but not needed |

Cosmos DB and Azure AI Search are good products. Our core problem, though, is **linking with integrity**, and that is
relational. Vectors are only a way to *propose* a link. The approved rule still holds: AI proposes, never decides.

### Chunking for BOQs

A BOQ is a table, so we don't cut it into arbitrary text windows.
- **Unit = one BOQ line** with its context: section path (headings), description, specification, unit, quantity and
  source locator. This is the row we already store in `boq_lines`. We embed it as is.
- **Prose** (preambles, specification notes, scope clauses, PDF text) is chunked by paragraph or section, keeping the
  page and section reference.
- Every chunk and vector keeps `project_id`, `boq_revision_id` and `source_locator`, so search results always link back
  to the exact cell or page.

### Linking, step by step

1. Rules first (deterministic, already built): explicit cost code / WBS ref → heading → sheet name.
2. Vector proposals (new):
   - BOQ line ↔ item catalogue: same spec? It proposes an existing item or a new one.
   - Line ↔ work package: used when the rules found nothing.
3. Each proposal has a score and its evidence, and lands in `mapping_exceptions`. A person accepts or rejects it. Only
   then is the relational link (allocation) written.
4. Accepted decisions become training evidence: aliases are added to `item_aliases`.

## Hosting options (same design either way)

| Part | Supabase (current approved plan) | Azure equivalent |
|---|---|---|
| Database + vectors | Supabase Postgres + `pgvector` | Azure Database for PostgreSQL Flexible Server + `pgvector` (`azure_ai` extension) |
| File store | Supabase Storage (S3-compatible) | Azure Blob Storage |
| Job queue | `pgmq` in Postgres | Azure Storage Queue / Service Bus |
| OCR + table extraction for scanned PDFs | External service (e.g. Azure AI Document Intelligence) | Azure AI Document Intelligence |
| Embeddings | Any embeddings API | Azure OpenAI embeddings |
| Optional cross-document search portal | Not needed now | Azure AI Search, fed from Blob, read-only, added later |

**When Azure AI Search becomes worth adding:** when people need free-text or semantic search across *all* project
documents (specs, submittals, drawings), not just BOQs, or at very large OCR volume. It would be a read-only index
next to Postgres, never the place where links live.

## Delivery steps

1. **Move files out of the database**: store originals in object storage keyed by sha256 and keep only the path, hash
   and size in Postgres. Download from Procore as a stream.
2. **Async processing**: capture enqueues a job and a worker extracts it. Large files no longer block requests; progress
   and failures are visible per file.
3. **OCR path** for scanned PDFs (table-aware). Its output feeds the same `boq_lines` with page and cell locators.
4. **pgvector**: embeddings for BOQ lines, item definitions and work packages, with RLS and an HNSW index.
5. **AI proposals** in the exception queue, with score, evidence and accept/reject. Measure precision before trusting it.
6. **Optional**: an Azure AI Search portal for document-wide search.

## Decisions needed

1. **Hosting**: stay on Supabase (approved 31 Oct) or move to Azure (PostgreSQL Flexible Server + Blob + AI services)?
   The design is the same; only the providers change.
2. **Embedding and OCR providers**: these may follow from (1), e.g. Azure OpenAI + Document Intelligence.
3. **Data residency**: which region the BOQs must stay in.
