import type { NostrSigner } from "@contextvm/sdk/core";
import { nip44, type EventTemplate, type NostrEvent } from "nostr-tools";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

export class BrowserNostrSigner implements NostrSigner {
  private privateKey: Uint8Array;
  private readonly publicKey: string;
  private destroyed = false;

  constructor(privateKey: Uint8Array) {
    this.privateKey = new Uint8Array(privateKey);
    this.publicKey = getPublicKey(this.privateKey);
  }

  async getPublicKey(): Promise<string> {
    return this.publicKey;
  }

  async signEvent(event: EventTemplate): Promise<NostrEvent> {
    this.assertActive();
    return finalizeEvent(event, this.privateKey);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.privateKey.fill(0);
    this.destroyed = true;
  }

  nip44 = {
    encrypt: async (pubkey: string, plaintext: string): Promise<string> => {
      this.assertActive();
      const conversationKey = nip44.v2.utils.getConversationKey(this.privateKey, pubkey);
      return nip44.v2.encrypt(plaintext, conversationKey);
    },
    decrypt: async (pubkey: string, ciphertext: string): Promise<string> => {
      this.assertActive();
      const conversationKey = nip44.v2.utils.getConversationKey(this.privateKey, pubkey);
      return nip44.v2.decrypt(ciphertext, conversationKey);
    },
  };

  private assertActive(): void {
    if (this.destroyed) throw new Error("Signer is no longer available");
  }
}
