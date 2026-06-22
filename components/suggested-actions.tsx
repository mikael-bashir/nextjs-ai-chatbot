"use client"

import { motion } from "framer-motion"
import { Button } from "./ui/button"
import { memo } from "react"
import type { UIMessage } from "@/hooks/use-leak-chat"

interface SuggestedActionsProps {
  chatId: string
  append: (message: UIMessage) => Promise<string | null | undefined>
}

function PureSuggestedActions({ chatId, append }: SuggestedActionsProps) {
  const suggestedActions = [
    {
      title: "Prove in Lean 4",
      label: "that the sum of two even numbers is even",
      action: "Prove in Lean 4 that the sum of two even numbers is even. Use sorry to fill any gaps.",
    },
    {
      title: "Prove in Lean 4",
      label: "that there are infinitely many primes",
      action: "Prove in Lean 4 that there are infinitely many primes. Use sorry to fill any gaps.",
    },
    {
      title: "Prove in Lean 4",
      label: "that √2 is irrational",
      action: "Prove in Lean 4 that √2 is irrational. Use sorry to fill any gaps.",
    },
    {
      title: "Prove in Lean 4",
      label: "the pigeonhole principle",
      action: "Prove in Lean 4 the pigeonhole principle. Use sorry to fill any gaps.",
    },
  ]

  return (
    <div data-testid="suggested-actions" className="grid sm:grid-cols-2 gap-2 w-full">
      {suggestedActions.map((suggestedAction, index) => (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          transition={{ delay: 0.05 * index }}
          key={`suggested-action-${suggestedAction.title}-${index}`}
          className={index > 1 ? "hidden sm:block" : "block"}
        >
          <Button
            variant="ghost"
            onClick={async () => {
              window.history.replaceState({}, "", `/chat/${chatId}`)

              await append({
                role: "user",
                content: suggestedAction.action,
                id: `suggested-${Date.now()}`,
                parts: [{ type: "text", text: suggestedAction.action }],
              })
            }}
            className="text-left border rounded-xl px-4 py-3.5 text-sm flex-1 gap-1 sm:flex-col w-full h-auto justify-start items-start"
          >
            <span className="font-medium">{suggestedAction.title}</span>
            <span className="text-muted-foreground">{suggestedAction.label}</span>
          </Button>
        </motion.div>
      ))}
    </div>
  )
}

export const SuggestedActions = memo(PureSuggestedActions, () => true)
