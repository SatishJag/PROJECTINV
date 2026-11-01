-- Original BOQ files move out of the database into a file store (Azure Blob Storage in production, a local folder in
-- development). The revision keeps the store kind, the key, the size and the sha256; the bytes live in the store.
-- Rows written before this migration keep their bytes in file_content until moved (npm run files:migrate).
alter table boq_document_revisions add column storage_kind text;
alter table boq_document_revisions add column storage_key text;
alter table boq_document_revisions add constraint boq_revision_original_kept
  check (file_content is not null or (storage_kind is not null and storage_key is not null));
