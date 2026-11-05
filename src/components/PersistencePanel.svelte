<script lang="ts">
  import type { CoordinatorStore } from "../coordinator/coordinator.svelte";

  interface Props {
    coordinator: CoordinatorStore;
  }

  let { coordinator }: Props = $props();
  let enabling = $state(false);
  let passphrase = $state("");
  let confirmPassphrase = $state("");
  let confirmStopWithoutSaving = $state(false);
  let confirmRemoveCorrupt = $state(false);

  function snapshotLabel(): string {
    if (coordinator.snapshotPersistence === "durable") return "Saved on this device";
    if (coordinator.snapshotPersistence === "temporary") return "Temporary session — changes will not be saved.";
    if (coordinator.snapshotPersistence === "flushing") return "Stopping and saving…";
    return "Storage needs attention";
  }

  function attentionCopy(): string {
    if (coordinator.snapshotFailureKind === "quota") return "This browser does not have enough space to save coordinator changes. Free up browser storage, then try again.";
    if (coordinator.snapshotFailureKind === "corrupt") return "Saved coordinator data could not be read safely. You can remove that saved data and set up this coordinator again.";
    if (coordinator.snapshotPersistence === "flush-failed") return "CAHMLS could not save the latest coordinator changes. Try saving again, keep running, or stop without saving.";
    return "CAHMLS could not open durable coordinator storage. Retry, or continue temporarily if you understand that changes will be lost when this session ends.";
  }

  async function save(): Promise<void> {
    const saved = await coordinator.enablePersistence(passphrase, confirmPassphrase);
    if (saved) {
      enabling = false;
      passphrase = "";
      confirmPassphrase = "";
    }
  }
</script>

