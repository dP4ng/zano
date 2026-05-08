-- Fix RLS policies to avoid circular dependency issues

-- Helper functions to check channel membership without circular RLS dependency.
-- Keep SECURITY DEFINER helpers outside exposed schemas.
CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.user_is_channel_member(channel_uuid uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.channel_members
    WHERE channel_id = channel_uuid AND member_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION private.user_owns_agent(agent_uuid uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.agents
    WHERE id = agent_uuid AND owner_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION private.user_has_agent_in_channel(channel_uuid uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.channel_members cm
    JOIN public.agents a ON a.id = cm.member_id
    WHERE cm.channel_id = channel_uuid
      AND cm.member_type = 'agent'
      AND a.owner_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Channel members: users can see ALL members of channels they belong to
DROP POLICY IF EXISTS "Members can view channel membership" ON public.channel_members;
DROP POLICY IF EXISTS "Users can view own channel memberships" ON public.channel_members;
CREATE POLICY "Users can view channel memberships"
  ON public.channel_members FOR SELECT
  USING (
    private.user_is_channel_member(channel_id)
    OR private.user_has_agent_in_channel(channel_id)
  );

-- Also allow inserting members (for channel creation flow)
DROP POLICY IF EXISTS "Users can add channel members" ON public.channel_members;
CREATE POLICY "Users can add channel members"
  ON public.channel_members FOR INSERT
  WITH CHECK (true);

-- Channels: simplify - authenticated users can see public channels and channels they're in
DROP POLICY IF EXISTS "Channel members can view channels" ON public.channels;
CREATE POLICY "Users can view their channels"
  ON public.channels FOR SELECT
  USING (
    type = 'public'
    OR created_by = auth.uid()
    OR id IN (
      SELECT channel_id FROM public.channel_members WHERE member_id = auth.uid()
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

-- Messages: users can see messages in channels they're members of
DROP POLICY IF EXISTS "Channel members can view messages" ON public.messages;
CREATE POLICY "Users can view messages in their channels"
  ON public.messages FOR SELECT
  USING (
    private.user_is_channel_member(channel_id)
    OR private.user_has_agent_in_channel(channel_id)
  );

-- Messages: users can send messages in channels they're members of
DROP POLICY IF EXISTS "Channel members can send messages" ON public.messages;
CREATE POLICY "Users can send messages in their channels"
  ON public.messages FOR INSERT
  WITH CHECK (
    (
      sender_id = auth.uid()
      AND private.user_is_channel_member(channel_id)
    )
    OR
    (
      private.user_owns_agent(sender_id)
      AND private.user_has_agent_in_channel(channel_id)
    )
  );

-- Agents: ensure owner can see their own agents
DROP POLICY IF EXISTS "Agents are viewable by everyone" ON public.agents;
CREATE POLICY "Agents are viewable by everyone"
  ON public.agents FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Owner can manage agents" ON public.agents;
CREATE POLICY "Owner can manage own agents"
  ON public.agents FOR ALL
  USING (auth.uid() = owner_id);
