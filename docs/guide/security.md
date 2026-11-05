# Security

## What a coordinator can see

A coordinator stores MLS ciphertext, KeyPackages, Welcomes, and routing metadata. It cannot read messages, but it can see group ids, public keys, timing, and message sizes, and it can withhold or reorder delivery.

## Secrets

- Never log private keys, invite tokens, or decrypted content. `consoleServerLogger` deliberately discards everything.
- `StoredRoom` contains MLS private state in `stateBase64` and `keyPackage.privateBase64`. Your `RoomStorage` must protect it to the same level as a private key.
- `KeyManager.destroy()` and `BrowserNostrSigner` zero their key material where JavaScript allows. Strings and copies made elsewhere cannot be wiped.
- Prefer `getSecretKeyBytes()` for the shortest possible time, and call `.fill(0)` on the copy when finished.

## Authentication

::: warning
MLS credentials are not verified against an external identity service. The SDK uses `ts-mls`'s `unsafeTestingAuthenticationService`, so group membership does not by itself prove who controls a Nostr key. Application messages carry `sender` in MLS authenticated data, and CAHMLS-signed envelopes are verified with `hasValidChatEnvelopeAuth()`.
:::

Do not trust display names, avatars, or badges in an envelope without checking it:

- `sanitizeChatEnvelopeHostBadge()` removes role badges not signed by the verified host.
- `reconcileRoomHostIdentity()` keeps host details only when they match the creator key in MLS state.
- `requireRoomSigner()` rejects signers that do not own the room's identity.

## Relays

Relays see encrypted gift wraps, public keys, and timing. Invite links contain relay hints and the group id, and sometimes a token, so share them only with intended members.

## Reporting a vulnerability

Do not open a public issue. Contact the maintainers privately through the repository's security reporting channel.