<section class="mx-auto max-w-3xl border-t border-[#16331f] py-8">
  <div class="mb-4 flex items-center justify-between gap-4">
    <h2 class="text-sm uppercase tracking-[0.22em] text-[#87ff9f]">Persistence</h2>
    <span class="border border-[#21482b] px-3 py-1 text-xs uppercase text-[#a7b0aa]" data-testid="persistence-state">
      {snapshotLabel()}
    </span>
  </div>

  {#if coordinator.persistenceEnabled}
    <p class="text-sm text-[#a7b0aa]">Persistence enabled — the coordinator key is encrypted in browser storage.</p>
    <button
      class="mt-4 border border-[#ff8f8f] px-4 py-2 text-sm uppercase text-[#ff8f8f] hover:bg-[#ff8f8f] hover:text-black"
      type="button"
      onclick={() => void coordinator.disablePersistence()}
    >
      Remove saved key
    </button>
  {:else if enabling}
    <p class="text-sm text-[#a7b0aa]">Choose a passphrase to encrypt this coordinator identity in browser storage.</p>
    <form
      class="mt-4 grid gap-3"
      onsubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <input
        class="border border-[#21482b] bg-black px-3 py-3 text-[#87ff9f] outline-none placeholder:text-[#415247] focus:border-[#87ff9f]"
        type="password"
        autocomplete="new-password"
        placeholder="passphrase"
        bind:value={passphrase}
      />
      <input
        class="border border-[#21482b] bg-black px-3 py-3 text-[#87ff9f] outline-none placeholder:text-[#415247] focus:border-[#87ff9f]"
        type="password"
        autocomplete="new-password"
        placeholder="confirm passphrase"
        bind:value={confirmPassphrase}
      />
      {#if coordinator.persistenceError}
        <p class="text-sm text-[#ff8f8f]" data-testid="persistence-error">{coordinator.persistenceError}</p>
      {/if}
      <div class="flex justify-end gap-3">
        <button
          class="border border-[#6d746f] px-4 py-2 text-sm uppercase text-[#a7b0aa]"
          type="button"
          onclick={() => {
            enabling = false;
            passphrase = "";
            confirmPassphrase = "";
          }}
        >
          Cancel
        </button>
        <button
          class="border border-[#87ff9f] px-4 py-2 text-sm uppercase text-[#87ff9f] hover:bg-[#87ff9f] hover:text-black"
          type="submit"
        >
          Save
        </button>
      </div>
    </form>
  {:else}
    <p class="text-sm text-[#a7b0aa]">Key persistence is off — this coordinator identity resets on reload.</p>
    <button
      class="mt-4 border border-[#87ff9f] px-4 py-2 text-sm uppercase text-[#87ff9f] hover:bg-[#87ff9f] hover:text-black"
      type="button"
      onclick={() => {
        enabling = true;
      }}
    >
      Enable persistence
    </button>
  {/if}

  {#if coordinator.snapshotPersistence === "attention" || coordinator.snapshotPersistence === "flush-failed"}
    <section class="mt-4 border border-[#e4e78d] p-4" aria-label="Storage needs attention">
      <h3 class="text-sm font-semibold text-[#e4e78d]">Storage needs attention</h3>
      <p class="mt-2 text-sm text-[#a7b0aa]">{attentionCopy()}</p>
      <div class="mt-4 flex flex-wrap gap-3">
        {#if coordinator.snapshotPersistence === "flush-failed"}
          <button class="border border-[#87ff9f] px-4 py-2 text-sm text-[#87ff9f]" type="button" onclick={() => void coordinator.retrySnapshotFlush()}>Try saving again</button>
          <button class="border border-[#6d746f] px-4 py-2 text-sm text-[#a7b0aa]" type="button" onclick={() => coordinator.clearPersistenceError()}>Keep running</button>
          <button class="border border-[#ff8f8f] px-4 py-2 text-sm text-[#ff8f8f]" type="button" onclick={() => confirmStopWithoutSaving = true}>Stop without saving</button>
        {:else}
          <button class="border border-[#87ff9f] px-4 py-2 text-sm text-[#87ff9f]" type="button" onclick={() => void coordinator.retryStorage()}>Retry storage</button>
          <button class="border border-[#6d746f] px-4 py-2 text-sm text-[#a7b0aa]" type="button" onclick={() => void coordinator.continueTemporarily()}>Continue temporarily</button>
          {#if coordinator.snapshotFailureKind === "corrupt"}
            <button class="border border-[#ff8f8f] px-4 py-2 text-sm text-[#ff8f8f]" type="button" onclick={() => confirmRemoveCorrupt = true}>Remove corrupt saved data</button>
          {/if}
        {/if}
      </div>
    </section>
  {/if}
</section>

{#if confirmStopWithoutSaving}
  <dialog open class="border border-[#ff8f8f] bg-[#101614] p-5 text-[#dfffe7]" aria-labelledby="stop-without-saving-title">
    <h2 id="stop-without-saving-title">Stop without saving?</h2>
    <p class="mt-2 text-sm">The latest coordinator changes may be lost on reload.</p>
    <div class="mt-4 flex gap-3"><button type="button" onclick={() => confirmStopWithoutSaving = false}>Keep running</button><button type="button" onclick={() => { confirmStopWithoutSaving = false; void coordinator.stopWithoutSaving(); }}>Stop without saving</button></div>
  </dialog>
{/if}

{#if confirmRemoveCorrupt}
  <dialog open class="border border-[#ff8f8f] bg-[#101614] p-5 text-[#dfffe7]" aria-labelledby="remove-corrupt-title">
    <h2 id="remove-corrupt-title">Remove corrupt saved data?</h2>
    <p class="mt-2 text-sm">This removes unreadable coordinator data from this browser. It cannot be restored.</p>
    <div class="mt-4 flex gap-3"><button type="button" onclick={() => confirmRemoveCorrupt = false}>Keep saved data</button><button type="button" onclick={() => { confirmRemoveCorrupt = false; void coordinator.removeCorruptSnapshot(); }}>Remove saved data</button></div>
  </dialog>
{/if}
