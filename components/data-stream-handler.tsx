"use client"
import type { Suggestion } from "@/lib/db/schema"
import { useArtifact } from "@/hooks/use-artifact"

export type DataStreamDelta = {
  type:
    | "text-delta"
    | "code-delta"
    | "sheet-delta"
    | "image-delta"
    | "title"
    | "id"
    | "suggestion"
    | "clear"
    | "finish"
    | "kind"
  content: string | Suggestion
}

export function DataStreamHandler({ id }: { id: string }) {
  const { artifact, setArtifact, setMetadata } = useArtifact()

  return null
}
