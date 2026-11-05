import { configureRoomEnvironment } from "@cahmls/sdk/client";
import { persistRemovedSidebarRoom } from "./chat/sidebar-ledger";
import { notificationCenter } from "./notifications/notification-center.svelte";

/** Connect the framework-free SDK room store to this application's UI services. */
configureRoomEnvironment({
  notifications: notificationCenter,
  onRoomRemoved: persistRemovedSidebarRoom,
});
