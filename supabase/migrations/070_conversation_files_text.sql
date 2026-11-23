-- ============================================================
-- conversation_files: allow Markdown and plain-text uploads.
-- Run this in Supabase SQL Editor AFTER 069_conversation_files.sql
--
-- Khai, 21 Nov 2026: "can sauron take an md file as an upload" -- yes, and
-- .txt with it. They are already text, so nothing is extracted; the same
-- 30-day rule, size cap and owner-only reads apply. This only widens the
-- check on `kind` to include 'text'.
-- ============================================================

alter table public.conversation_files drop constraint if exists conversation_files_kind_check;
alter table public.conversation_files
  add constraint conversation_files_kind_check check (kind in ('pdf', 'spreadsheet', 'docx', 'text'));
