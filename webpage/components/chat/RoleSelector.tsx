'use client';

import { ChevronDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ChatRole } from '@/types/chat';

type RoleSelectorProps = {
  roles: ChatRole[];
  selectedRole: ChatRole;
  onRoleChange: (role: ChatRole) => void;
};

export function RoleSelector({
  roles,
  selectedRole,
  onRoleChange,
}: RoleSelectorProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="gap-2 font-medium">
          <span className="text-base">{selectedRole.icon}</span>
          <span>{selectedRole.name}</span>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        {roles.map((role) => (
          <DropdownMenuItem
            key={role.id}
            className="gap-2"
            onClick={() => onRoleChange(role)}
          >
            <span>{role.icon}</span>
            <span>{role.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
