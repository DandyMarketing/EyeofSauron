-- A short name for each planner task, written once and kept.
--
-- WHY. 13 Oct 2026, Khai: the plan's tasks land on Monday as sub-items whose
-- names are the whole task -- "Food menu written and costed to 25.59% COGS
-- ($128 set menu, rooftop access included, no free flow...)". The name should
-- be a summary, with the detail in an update on the sub-item.
--
-- WHY IT IS STORED. Sauron recognises a sub-item already on the board BY ITS
-- NAME -- that is how a second send finishes a group instead of duplicating
-- it, and how changes are matched. A summary written fresh by a model on every
-- preview would differ each time, and every re-send would add the same tasks
-- again under new names. So the first preview writes it, it is saved here, and
-- every later preview and send uses the same one.
--
-- NULL means not written yet; the next preview writes it.

alter table public.event_tasks add column if not exists title text;

comment on column public.event_tasks.title is
  'Short name for the task on Monday (a summary; the full description goes in '
  'an update). Written once by the preview''s grouping pass, then kept, because '
  'Sauron matches sub-items already on the board by name.';
