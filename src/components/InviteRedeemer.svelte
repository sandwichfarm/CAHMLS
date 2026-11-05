<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { parseInviteUrl } from "@cahmls/sdk/client";
  import { createSameShellChatHref } from "../chat/room-navigation";

  interface Props {
    onNavigate: (href: string) => void;
  }

  interface BarcodeDetection {
    rawValue?: string;
  }

  interface BarcodeDetectorInstance {
    detect(source: HTMLVideoElement): Promise<BarcodeDetection[]>;
  }

  interface BarcodeDetectorConstructor {
    new (options: { formats: string[] }): BarcodeDetectorInstance;
  }

  let { onNavigate }: Props = $props();
  let open = $state(false);
  let rawValue = $state("");
  let error = $state("");
  let busy = $state(false);
  let scanning = $state(false);
  let trigger: HTMLButtonElement | undefined = $state();
  let dialog: HTMLDivElement | undefined = $state();
  let input: HTMLTextAreaElement | undefined = $state();
  let video: HTMLVideoElement | undefined = $state();
  let stream: MediaStream | null = null;
  let detectionFrame: number | null = null;
  let scanToken = 0;

  function openDialog(): void {
    error = "";
    open = true;
    void tick().then(() => input?.focus());
  }

  function stopScanner(): void {
    scanToken += 1;
    if (detectionFrame !== null) window.cancelAnimationFrame(detectionFrame);
    detectionFrame = null;
    if (video) {
      video.pause();
      video.srcObject = null;
    }
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    scanning = false;
  }

  function closeDialog(): void {
    stopScanner();
    open = false;
    busy = false;
    error = "";
    void tick().then(() => trigger?.focus());
  }

  function redeem(value: string): boolean {
    if (busy) return false;
    const invite = parseInviteUrl(value.trim());
    if (!invite) {
      error = "Paste a valid invite link or scan its QR code.";
      return false;
    }

    busy = true;
    error = "";
    const href = new URL(createSameShellChatHref(window.location.origin, invite));
    href.searchParams.set("autojoin", "1");
    stopScanner();
    open = false;
    onNavigate(href.href);
    // The unified workspace remains mounted after navigation, so reset the
    // dialog for a later invite instead of relying on component teardown.
    rawValue = "";
    busy = false;
    return true;
  }

  function submit(): void {
    redeem(rawValue);
  }

  function unavailable(message: string): void {
    stopScanner();
    error = message;
  }

  async function startScan(): Promise<void> {
    if (busy || scanning) return;
    error = "";
    const getUserMedia = navigator.mediaDevices?.getUserMedia;
    const Detector = (globalThis as typeof globalThis & { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
    if (!getUserMedia) {
      unavailable("Camera access is not available in this browser. You can still paste an invite link.");
      return;
    }
    if (!Detector) {
      unavailable("QR scanning is not available in this browser. You can still paste an invite link.");
      return;
    }

    const token = ++scanToken;
    scanning = true;
    try {
      const acquired = await getUserMedia.call(navigator.mediaDevices, {
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
      if (!open || token !== scanToken) {
        for (const track of acquired.getTracks()) track.stop();
        return;
      }
      stream = acquired;
      if (!video) {
        unavailable("Camera preview could not start. You can still paste an invite link.");
        return;
      }
      video.srcObject = acquired;
      void video.play().catch(() => {
        if (open && token === scanToken) error = "Camera preview could not play. You can still paste an invite link.";
      });
      if (!open || token !== scanToken) return;
      const detector = new Detector({ formats: ["qr_code"] });
      detectNext(detector, token);
    } catch (cause) {
      if (token !== scanToken) return;
      const name = cause instanceof DOMException ? cause.name : "";
      unavailable(name === "NotAllowedError"
        ? "Camera permission was denied. You can still paste an invite link."
        : name === "NotFoundError"
          ? "No camera was found. You can still paste an invite link."
          : "The camera could not start. You can still paste an invite link.");
    }
  }

  async function detectNext(detector: BarcodeDetectorInstance, token: number): Promise<void> {
    if (!open || token !== scanToken || !video) return;
    try {
      const result = await detector.detect(video);
      if (!open || token !== scanToken) return;
      const payload = result.find((candidate) => candidate.rawValue?.trim())?.rawValue;
      if (payload && redeem(payload)) return;
    } catch {
      if (!open || token !== scanToken) return;
      error = "Unable to read that QR code yet. Hold it steady or paste the invite link.";
    }
    if (open && token === scanToken) detectionFrame = window.requestAnimationFrame(() => void detectNext(detector, token));
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (event.key !== "Tab" || !open || !dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  onDestroy(stopScanner);
</script>

<svelte:window onkeydown={handleKeydown} />

<button bind:this={trigger} class="redeem-trigger" type="button" onclick={openDialog} aria-haspopup="dialog" aria-expanded={open}>
  <span>Join from invite</span><span aria-hidden="true">＋</span>
</button>

{#if open}
  <div class="redeemer-layer" data-testid="invite-redeemer">
    <button class="redeemer-scrim" type="button" aria-label="Close invite redemption" onclick={closeDialog}></button>
    <div bind:this={dialog} class="redeemer-dialog" role="dialog" aria-modal="true" aria-labelledby="redeemer-title">
      <header>
        <div>
          <p>Join a remote room</p>
          <h2 id="redeemer-title">Join from invite</h2>
        </div>
        <button class="close" type="button" aria-label="Close invite redemption" onclick={closeDialog}>×</button>
      </header>
      <form onsubmit={(event) => { event.preventDefault(); submit(); }}>
        <label for="invite-link">Invite link</label>
        <textarea
          id="invite-link"
          bind:this={input}
          bind:value={rawValue}
          rows="3"
          autocomplete="off"
          placeholder="Paste an invite link"
          disabled={busy}
          oninput={() => error = ""}
        ></textarea>
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        <div class="actions">
          <button class="scan" type="button" disabled={busy || scanning} onclick={() => void startScan()}>{scanning ? "Scanning…" : "Scan QR code"}</button>
          <button class="join" type="submit" disabled={busy}>{busy ? "Joining…" : "Join invite"}</button>
        </div>
      </form>
      {#if scanning}
        <div class="scanner" aria-live="polite">
          <video bind:this={video} muted playsinline aria-label="Camera preview for QR scanning"></video>
          <p>Point your camera at an invite QR code.</p>
          <button type="button" onclick={stopScanner}>Stop camera</button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .redeem-trigger { display: flex; width: 100%; min-height: 2.75rem; align-items: center; justify-content: space-between; border: 0; border-bottom: 1px solid #293832; background: #101814; padding: .6rem .75rem; color: #dfffe7; font: inherit; font-size: .67rem; font-weight: 650; cursor: pointer; }
  .redeem-trigger > span:last-child { color: #7cf59d; font-size: .9rem; font-weight: 400; }
  .redeem-trigger:hover, .redeem-trigger[aria-expanded="true"] { background: #17241b; color: #fff; }
  .redeemer-layer, .redeemer-scrim { position: fixed; z-index: 100; inset: 0; }
  .redeemer-scrim { border: 0; background: rgb(0 0 0 / .58); backdrop-filter: blur(2px); }
  .redeemer-dialog { position: fixed; z-index: 101; top: 50%; left: 50%; width: min(30rem, calc(100vw - 1.5rem)); transform: translate(-50%, -50%); border: 1px solid #496451; background: #0b0e0d; box-shadow: 0 24px 64px rgb(0 0 0 / .62); padding: 1rem; color: #e8f5eb; }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: .9rem; }
  header p { margin: 0; color: #7cf59d; font-size: .62rem; letter-spacing: .08em; text-transform: uppercase; }
  header h2 { margin: .2rem 0 0; font-size: 1rem; }
  .close { border: 0; background: transparent; color: #91a59a; font-size: 1.35rem; line-height: 1; cursor: pointer; }
  label { display: block; margin-bottom: .35rem; color: #c5d4c9; font-size: .7rem; }
  textarea { box-sizing: border-box; width: 100%; resize: vertical; border: 1px solid #496451; background: #101814; color: #effff2; padding: .65rem; font: inherit; font-size: .72rem; line-height: 1.45; }
  textarea:focus { outline: 2px solid #7cf59d; outline-offset: 1px; }
  .error { margin: .6rem 0 0; color: #ffb4ab; font-size: .7rem; line-height: 1.4; }
  .actions { display: flex; justify-content: flex-end; gap: .5rem; margin-top: .75rem; }
  .actions button, .scanner button { border: 1px solid #496451; background: #101814; color: #dfffe7; padding: .48rem .65rem; font: inherit; font-size: .68rem; font-weight: 650; cursor: pointer; }
  .actions .join { border-color: #7cf59d; background: #173a24; }
  button:disabled { cursor: wait; opacity: .65; }
  .scanner { margin-top: .85rem; border-top: 1px solid #293832; padding-top: .85rem; }
  video { display: block; width: 100%; max-height: 15rem; background: #000; object-fit: cover; }
  .scanner p { margin: .5rem 0; color: #a9b8ad; font-size: .68rem; }
  @media (max-width: 520px) { .redeem-trigger { padding-inline: .45rem; } .redeemer-dialog { max-height: calc(100dvh - 1.5rem); overflow-y: auto; } }
</style>
