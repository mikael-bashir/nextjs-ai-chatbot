'use client';
import { ChevronDown, ChevronUp, CreditCard, Moon, Sun } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import type { User } from 'next-auth';
import { signOut } from 'next-auth/react';
import { useTheme } from 'next-themes';

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
              <Image
                src={user.image ?? `https://avatar.vercel.sh/${user.email}`}
                alt={user.name ?? user.email ?? 'User Avatar'}
                width={24}
                height={24}
                className="rounded-full shrink-0"
              />
              <span className="truncate text-sm">{user.name ?? user.email}</span>
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
