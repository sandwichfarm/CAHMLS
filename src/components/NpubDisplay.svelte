<script lang="ts">
  import type { CoordinatorIdentity } from "@cahmls/sdk/crypto";

  interface Props {
    identity: CoordinatorIdentity;
  }

  let { identity }: Props = $props();
  let copied = $state(false);

  const truncated = $derived(`${identity.npub.slice(0, 12)}…${identity.npub.slice(-8)}`);

  async function copyPubkey(): Promise<void> {
    await navigator.clipboard.writeText(identity.publicKeyHex);
    copied = true;
    window.setTimeout(() => {
      copied = false;
    }, 1200);
  }
</script>

<button
  class="identity-key"
  type="button"
  aria-label="Copy coordinator public key"
  onclick={copyPubkey}
>
  <span class="key-glyph" aria-hidden="true">⌁</span>
  <span class="key-copy">
    <span>Coordinator key</span>
    <strong>{truncated}</strong>
  </span>
  <span class="copy-state">{copied ? "Copied" : "Copy"}</span>
</button>

<style>
  .identity-key { display: grid; width: 100%; max-width: 26rem; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: .7rem; border: 1px solid #293832; background: #090e0b; padding: .7rem .75rem; color: #b9cbbf; text-align: left; }
  .identity-key:hover { border-color: #496451; background: #0e1711; }
  .key-glyph { display: grid; width: 2rem; height: 2rem; place-items: center; border: 1px solid #365342; background: #101c14; color: #7cf59d; }
  .key-copy { min-width: 0; }
  .key-copy span, .key-copy strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .key-copy span { color: #708177; font-size: .55rem; letter-spacing: .12em; text-transform: uppercase; }
  .key-copy strong { margin-top: .28rem; color: #cde4d2; font-size: .7rem; font-weight: 500; }
  .copy-state { color: #7c9182; font-size: .58rem; }
  .identity-key:hover .copy-state { color: #7cf59d; }
</style>
