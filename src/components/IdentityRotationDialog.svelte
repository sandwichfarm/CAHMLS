<script lang="ts">
  import { onMount, tick } from "svelte";

  interface Props {
    variant: "confirm" | "recovery";
    membershipCount: number;
    onConfirm: () => Promise<void>;
    onClose: () => void;
  }

  let { variant, membershipCount, onConfirm, onClose }: Props = $props();
  let dialog: HTMLDialogElement | undefined = $state();
  let safeButton: HTMLButtonElement | undefined = $state();
  let busy = $state(false);
  let error = $state("");
  const recoverableError = "Unable to rotate your identity. Your current identity and local room access are unchanged. Try again.";
  const isRecovery = $derived(variant === "recovery");
  const titleId = $derived(`identity-${variant}-title`);
  const descriptionId = $derived(`identity-${variant}-description`);
  const impact = $derived(membershipCount === 0
    ? "No active channels will be moved to History."
    : `You will lose access to ${membershipCount} channel${membershipCount === 1 ? "" : "s"}. ${membershipCount === 1 ? "It" : "They"} will be moved to History.`);

  onMount(() => {
    dialog?.showModal();
    if (!isRecovery) void tick().then(() => safeButton?.focus());
  });

  function requestClose(): void {
    if (!busy && !isRecovery) dialog?.close("cancel");
  }

  async function confirm(): Promise<void> {
    if (busy) return;
    const attemptedRecovery = isRecovery;
    busy = true;
    error = "";
    try {
      await onConfirm();
      dialog?.close("confirmed");
    } catch {
      busy = false;
      await tick();

      // A confirm action can cross the durable retirement boundary and switch
      // this surface into recovery before its promise rejects. In that state,
      // do not claim that the prior identity and access are unchanged.
      error = attemptedRecovery || !isRecovery ? recoverableError : "";
      if (!isRecovery) await tick().then(() => safeButton?.focus());
    }
  }
</script>

<dialog
  bind:this={dialog}
  class="identity-rotation-dialog"
  aria-labelledby={titleId}
  aria-describedby={descriptionId}
  data-testid="identity-rotation-dialog"
  oncancel={(event) => { event.preventDefault(); requestClose(); }}
  onclose={onClose}
  onclick={(event) => { if (event.target === dialog) requestClose(); }}
>
  <section class="dialog-card">
    <header>
      <div>
        {#if !isRecovery}<p>Privacy boundary</p>{/if}
        <h2 id={titleId}>{isRecovery ? "Recover local identity" : "Rotate local identity?"}</h2>
      </div>
      {#if !isRecovery}
        <button class="icon-close" type="button" aria-label="Close identity rotation dialog" disabled={busy} onclick={requestClose}>×</button>
      {/if}
    </header>
    <div class="dialog-body" id={descriptionId}>
      {#if isRecovery}
        <p>Saved local identity data on this device could not be verified. Create a new device-local identity to continue. Local room access will be removed, and new invites are required before sending to those rooms again.</p>
      {:else}
        <p class="impact">{impact}</p>
        {#if membershipCount === 0}
          <h3>No local room memberships</h3>
          <p>This identity has no locally stored room access to remove.</p>
        {/if}
        <p>This creates a new device-local identity. Previous channels remain as read-only local history, but you’ll need a new invite before you can send in them again. This does not delete coordinator-hosted room data for other participants.</p>
      {/if}
      {#if busy}<p class="live" aria-live="polite">{isRecovery ? "Creating…" : "Rotating…"}</p>{/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>
    <footer>
      {#if !isRecovery}
        <button bind:this={safeButton} class="safe" type="button" disabled={busy} onclick={requestClose}>Keep current identity</button>
      {/if}
      <button class="confirm" type="button" disabled={busy} onclick={() => void confirm()}>{busy ? (isRecovery ? "Creating…" : "Rotating…") : (isRecovery ? "Create new identity" : "Rotate identity")}</button>
    </footer>
  </section>
</dialog>

<style>
  .identity-rotation-dialog { width: min(29rem, calc(100vw - 1rem)); max-width: none; max-height: calc(100dvh - 1rem); margin: auto; border: 1px solid #3e342f; background: transparent; padding: 0; color: #e8f5eb; box-shadow: 0 28px 90px rgb(0 0 0 / .72); }
  .identity-rotation-dialog::backdrop { background: #030303; }
  .dialog-card { display: grid; max-height: calc(100dvh - 1rem); grid-template-rows: auto minmax(0, 1fr) auto; background: #09100c; }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 16px; border-bottom: 1px solid #3e342f; }
  header div { min-width: 0; }
  header p { color: #ffaaa3; font-size: 10px; font-weight: 400; line-height: 1.3; letter-spacing: .16em; text-transform: uppercase; }
  h2 { color: #fff5f2; font-size: 18px; font-weight: 650; line-height: 1.2; overflow-wrap: anywhere; }
  header p + h2 { margin-top: 4px; }
  .icon-close { display: grid; width: 44px; height: 44px; flex: 0 0 auto; place-items: center; border: 0; background: transparent; color: #8e7d76; font-size: 18px; font-weight: 400; }
  .icon-close:hover { background: #1d1512; color: #fff5f2; }
  .dialog-body { min-height: 0; overflow-y: auto; padding: 1rem; color: #c5d3c8; font-size: 12px; font-weight: 400; line-height: 1.5; overflow-wrap: anywhere; }
  .dialog-body p + p, .dialog-body h3 + p { margin-top: 1rem; }
  .impact { color: #effff2; font-size: 14px; font-weight: 650; line-height: 1.4; }
  h3 { margin-top: 1rem; color: #effff2; font-size: 14px; font-weight: 650; line-height: 1.4; }
  .error { margin-top: 1rem; border: 1px solid #773c3a; background: #24100f; padding: 12px; color: #ffaaa3; }
  .live { margin-top: 1rem; color: #91a59a; }
  footer { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; border-top: 1px solid #3e342f; padding: 12px; }
  footer:has(.confirm:only-child) { grid-template-columns: minmax(0, 1fr); }
  footer button { min-height: 44px; padding: 12px 16px; font-size: 12px; font-weight: 400; }
  .safe { border: 1px solid #405348; color: #b9cbbf; }
  .safe:hover { border-color: #87ff9f; color: #effff2; }
  .confirm { border: 1px solid #dc6f66; background: #dc6f66; color: #190907; }
  .confirm:hover { border-color: #ffaaa3; background: #ffaaa3; }
  button:focus-visible { outline: 2px solid #87ff9f; outline-offset: 2px; }
  button:disabled { cursor: wait; opacity: .5; }
</style>
