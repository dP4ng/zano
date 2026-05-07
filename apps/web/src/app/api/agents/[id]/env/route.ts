import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { normalizeEnvVars } from "@/lib/env-vars";

async function getOwnedAgent(id: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { supabase, user: null, agent: null };
  }

  const { data: agent } = await supabase
    .from("agents")
    .select("id")
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();

  return { supabase, user, agent };
}

// GET /api/agents/[id]/env — get owner-only per-agent env vars
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { supabase, user, agent } = await getOwnedAgent(id);

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const { data, error } = await supabase
    .from("agent_runtime_settings")
    .select("env_vars")
    .eq("agent_id", id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ env_vars: data?.env_vars ?? {} });
}

// PUT /api/agents/[id]/env — replace owner-only per-agent env vars
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { supabase, user, agent } = await getOwnedAgent(id);

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const body = await request.json();
  const envVars = normalizeEnvVars(body.env_vars);
  if (!envVars) {
    return NextResponse.json(
      { error: "env_vars must be an object of string values keyed by valid env names" },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("agent_runtime_settings")
    .upsert(
      {
        agent_id: id,
        env_vars: envVars,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "agent_id" }
    );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ env_vars: envVars });
}
