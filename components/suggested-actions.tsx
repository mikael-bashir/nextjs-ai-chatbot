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
      title: "Even + Even = Even",
      label: "complete this Lean 4 proof",
      action: "theorem even_add_even (a b : ℤ) (ha : Even a) (hb : Even b) : Even (a + b) := by sorry",
    },
    {
      title: "Infinitely many primes",
      label: "complete this Lean 4 proof",
      action: "theorem infinitely_many_primes : ∀ n : ℕ, ∃ p, p > n ∧ Nat.Prime p := by sorry",
    },
    {
      title: "√2 is irrational",
      label: "complete this Lean 4 proof",
      action: "theorem sqrt_two_irrational : Irrational (Real.sqrt 2) := by sorry",
    },
    {
      title: "Pigeonhole principle",
      label: "complete this Lean 4 proof",
      action: "theorem pigeonhole {α β : Type*} [Fintype α] [Fintype β] (f : α → β) (h : Fintype.card β < Fintype.card α) : ∃ x y : α, x ≠ y ∧ f x = f y := by sorry",
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
