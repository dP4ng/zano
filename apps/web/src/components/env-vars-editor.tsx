"use client";

import { PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  createEnvVarEntry,
  isEnvVarKey,
  type EnvVarEntry,
} from "@/lib/env-vars";

interface EnvVarsEditorProps {
  entries: EnvVarEntry[];
  onChange: (entries: EnvVarEntry[]) => void;
}

export function EnvVarsEditor({ entries, onChange }: EnvVarsEditorProps) {
  function updateEntry(id: string, patch: Partial<EnvVarEntry>) {
    onChange(
      entries.map((entry) =>
        entry.id === id ? { ...entry, ...patch } : entry
      )
    );
  }

  function removeEntry(id: string) {
    onChange(entries.filter((entry) => entry.id !== id));
  }

  const invalidKeys = entries.filter(
    (entry) => entry.key.trim() && !isEnvVarKey(entry.key.trim())
  );

  return (
    <Field>
      <div className="flex items-center justify-between gap-3">
        <FieldLabel>Environment Variables</FieldLabel>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange([...entries, createEnvVarEntry()])}
        >
          <PlusIcon className="size-3.5" />
          Add
        </Button>
      </div>

      <div className="space-y-2">
        {entries.length === 0 ? (
          <div className="rounded-lg border px-3 py-3 text-sm text-muted-foreground">
            No variables set
          </div>
        ) : (
          entries.map((entry) => {
            const key = entry.key.trim();
            const invalid = key.length > 0 && !isEnvVarKey(key);
            return (
              <div key={entry.id} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                <Input
                  type="text"
                  value={entry.key}
                  onChange={(e) =>
                    updateEntry(entry.id, {
                      key: (e.target as HTMLInputElement).value,
                    })
                  }
                  placeholder="KEY"
                  aria-invalid={invalid}
                  className={invalid ? "border-destructive" : undefined}
                />
                <Input
                  type="password"
                  value={entry.value}
                  onChange={(e) =>
                    updateEntry(entry.id, {
                      value: (e.target as HTMLInputElement).value,
                    })
                  }
                  placeholder="value"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => removeEntry(entry.id)}
                  aria-label="Remove environment variable"
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            );
          })
        )}
      </div>

      {invalidKeys.length > 0 && (
        <p className="text-xs text-destructive">
          Variable names must use letters, numbers, and underscores, and cannot start with a number.
        </p>
      )}
    </Field>
  );
}
