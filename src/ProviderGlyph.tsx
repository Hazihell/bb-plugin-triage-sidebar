import {
  experimental_ProviderIcon as ProviderIcon,
  type PluginProvidersState,
} from "@get-bb/plugin-sdk/app";
import { cn } from "./lib/utils";
import { TRAILING_GLYPH_BOX_CLASS } from "./StatusSlot";

/** One agent provider as bb's provider directory reports it. */
export type ProviderRecord = PluginProvidersState["providers"][number];

/**
 * The agent a thread runs on, drawn with bb's own provider artwork.
 *
 * Always rendered, so the card's third line has a fixed right edge even when
 * a thread has no branch. The record comes from the host's provider
 * directory; until it arrives, or for a provider it does not list, an id-only
 * record still draws any frontend-registered artwork or bb's neutral
 * fallback, and the id stands in for the name.
 */
export function ProviderGlyph({
  providerId,
  provider,
  className,
}: {
  providerId: string;
  provider: ProviderRecord | null;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={provider?.displayName ?? providerId}
      className={cn(TRAILING_GLYPH_BOX_CLASS, className)}
    >
      <ProviderIcon
        providerKind="agent"
        provider={provider ?? { id: providerId }}
        aria-hidden
        className="size-3 text-muted-foreground/70"
      />
    </span>
  );
}
