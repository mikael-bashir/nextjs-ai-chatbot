'use client';
import { ChevronDown, ChevronUp, CreditCard, Moon, Sun } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import type { User } from 'next-auth';
import { signOut } from 'next-auth/react';
import { useTheme } from 'next-themes';
import { useCredits } from '@/hooks/use-credits';

function AvatarOrInitial({ user, size = 24 }: { user: User; size?: number }) {
  const display = user.name ?? user.email ?? '';
  if (user.image) {
    return (
      <Image
        src={user.image}
        alt={display || 'User Avatar'}
        width={size}
        height={size}
        className="rounded-full shrink-0"
      />
    );
  }
  if (display) {
    return (
      <Image
        src={`https://avatar.vercel.sh/${encodeURIComponent(display)}`}
        alt={display}
        width={size}
        height={size}
        className="rounded-full shrink-0"
      />
    );
  }
  return (
    <div
      style={{ width: size, height: size, fontSize: size * 0.45 }}
      className="rounded-full bg-zinc-600 dark:bg-zinc-400 flex items-center justify-center text-white dark:text-zinc-900 font-medium shrink-0"
    >
      ?
    </div>
  );
}

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

interface Props {
  user: User;
  placement?: 'header' | 'footer';
}

export function SidebarUserNav({ user, placement = 'footer' }: Props) {
  const { setTheme, theme } = useTheme();
  const credits = useCredits();
  const isHeader = placement === 'header';
  const ChevronIcon = isHeader ? ChevronDown : ChevronUp;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              className={
                isHeader
                  ? 'data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground h-10 mt-1'
                  : 'data-[state=open]:bg-sidebar-accent bg-background data-[state=open]:text-sidebar-accent-foreground h-10'
              }
            >
              <AvatarOrInitial user={user} size={24} />
              <span className="truncate text-sm">{user.name ?? user.email}</span>
              {credits !== null && (
                <span className="ml-1 text-xs font-medium tabular-nums text-muted-foreground shrink-0">
                  £{credits.toFixed(2)}
                </span>
              )}
              <ChevronIcon className="ml-auto h-4 w-4 shrink-0 opacity-50" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>

          <DropdownMenuContent
            side={isHeader ? 'bottom' : 'top'}
            align="start"
            className="w-56"
          >
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col gap-0.5">
                {user.name && (
                  <span className="text-sm font-medium leading-none">{user.name}</span>
                )}
                <span className="text-xs leading-none text-muted-foreground truncate">
                  {user.email}
                </span>
                {credits !== null && (
                  <span className="text-xs font-semibold text-foreground mt-1">
                    {credits.toFixed(2)} credits
                  </span>
                )}
              </div>
            </DropdownMenuLabel>

            <DropdownMenuSeparator />

            <DropdownMenuItem asChild>
              <Link href="/account" className="flex items-center gap-2 cursor-pointer">
                <CreditCard className="h-4 w-4" />
                Account
              </Link>
            </DropdownMenuItem>

            <DropdownMenuItem
              className="cursor-pointer flex items-center gap-2"
              onSelect={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
              {`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuItem asChild>
              <button
                type="button"
                className="w-full cursor-pointer text-destructive focus:text-destructive"
                onClick={() => signOut({ redirectTo: '/' })}
              >
                Sign out
              </button>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
