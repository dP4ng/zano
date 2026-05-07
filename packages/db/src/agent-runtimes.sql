-- ============================================================
-- Agent runtimes: Claude Code, Codex CLI, Kimi CLI
-- Run this in Supabase SQL Editor for existing databases
-- ============================================================

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS runtime text DEFAULT 'claude',
  ADD COLUMN IF NOT EXISTS model text DEFAULT 'opus',
  ADD COLUMN IF NOT EXISTS reasoning_effort text,
  ADD COLUMN IF NOT EXISTS session_id text,
  ADD COLUMN IF NOT EXISTS workspace_path text;

UPDATE public.agents SET runtime = 'claude' WHERE runtime IS NULL;
UPDATE public.agents SET runtime = 'claude'
WHERE runtime NOT IN ('claude', 'codex', 'kimi');
UPDATE public.agents SET model = 'opus' WHERE model IS NULL;
UPDATE public.agents SET reasoning_effort = 'high'
WHERE runtime = 'claude' AND reasoning_effort IS NULL;
UPDATE public.agents SET reasoning_effort = 'medium'
WHERE runtime = 'codex' AND reasoning_effort IS NULL;

ALTER TABLE public.agents
  ALTER COLUMN runtime SET DEFAULT 'claude',
  ALTER COLUMN runtime SET NOT NULL,
  ALTER COLUMN model SET DEFAULT 'opus',
  ALTER COLUMN model SET NOT NULL;

DO $$
BEGIN
  ALTER TABLE public.agents
    DROP CONSTRAINT IF EXISTS agents_runtime_check;

  ALTER TABLE public.agents
    DROP CONSTRAINT IF EXISTS agents_reasoning_effort_check;

  ALTER TABLE public.agents
    ADD CONSTRAINT agents_runtime_check
    CHECK (runtime IN ('claude', 'codex', 'kimi'));

  ALTER TABLE public.agents
    ADD CONSTRAINT agents_reasoning_effort_check
    CHECK (reasoning_effort IS NULL OR reasoning_effort IN ('low', 'medium', 'high', 'xhigh', 'max'));
END $$;

CREATE TABLE IF NOT EXISTS public.agent_runtime_settings (
  agent_id uuid REFERENCES public.agents(id) ON DELETE CASCADE PRIMARY KEY,
  env_vars jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(env_vars) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agents'
      AND column_name = 'env_vars'
  ) THEN
    INSERT INTO public.agent_runtime_settings (agent_id, env_vars)
    SELECT id, env_vars::jsonb
    FROM public.agents
    WHERE env_vars IS NOT NULL
      AND jsonb_typeof(env_vars::jsonb) = 'object'
    ON CONFLICT (agent_id) DO UPDATE
      SET env_vars = EXCLUDED.env_vars,
          updated_at = now();
  END IF;
END $$;

ALTER TABLE public.agents
  DROP COLUMN IF EXISTS env_vars;

ALTER TABLE public.agent_runtime_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Agent owners can manage runtime settings" ON public.agent_runtime_settings;
CREATE POLICY "Agent owners can manage runtime settings"
  ON public.agent_runtime_settings FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.agents
      WHERE agents.id = agent_runtime_settings.agent_id
        AND agents.owner_id = (select auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.agents
      WHERE agents.id = agent_runtime_settings.agent_id
        AND agents.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "Channel creators can update channels" ON public.channels;
CREATE POLICY "Channel creators can update channels"
  ON public.channels FOR UPDATE
  USING ((select auth.uid()) = created_by);

DROP POLICY IF EXISTS "Channel creators can delete channels" ON public.channels;
CREATE POLICY "Channel creators can delete channels"
  ON public.channels FOR DELETE
  USING ((select auth.uid()) = created_by);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'channels'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.channels;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'server_members'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.server_members;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
