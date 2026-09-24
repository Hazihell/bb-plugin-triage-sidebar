// Vendored from bb's own component source (@bb registry "dropdown-menu",
// desktop-v0.43.4), trimmed to the desktop menu this plugin uses. bb's copy
// also turns into a bottom drawer on compact viewports; these menus are small
// enough that Radix's own collision handling keeps them on screen there.
import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";

import { cn } from "../lib/utils";
import { usePortalScopeProps } from "../lib/portal-scope";
import { isLastInputKeyboard } from "../lib/input-modality";
import {
  MENU_ITEM_LAST_HOVERED_CLASS,
  MenuHoverProvider,
  useMenuItemHover,
} from "./menu-item-hover";

const LIST_HOVER_TRANSITION = "transition-none";
const MENU_ITEM_NEUTRAL_STATE_CLASS =
  "focus:bg-state-hover focus:text-foreground data-[last-hovered]:bg-state-hover data-[last-hovered]:text-foreground";

const DropdownMenu = DropdownMenuPrimitive.Root;

const DropdownMenuTrigger = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Trigger
    ref={ref}
    className={cn("select-none", className)}
    // Opening a menu must not start a text selection under the pointer.
    onMouseDown={(event) => event.preventDefault()}
    {...props}
  />
));
DropdownMenuTrigger.displayName = DropdownMenuPrimitive.Trigger.displayName;

const DropdownMenuContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, children, onCloseAutoFocus, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      {...usePortalScopeProps()}
      sideOffset={sideOffset}
      // Focus goes back to the trigger only for a keyboard user; after a
      // click it would leave a focus ring on a button nobody is looking at.
      onCloseAutoFocus={(event) => {
        if (!isLastInputKeyboard()) event.preventDefault();
        onCloseAutoFocus?.(event);
      }}
      className={cn(
        "z-50 min-w-28 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className,
      )}
      {...props}
    >
      <MenuHoverProvider>{children}</MenuHoverProvider>
    </DropdownMenuPrimitive.Content>
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

const DropdownMenuItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>
>(
  (
    {
      className,
      onPointerEnter: callerPointerEnter,
      onKeyDown: callerKeyDown,
      ...props
    },
    ref,
  ) => {
    const { hoverProps } = useMenuItemHover({
      onPointerEnter: callerPointerEnter,
      onKeyDown: callerKeyDown,
    });
    return (
      <DropdownMenuPrimitive.Item
        ref={ref}
        className={cn(
          "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-[0.3125rem] text-xs outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
          LIST_HOVER_TRANSITION,
          MENU_ITEM_NEUTRAL_STATE_CLASS,
          className,
        )}
        {...props}
        {...hoverProps}
      />
    );
  },
);
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

const DropdownMenuLabel = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn(
      "px-2 py-[0.3125rem] text-xs font-medium text-muted-foreground",
      className,
    )}
    {...props}
  />
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
};
