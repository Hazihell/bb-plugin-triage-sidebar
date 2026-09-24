// Vendored from bb's own component source (@bb registry "context-menu",
// desktop-v0.43.4), trimmed to the parts this plugin uses: checkbox, radio
// and shortcut items are gone, and the icon is this plugin's own.
import * as React from "react";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";

import { cn } from "../lib/utils";
import { usePortalScopeProps } from "../lib/portal-scope";
import {
  MENU_ITEM_LAST_HOVERED_CLASS,
  MenuHoverProvider,
  useMenuItemHover,
} from "./menu-item-hover";
import { Icon } from "./Icon";

const LIST_HOVER_TRANSITION = "transition-none";
const CONTEXT_MENU_LAYER_CLASS = "z-[70]";
const CONTENT_CLASS =
  "min-w-28 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2";

const ContextMenu = ContextMenuPrimitive.Root;
const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
const ContextMenuPortal = ContextMenuPrimitive.Portal;
const ContextMenuSub = ContextMenuPrimitive.Sub;

const ContextMenuSubTrigger = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger>
>(
  (
    {
      className,
      children,
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
      <ContextMenuPrimitive.SubTrigger
        ref={ref}
        className={cn(
          "flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-[0.3125rem] text-xs outline-none focus:bg-state-hover focus:text-foreground data-[state=open]:bg-state-active data-[state=open]:text-foreground",
          LIST_HOVER_TRANSITION,
          MENU_ITEM_LAST_HOVERED_CLASS,
          className,
        )}
        {...props}
        {...hoverProps}
      >
        {children}
        <Icon name="ChevronRight" className="ml-auto size-3.5" aria-hidden />
      </ContextMenuPrimitive.SubTrigger>
    );
  },
);
ContextMenuSubTrigger.displayName = ContextMenuPrimitive.SubTrigger.displayName;

const ContextMenuSubContent = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
>(({ className, children, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.SubContent
      ref={ref}
      {...usePortalScopeProps()}
      className={cn(CONTEXT_MENU_LAYER_CLASS, CONTENT_CLASS, className)}
      {...props}
    >
      <MenuHoverProvider>{children}</MenuHoverProvider>
    </ContextMenuPrimitive.SubContent>
  </ContextMenuPrimitive.Portal>
));
ContextMenuSubContent.displayName = ContextMenuPrimitive.SubContent.displayName;

const ContextMenuContent = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      ref={ref}
      {...usePortalScopeProps()}
      className={cn(CONTEXT_MENU_LAYER_CLASS, CONTENT_CLASS, className)}
      {...props}
    >
      <MenuHoverProvider>{children}</MenuHoverProvider>
    </ContextMenuPrimitive.Content>
  </ContextMenuPrimitive.Portal>
));
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName;

const ContextMenuItem = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
    variant?: "default" | "destructive";
  }
>(
  (
    {
      className,
      variant = "default",
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
      <ContextMenuPrimitive.Item
        ref={ref}
        className={cn(
          "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-[0.3125rem] text-xs outline-none focus:bg-state-hover focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
          LIST_HOVER_TRANSITION,
          MENU_ITEM_LAST_HOVERED_CLASS,
          variant === "destructive" &&
            "text-destructive focus:bg-destructive/15 focus:text-destructive data-[last-hovered]:bg-destructive/15 data-[last-hovered]:text-destructive",
          className,
        )}
        {...props}
        {...hoverProps}
      />
    );
  },
);
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName;

const ContextMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-muted", className)}
    {...props}
  />
));
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName;

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
};
