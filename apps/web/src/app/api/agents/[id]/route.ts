import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  defaultReasoningEffortForRuntime,
  defaultModelForRuntime,
  isValidModelForRuntime,
  isValidReasoningEffortForRuntime,
  normalizeAgentRuntime,
  runtimeSupportsReasoningEffort,
} from "@/lib/agent-runtime";

// GET /api/agents/[id] — get a single agent
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: agent, error } = await supabase
    .from("agents")
    .select("*")
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();

  if (error || !agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  return NextResponse.json({ agent });
}

// PUT /api/agents/[id] — update agent info
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify ownership
  const { data: existing } = await supabase
    .from("agents")
    .select("id, runtime")
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();

  if (!existing) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const body = await request.json();
  const updates: Record<string, unknown> = {};

  if (body.display_name !== undefined) {
    if (!body.display_name?.trim()) {
      return NextResponse.json(
        { error: "display_name cannot be empty" },
        { status: 400 }
      );
    }
    updates.display_name = body.display_name.trim();
  }
  if (body.description !== undefined) {
    updates.description = body.description?.trim() || null;
  }
  if (body.system_prompt !== undefined) {
    updates.system_prompt = body.system_prompt?.trim() || null;
  }
  const runtime = body.runtime !== undefined
    ? normalizeAgentRuntime(body.runtime)
    : normalizeAgentRuntime(existing.runtime);
  if (body.runtime !== undefined) {
    updates.runtime = runtime;
  }
  if (body.model !== undefined) {
    if (!isValidModelForRuntime(runtime, body.model)) {
      return NextResponse.json(
        { error: "model is not valid for the selected runtime" },
        { status: 400 }
      );
    }
    updates.model = body.model;
  } else if (body.runtime !== undefined) {
    updates.model = defaultModelForRuntime(runtime);
  }
  if (body.reasoning_effort !== undefined || body.runtime !== undefined) {
    if (!runtimeSupportsReasoningEffort(runtime)) {
      updates.reasoning_effort = null;
    } else if (body.reasoning_effort === undefined) {
      updates.reasoning_effort = defaultReasoningEffortForRuntime(runtime);
    } else if (isValidReasoningEffortForRuntime(runtime, body.reasoning_effort)) {
      updates.reasoning_effort = body.reasoning_effort;
    } else {
      return NextResponse.json(
        { error: "reasoning_effort is not valid for the selected runtime" },
        { status: 400 }
      );
    }
  }

  const { data: agent, error } = await supabase
    .from("agents")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ agent });
}

// DELETE /api/agents/[id] — delete agent + associated DM channel
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify ownership
  const { data: existing } = await supabase
    .from("agents")
    .select("id, server_id")
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();

  if (!existing) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const admin = createAdminClient();

  // Find and delete the DM channel (messages/channel members cascade via FK)
  const { data: dmMembership, error: membershipError } = await admin
    .from("channel_members")
    .select("channel_id")
    .eq("member_id", id)
    .eq("member_type", "agent");

  if (membershipError) {
    return NextResponse.json(
      { error: membershipError.message },
      { status: 500 }
    );
  }

  if (dmMembership) {
    const channelIds = dmMembership.map((m) => m.channel_id);
    if (channelIds.length > 0) {
      const { data: dmChannels, error: dmChannelError } = await admin
        .from("channels")
        .select("id")
        .in("id", channelIds)
        .eq("type", "dm");

      if (dmChannelError) {
        return NextResponse.json(
          { error: dmChannelError.message },
          { status: 500 }
        );
      }

      const dmChannelIds = (dmChannels ?? []).map((channel) => channel.id);
      if (dmChannelIds.length > 0) {
        const { error: dmDeleteError } = await admin
          .from("channels")
          .delete()
          .in("id", dmChannelIds);

        if (dmDeleteError) {
          return NextResponse.json(
            { error: dmDeleteError.message },
            { status: 500 }
          );
        }
      }
    }
  }

  // Remove agent from any group channels
  const { error: channelMemberError } = await admin
    .from("channel_members")
    .delete()
    .eq("member_id", id)
    .eq("member_type", "agent");
  if (channelMemberError) {
    return NextResponse.json(
      { error: channelMemberError.message },
      { status: 500 }
    );
  }

  const { error: serverMemberError } = await admin
    .from("server_members")
    .delete()
    .eq("server_id", existing.server_id)
    .eq("member_id", id)
    .eq("member_type", "agent");

  if (serverMemberError) {
    return NextResponse.json(
      { error: serverMemberError.message },
      { status: 500 }
    );
  }

  // Delete the agent
  const { error } = await admin.from("agents").delete().eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
