import { WebSocketServer, type WebSocket } from "ws";

interface StoredEvent {
  id?: string;
  kind?: number;
  pubkey?: string;
  created_at?: number;
  tags?: string[][];
  content?: string;
  sig?: string;
}

/** Only public Nostr event fields are observable by browser tests. */
export interface PublicRelayEvent {
  id?: string;
  kind?: number;
  pubkey?: string;
  created_at?: number;
  tags?: string[][];
  content?: string;
  sig?: string;
}

export interface MockRelay {
  url: string;
  setBroadcastDelay: (milliseconds: number) => void;
  setPublishAcknowledgement: (accepted: boolean, delayMs?: number) => void;
  events: () => PublicRelayEvent[];
  close: () => Promise<void>;
}

export async function startMockRelay(port = 8765): Promise<MockRelay> {
  const server = new WebSocketServer({ port });
  const sockets = new Set<WebSocket>();
  const events: StoredEvent[] = [];
  const subscriptions = new Map<WebSocket, Array<{ id: string; filters: Filter[] }>>();
  let broadcastDelayMs = 0;
  let publishAccepted = true;
  let publishAcknowledgementDelayMs = 0;

  server.on("connection", (socket) => {
    sockets.add(socket);
    subscriptions.set(socket, []);
    socket.on("close", () => {
      sockets.delete(socket);
      subscriptions.delete(socket);
    });
    socket.on("message", (raw) => {
      let message: unknown;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!Array.isArray(message)) {
        return;
      }

      const [type, second] = message;
      if (type === "REQ" && typeof second === "string") {
        const filters = message.slice(2).filter(isFilter);
        subscriptions.get(socket)?.push({ id: second, filters });
        for (const event of events) {
          if (filters.some((filter) => matchesFilter(event, filter))) {
            socket.send(JSON.stringify(["EVENT", second, event]));
          }
        }
        socket.send(JSON.stringify(["EOSE", second]));
      }

      if (type === "EVENT") {
        const event = isStoredEvent(message[1]) ? message[1] : null;
        const eventId = event?.id ?? "";
        if (event) {
          events.push(event);
          if (publishAccepted) broadcastEvent(event, subscriptions, broadcastDelayMs);
        }
        const acknowledgement = JSON.stringify(["OK", eventId, publishAccepted, ""]);
        if (publishAcknowledgementDelayMs === 0) {
          socket.send(acknowledgement);
        } else {
          setTimeout(() => {
            if (socket.readyState === 1) socket.send(acknowledgement);
          }, publishAcknowledgementDelayMs);
        }
      }

      if (type === "CLOSE" && typeof second === "string") {
        const socketSubscriptions = subscriptions.get(socket);
        if (socketSubscriptions) {
          subscriptions.set(socket, socketSubscriptions.filter((subscription) => subscription.id !== second));
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.once("listening", resolve));

  return {
    url: `ws://127.0.0.1:${port}`,
    setBroadcastDelay(milliseconds) {
      broadcastDelayMs = Math.max(0, milliseconds);
    },
    setPublishAcknowledgement(accepted, delayMs = 0) {
      publishAccepted = accepted;
      publishAcknowledgementDelayMs = Math.max(0, delayMs);
    },
    events() {
      return events.map(copyPublicEvent);
    },
    close: async () => {
      for (const socket of sockets) {
        socket.close();
      }

      // A client that never completes the close handshake (for example a
      // browser context torn down mid-frame) would otherwise hold the server
      // open forever; force-terminate stragglers after a bounded grace period.
      const forceTerminate = setTimeout(() => {
        for (const socket of sockets) {
          socket.terminate();
        }
      }, 2_000);

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          clearTimeout(forceTerminate);
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

function copyPublicEvent(event: StoredEvent): PublicRelayEvent {
  return {
    id: event.id,
    kind: event.kind,
    pubkey: event.pubkey,
    created_at: event.created_at,
    tags: event.tags?.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  };
}

function broadcastEvent(
  event: StoredEvent,
  subscriptions: Map<WebSocket, Array<{ id: string; filters: Filter[] }>>,
  delayMs: number,
): void {
  for (const [socket, socketSubscriptions] of subscriptions) {
    if (socket.readyState !== 1) {
      continue;
    }

    for (const subscription of socketSubscriptions) {
      if (subscription.filters.some((filter) => matchesFilter(event, filter))) {
        const payload = JSON.stringify(["EVENT", subscription.id, event]);
        if (delayMs === 0) {
          socket.send(payload);
        } else {
          setTimeout(() => {
            if (socket.readyState === 1) socket.send(payload);
          }, delayMs);
        }
      }
    }
  }
}

function isStoredEvent(value: unknown): value is StoredEvent {
  return typeof value === "object" && value !== null;
}

interface Filter {
  ids?: string[];
  kinds?: number[];
  authors?: string[];
  since?: number;
  limit?: number;
  [key: `#${string}`]: string[] | undefined;
}

function isFilter(value: unknown): value is Filter {
  return typeof value === "object" && value !== null;
}

function matchesFilter(event: StoredEvent, filter: Filter): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind ?? -1)) {
    return false;
  }

  if (filter.authors && !filter.authors.includes(event.pubkey ?? "")) {
    return false;
  }

  if (filter.ids && !filter.ids.includes(event.id ?? "")) {
    return false;
  }

  if (typeof filter.since === "number" && (event.created_at ?? 0) < filter.since) {
    return false;
  }

  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#") || !values?.length) {
      continue;
    }

    const tagName = key.slice(1);
    const eventTagValues = event.tags?.filter((tag) => tag[0] === tagName).map((tag) => tag[1]) ?? [];
    if (!values.some((value: string) => eventTagValues.includes(value))) {
      return false;
    }
  }

  return true;
}
