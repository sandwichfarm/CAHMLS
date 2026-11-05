<script lang="ts">
  import { onMount } from "svelte";
  import type { Snippet } from "svelte";

  /**
   * Presentational shell for the host and guest room-browser content. Routes
   * retain their own room records and business callbacks and supply only the
   * already-authorized body content through the snippet.
   */
  interface Props {
    open: boolean;
    onClose: () => void;
    children?: Snippet;
  }

  let { open, onClose, children }: Props = $props();
  let dialog = $state<HTMLDialogElement>();

  onMount(() => {
    dialog?.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  });

  function closeFromBackdrop(event: MouseEvent): void {
    if (event.target === dialog) onClose();
  }
</script>

{#if open}
  <dialog bind:this={dialog} id="room-switcher" class="room-browser room-switcher" aria-label="Rooms" data-testid="room-switcher" oncancel={(event) => { event.preventDefault(); onClose(); }} onclick={closeFromBackdrop}>
    <header>
      <h2>Rooms</h2>
      <button type="button" aria-label="Close room browser" onclick={onClose}>Close room browser</button>
    </header>
    <div class="room-browser-body">
      {@render children?.()}
    </div>
  </dialog>
{/if}

<style>
  .room-browser { position: fixed; z-index: 80; top: 3.7rem; left: .75rem; display: grid; width: min(27rem, calc(100vw - 1.5rem)); max-height: min(38rem, calc(var(--app-visual-height, 100dvh) - 4.45rem)); min-height: 0; margin: 0; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; border: 1px solid #496451; background: #09100c; box-shadow: 0 24px 64px rgb(0 0 0 / .62); color: #dfffe7; }
  header { display: flex; min-height: 44px; align-items: center; justify-content: space-between; border-bottom: 1px solid #293832; padding: max(8px, env(safe-area-inset-top)) 8px 8px; }
  h2 { font-size: 18px; font-weight: 600; }
  button { min-width: 44px; min-height: 44px; border: 1px solid #496451; padding: 8px; color: #bde7c7; font-size: 12px; }
  .room-browser-body { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 8px max(8px, env(safe-area-inset-right)) max(8px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left)); }
  @media (max-width: 900px) {
    .room-browser { top: 0; bottom: auto; left: 0; width: min(22rem, calc(100vw - 44px)); height: var(--app-visual-height, 100dvh); max-height: var(--app-visual-height, 100dvh); padding-top: max(8px, env(safe-area-inset-top)); }
  }
</style>
