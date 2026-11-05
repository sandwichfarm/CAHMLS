import type { RoomHostIdentity } from "@cahmls/sdk/client";
import type { StoredRoom } from "@cahmls/sdk/client";

export type ChatPaneConnection = "cached" | "connecting" | "connected" | "offline" | "deleted";

export interface ChatPaneContext {
  room: StoredRoom | null;
  host: RoomHostIdentity | null;
  connection: ChatPaneConnection | null;
  soundsEnabled: boolean;
  removalMode: "delete" | "leave" | null;
  toggleSounds?: () => void | Promise<void>;
  requestRemoval?: () => void;
}
