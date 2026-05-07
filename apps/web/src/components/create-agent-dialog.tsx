"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  MODEL_ITEMS_BY_RUNTIME,
  REASONING_EFFORT_ITEMS,
  RUNTIME_ITEMS,
  defaultReasoningEffortForRuntime,
  defaultModelForRuntime,
  runtimeSupportsModelSelection,
  runtimeSupportsReasoningEffort,
  type AgentReasoningEffort,
  type AgentRuntime,
} from "@/lib/agent-runtime";
import { EnvVarsEditor } from "./env-vars-editor";
import {
  envEntriesToRecord,
  type EnvVarEntry,
} from "@/lib/env-vars";

interface CreateAgentDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  serverId: string;
}

export function CreateAgentDialog({
  open,
  onClose,
  onCreated,
  serverId,
}: CreateAgentDialogProps) {
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [runtime, setRuntime] = useState<AgentRuntime>("claude");
  const [model, setModel] = useState("opus");
  const [reasoningEffort, setReasoningEffort] =
    useState<AgentReasoningEffort | null>(null);
  const [envVars, setEnvVars] = useState<EnvVarEntry[]>([]);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      queueMicrotask(() => {
        setDisplayName("");
        setDescription("");
        setRuntime("claude");
        setModel("opus");
        setReasoningEffort(null);
        setEnvVars([]);
        setSystemPrompt("");
        setError("");
      });
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!displayName.trim()) return;

    setSaving(true);
    setError("");

    try {
      const supabase = createClient();
      await supabase.auth.getSession();

      const res = await fetch("/api/agents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: document.cookie,
        },
        body: JSON.stringify({
          display_name: displayName,
          description,
          runtime,
          model,
          reasoning_effort: reasoningEffort,
          env_vars: envEntriesToRecord(envVars),
          system_prompt: systemPrompt,
          server_id: serverId,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create agent");
      }

      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setSaving(false);
    }
  }

  const modelItems = MODEL_ITEMS_BY_RUNTIME[runtime];
  const selectedRuntime = RUNTIME_ITEMS.find((item) => item.value === runtime) ?? RUNTIME_ITEMS[0];
  const selectedModel = modelItems.find((m) => m.value === model) ?? modelItems[0];
  const selectedReasoningEffort =
    REASONING_EFFORT_ITEMS.find((item) => item.value === reasoningEffort) ??
    REASONING_EFFORT_ITEMS[1];
  const showModelSelect = runtimeSupportsModelSelection(runtime);
  const showReasoningSelect = runtimeSupportsReasoningEffort(runtime);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Create Agent</DialogTitle>
          <DialogDescription>Add a new AI agent to your workspace.</DialogDescription>
        </DialogHeader>
        <form className="contents" onSubmit={handleSubmit}>
          <DialogPanel>
            <div className="space-y-4">
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName((e.target as HTMLInputElement).value)}
                  placeholder="e.g. Design Assistant, Code Reviewer..."
                  required
                  autoFocus
                />
              </Field>

              <Field>
                <FieldLabel>
                  Description <span className="text-muted-foreground font-normal">(optional)</span>
                </FieldLabel>
                <Input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription((e.target as HTMLInputElement).value)}
                  placeholder="What does this agent do?"
                />
              </Field>

              <Field>
                <FieldLabel>Runtime</FieldLabel>
                <Select
                  value={selectedRuntime}
                  onValueChange={(val) => {
                    if (!val) return;
                    const nextRuntime = (val as typeof selectedRuntime).value;
                    setRuntime(nextRuntime);
                    setModel(defaultModelForRuntime(nextRuntime));
                    setReasoningEffort(defaultReasoningEffortForRuntime(nextRuntime));
                  }}
                  items={RUNTIME_ITEMS}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a runtime" />
                  </SelectTrigger>
                  <SelectPopup>
                    {RUNTIME_ITEMS.map((item) => (
                      <SelectItem key={item.value} value={item}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>

              {showModelSelect && (
                <Field>
                  <FieldLabel>Model</FieldLabel>
                  <Select
                    value={selectedModel}
                    onValueChange={(val) => {
                      if (val) setModel((val as typeof selectedModel).value);
                    }}
                    items={modelItems}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a model" />
                    </SelectTrigger>
                    <SelectPopup>
                      {modelItems.map((item) => (
                        <SelectItem key={item.value} value={item}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </Field>
              )}

              {showReasoningSelect && (
                <Field>
                  <FieldLabel>Reasoning</FieldLabel>
                  <Select
                    value={selectedReasoningEffort}
                    onValueChange={(val) => {
                      if (val) {
                        setReasoningEffort(
                          (val as typeof selectedReasoningEffort).value
                        );
                      }
                    }}
                    items={REASONING_EFFORT_ITEMS}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select reasoning" />
                    </SelectTrigger>
                    <SelectPopup>
                      {REASONING_EFFORT_ITEMS.map((item) => (
                        <SelectItem key={item.value} value={item}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </Field>
              )}

              <EnvVarsEditor entries={envVars} onChange={setEnvVars} />

              <Field>
                <FieldLabel>
                  Instructions <span className="text-muted-foreground font-normal">(optional)</span>
                </FieldLabel>
                <Textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt((e.target as HTMLTextAreaElement).value)}
                  placeholder="Tell the agent how to behave, what it's good at, what tools to use..."
                />
              </Field>

              {error && (
                <p className="text-sm text-destructive">{error}</p>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" type="button" />}>
              Cancel
            </DialogClose>
            <Button type="submit" loading={saving} disabled={!displayName.trim()}>
              Create Agent
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
