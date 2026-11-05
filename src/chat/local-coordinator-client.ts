import { bytesToHex } from "nostr-tools/utils";
import { decodeWelcome } from "../cordn/mlsCodec";
import type { Coordinator } from "../cordn/coordinator";
import { assertNonEmptyBase64, encodeBase64 } from "../cordn/server/base64";
import type {
  ChatCoordinatorOperations,
  RemoteGroupMessage,
  RemoteJoinRequest,
  RemoteWelcome,
} from "./coordinator-client";

/**
 * Same-tab host client. A locally hosted room must not depend on an external
 * relay round-trip to reach the coordinator that is already running in this
 * browser tab. Remote clients continue to use ChatCoordinatorClient/Nostr.
 */
export class LocalHostCoordinatorClient implements ChatCoordinatorOperations {
  private readonly ephemeralSenderPubkey = bytesToHex(
    crypto.getRandomValues(new Uint8Array(32)),
  );

  constructor(private readonly coordinator: Coordinator) {}

  async close(): Promise<void> {}

  subscribeJoinRequests(
    groupId: string,
    listener: () => void | Promise<void>,
  ): () => void {
    return this.coordinator.subscribeJoinRequests(groupId, listener);
  }

  async fetchJoinRequests(
    groupId: string,
    consumed?: Array<{ pk: string; at: number }>,
  ): Promise<RemoteJoinRequest[]> {
    const records = this.coordinator.fetchManyPendingJoinRequests({
      groups: [{ groupId }],
      ...(consumed?.length
        ? {
            consumed: consumed.map(({ pk, at }) => ({
              groupId,
              requesterStablePubkey: pk,
              createdAt: at,
            })),
          }
        : {}),
    });
    return records.map((record) => ({
      gid: record.groupId,
      pk: record.requesterStablePubkey,
      kp_ref: record.keyPackageRef,
      at: record.createdAt,
      invite_token: record.inviteToken,
    }));
  }

  async consumeKeyPackage(
    identifier: string,
  ): Promise<{ pk: string; kp_ref: string; event: unknown } | null> {
    const record = this.coordinator.consumeKeyPackage(identifier);
    return record
      ? {
          pk: record.stablePubkey,
          kp_ref: record.keyPackageRef,
          event: record.publicationEvent,
        }
      : null;
  }

  async postGroupMessage(
    groupId: string,
    messageBase64: string,
  ): Promise<{ cursor: number; gid: string; at: number }> {
    const record = this.coordinator.postGroupMessage({
      groupId,
      ephemeralSenderPubkey: this.ephemeralSenderPubkey,
      opaqueMessage: assertNonEmptyBase64(messageBase64, "msg_64"),
    });
    return { cursor: record.cursor, gid: record.groupId, at: record.createdAt };
  }

  async storeWelcome(
    targetPubkey: string,
    keyPackageReference: string,
    welcomeBase64: string,
    after: number,
  ): Promise<void> {
    this.coordinator.storeWelcome({
      targetStablePubkey: targetPubkey,
      keyPackageReference,
      welcome: decodeWelcome(
        assertNonEmptyBase64(welcomeBase64, "welcome_64"),
        "welcome_64",
      ),
      joinAfterCursor: after,
    });
  }

  async fetchMessages(groupId: string, after?: number): Promise<RemoteGroupMessage[]> {
    return this.coordinator.fetchGroupMessages({
      groupId,
      afterCursor: after,
    }).map((record) => ({
      cursor: record.cursor,
      gid: record.groupId,
      msg_64: encodeBase64(record.opaqueMessage),
      at: record.createdAt,
    }));
  }

  async publishKeyPackage(): Promise<void> {
    throw new Error("A local host session cannot publish a guest key package");
  }

  async listOwnKeyPackageRefs(): Promise<string[]> {
    throw new Error("A local host session cannot list guest key packages");
  }

  async storeJoinRequest(): Promise<void> {
    throw new Error("A local host session cannot request guest admission");
  }

  async fetchWelcomes(): Promise<RemoteWelcome[]> {
    throw new Error("A local host session cannot consume guest Welcomes");
  }
}
