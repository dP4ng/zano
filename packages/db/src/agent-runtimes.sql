-- ============================================================
-- Agent runtimes: Claude Code, Codex CLI, Kimi CLI
-- Run this in Supabase SQL Editor for existing databases
-- ============================================================

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS runtime text DEFAULT 'claude',
  ADD COLUMN IF NOT EXISTS model text DEFAULT 'opus',
  ADD COLUMN IF NOT EXISTS session_id text,
  ADD COLUMN IF NOT EXISTS workspace_path text;

UPDATE public.agents SET runtime = 'claude' WHERE runtime IS NULL;
UPDATE public.agents SET model = 'opus' WHERE model IS NULL;

ALTER TABLE public.agents
  ALTER COLUMN runtime SET DEFAULT 'claude',
  ALTER COLUMN runtime SET NOT NULL,
  ALTER COLUMN model SET DEFAULT 'opus',
  ALTER COLUMN model SET NOT NULL;

ALTER TABLE public.agents
  DROP COLUMN IF EXISTS env_vars;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agents_runtime_check'
      AND conrelid = 'public.agents'::regclass
  ) THEN
    ALTER TABLE public.agents
      ADD CONSTRAINT agents_runtime_check
      CHECK (runtime IN ('claude', 'codex', 'kimi'));
  END IF;
END $$;
