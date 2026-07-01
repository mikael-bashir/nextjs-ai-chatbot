"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useWindowSize } from "usehooks-ts"

import { ModelSelector } from "@/components/model-selector"
import { SidebarToggle } from "@/components/sidebar-toggle"
import { Button } from "@/components/ui/button"
import { PlusIcon } from "./icons"
import Image from "next/image"
import { useSidebar } from "./ui/sidebar"
import { memo } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip"
import { type VisibilityType, VisibilitySelector } from "./visibility-selector"
import { MCPServerManagement } from "./mcp-server-management"
import { LocalClaudeAgentManagement } from "./local-claude-agent-management"

function PureChatHeader({
  chatId,
  selectedModelId,
  selectedVisibilityType,
  isReadonly,
}: {
  chatId: string
  selectedModelId: string
  selectedVisibilityType: VisibilityType
  isReadonly: boolean
}) {
  const router = useRouter()
  const { open } = useSidebar()

  const { width: windowWidth } = useWindowSize()

  return (
    <header className="flex sticky top-0 bg-background py-1.5 items-center px-2 md:px-2 gap-2">
      <SidebarToggle />

      {(!open || windowWidth < 768) && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              className="order-2 md:order-1 md:px-2 px-2 md:h-fit ml-auto md:ml-0 bg-transparent"
              onClick={() => {
                router.push("/")
                router.refresh()
              }}
            >
              <PlusIcon />
              <span className="md:sr-only">New Chat</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>New Chat</TooltipContent>
        </Tooltip>
      )}

      {!isReadonly && <ModelSelector selectedModelId={selectedModelId} className="order-1 md:order-2" />}

      {!isReadonly && (
        <VisibilitySelector
          chatId={chatId}
          selectedVisibilityType={selectedVisibilityType}
          className="order-1 md:order-3"
        />
      )}

      {!isReadonly && <MCPServerManagement className="order-1 md:order-4" />}

      {!isReadonly && <LocalClaudeAgentManagement className="order-1 md:order-4" />}

      <Button
        className="bg-transparent dark:bg-zinc-100 hover:bg-gray-50 dark:hover:bg-zinc-200 text-zinc-50 dark:text-zinc-900 hidden md:flex py-1.5 px-2 h-fit md:h-[34px] order-5 md:ml-auto"
        asChild
      >
        <Link
          href={`https://competemath.com`}
          target="_noblank"
        >
        <p
          className="
            font-serif font-bold text-[13pt]
            bg-gradient-to-r from-amber-400 via-yellow-300 to-amber-500
            bg-[length:200%_auto]
            bg-clip-text text-transparent
            [filter:drop-shadow(0_0_5px_theme(colors.yellow.100))_drop-shadow(0_0_15px_theme(colors.amber.200))_drop-shadow(0_0_35px_theme(colors.amber.400/80%))]
            animate-shimmer
          "
        >
          CompeteMath
        </p>

        </Link>
      </Button>
    </header>
  )
}

export const ChatHeader = memo(PureChatHeader, (prevProps, nextProps) => {
  return prevProps.selectedModelId === nextProps.selectedModelId
})
