<script lang="ts">
  import { tick } from "svelte";
  import type { CoordinatorIdentity } from "@cahmls/sdk/crypto";
  import type { CoordinatorStore } from "../coordinator/coordinator.svelte";
  import { normalizeCoordinatorName, type ConfigStore } from "../config/config.svelte";
  import NpubDisplay from "./NpubDisplay.svelte";

  interface Props {
    coordinator: CoordinatorStore;
    config: ConfigStore;
    identity: CoordinatorIdentity;
    onClose: () => void;
  }

  let { coordinator, config, identity, onClose }: Props = $props();
  let relayInput = $state("");
  let enablingPersistence = $state(false);
  let passphrase = $state("");
  let confirmPassphrase = $state("");
  let exportPassphrase = $state("");
  let exportingBackup = $state(false);
  let exportConfirmation = $state("");
  let exportDownloadError = $state("");
  let exportTrigger = $state<HTMLButtonElement>();
  let exportDialog = $state<HTMLDialogElement>();
  let exportPassphraseInput = $state<HTMLInputElement>();
  let badgeEmojiPickerOpen = $state(false);
  let coordinatorNameDraft = $state("");
  let coordinatorNameTouched = $state(false);
  let coordinatorNameAction = $state<HTMLButtonElement>();

  const badgeEmojis = ["🛡️", "👑", "⚡", "🌿", "🛰️", "🫡", "🔐", "🧭", "🦉", "🦊", "🐙", "✨", "💚", "🏠", "🎛️", "☕"];

  const transitioning = $derived(coordinator.status === "starting" || coordinator.status === "stopping");
  const editable = $derived(config.editMode && !transitioning);
  const normalizedCoordinatorName = $derived(normalizeCoordinatorName(coordinatorNameDraft));
  const coordinatorNameChanged = $derived(normalizedCoordinatorName !== null && normalizedCoordinatorName !== config.coordinatorName);
  const coordinatorNameInvalid = $derived(coordinatorNameTouched && normalizedCoordinatorName === null);
  const publicationInFlight = $derived(coordinator.profilePublicationState === "publishing");

  $effect(() => {
    if (!coordinatorNameTouched && !publicationInFlight) coordinatorNameDraft = config.coordinatorName;
  });

  function addRelay(): void {
    if (config.addRelay(relayInput)) relayInput = "";
  }

  function updateMaxUsers(event: Event): void {
    config.setMaxUsers((event.currentTarget as HTMLInputElement).valueAsNumber);
  }

  async function saveCoordinatorName(): Promise<void> {
    if (!editable || publicationInFlight || !coordinatorNameChanged || normalizedCoordinatorName === null) {
      coordinatorNameTouched = true;
      return;
    }

    await coordinator.saveCoordinatorNameAndPublish(normalizedCoordinatorName);
    coordinatorNameTouched = false;
    await tick();
    coordinatorNameAction?.focus();
  }

  async function retryCoordinatorNamePublication(): Promise<void> {
    if (!editable || publicationInFlight) return;
    await coordinator.retryCoordinatorProfilePublication();
    await tick();
    coordinatorNameAction?.focus();
  }

  async function savePersistence(): Promise<void> {
    const saved = await coordinator.enablePersistence(passphrase, confirmPassphrase);
    if (!saved) return;
    enablingPersistence = false;
    passphrase = "";
    confirmPassphrase = "";
  }

  async function openExportDialog(): Promise<void> {
    if (!exportDialog || exportDialog.open) return;
    coordinator.clearPersistenceError();
    exportPassphrase = "";
    exportConfirmation = "";
    exportDownloadError = "";
    exportDialog.showModal();
    await tick();
    exportPassphraseInput?.focus();
  }

  function closeExportDialog(): void {
    if (exportingBackup) return;
    exportDialog?.close();
  }

  async function handleExportDialogClose(): Promise<void> {
    exportPassphrase = "";
    exportingBackup = false;
    exportDownloadError = "";
    coordinator.clearPersistenceError();
    await tick();
    exportTrigger?.focus();
  }

  function handleExportDialogCancel(event: Event): void {
    if (exportingBackup) event.preventDefault();
  }

  async function downloadBackup(): Promise<void> {
    if (exportingBackup) return;
    exportingBackup = true;

    const backup = await coordinator.exportCoordinatorKeyBackup(exportPassphrase);
    if (!backup) {
      exportingBackup = false;
      return;
    }
    if (!exportDialog?.open) {
      exportingBackup = false;
      return;
    }

    let downloadUrl: string | undefined;
    let link: HTMLAnchorElement | undefined;
    try {
      const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: "application/json" });
      downloadUrl = URL.createObjectURL(blob);
      link = document.createElement("a");
      link.href = downloadUrl;
      link.download = backupFilename(backup.identity.npub, backup.exportedAt);
      link.hidden = true;
      document.body.append(link);
      link.click();

      exportConfirmation = "Encrypted backup downloaded";
      exportDialog.close();
    } catch {
      exportDownloadError = "This browser could not create the backup download";
    } finally {
      link?.remove();
      if (downloadUrl) window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);
      if (exportDialog?.open) exportingBackup = false;
    }
  }

  function backupFilename(npub: string, exportedAt: string): string {
    const timestamp = exportedAt.replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
    return `cordn-${npub.slice(0, 16)}-${timestamp}.backup.json`;
  }

</script>

<div class="settings-layer" data-testid="coordinator-settings">
  <button class="settings-backdrop" type="button" aria-label="Close coordinator settings" onclick={onClose}></button>
  <div class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <div class="settings-surface">
    <header class="settings-header">
      <div>
        <p>Coordinator</p>
        <h2 id="settings-title">Settings</h2>
      </div>
      <div class="settings-header-actions">
        <span class:online={coordinator.status === "running"} class:busy={transitioning} class="settings-status">
          <span aria-hidden="true"></span>{coordinator.status}
        </span>
        <button type="button" aria-label="Close coordinator settings" onclick={onClose}>×</button>
      </div>
    </header>

    {#if coordinator.restartRequired}
      <div class="restart-banner" data-testid="restart-required">
        <span><strong>Restart required</strong><small>This coordinator name is published now. Restart to apply it to the coordinator’s MCP label.</small></span>
        <button type="button" disabled={transitioning} onclick={() => void coordinator.restart()}>Restart to apply</button>
      </div>
    {:else if coordinator.status === "running" && editable}
      <p class="edit-guidance">Runtime edits are saved as you work. If a change needs a restart, the action will appear here.</p>
    {/if}

    <div class="settings-toolbar">
      <p>{editable ? "Editing next-run configuration" : "Review identity, relays, and runtime behavior"}</p>
      {#if editable}
        <button type="button" onclick={() => config.exitEdit()}>Done editing</button>
      {:else}
        <button type="button" disabled={transitioning} onclick={() => config.enterEdit()}>Edit settings</button>
      {/if}
    </div>

    <div class="settings-content">
      <section class="settings-section identity-section">
        <div class="section-heading">
          <span class="section-number">01</span>
          <div><h3>Identity</h3><p>Name this coordinator and manage its durable key.</p></div>
        </div>
        <label class="field-label">
          Coordinator name
          <input
            class="settings-input"
            bind:value={coordinatorNameDraft}
            maxlength="48"
            disabled={!editable || publicationInFlight}
            placeholder="My coordinator"
            aria-invalid={coordinatorNameInvalid}
            aria-describedby="coordinator-name-helper coordinator-name-error"
            data-testid="coordinator-name-input"
            oninput={() => coordinatorNameTouched = true}
            onblur={() => coordinatorNameTouched = true}
          />
        </label>
        <p id="coordinator-name-helper" class="coordinator-name-helper">This public coordinator name is separate from your operator profile.</p>
        {#if coordinatorNameInvalid}<p id="coordinator-name-error" class="field-error" data-testid="coordinator-name-error" role="alert">Enter a coordinator name to continue.</p>{/if}
        <div class="coordinator-name-actions" data-testid="coordinator-name-publication" data-publication-state={coordinator.profilePublicationState}>
          <button
            bind:this={coordinatorNameAction}
            class="primary-small"
            type="button"
            disabled={!editable || publicationInFlight || !coordinatorNameChanged}
            onclick={() => void saveCoordinatorName()}
          >{publicationInFlight ? "Publishing…" : "Save coordinator name"}</button>
          {#if coordinator.profilePublicationState === "published"}
            <p role="status">Coordinator name published.</p>
          {:else if coordinator.profilePublicationState === "failed"}
            <p class="field-error" role="alert">Couldn’t publish the coordinator profile. The coordinator name is saved locally and the coordinator is still running. Try again.</p>
            <button
              bind:this={coordinatorNameAction}
              type="button"
              disabled={!editable || publicationInFlight}
              onclick={() => void retryCoordinatorNamePublication()}
            >{publicationInFlight ? "Publishing…" : "Retry publishing"}</button>
          {:else if publicationInFlight}
            <p role="status">Publishing…</p>
          {/if}
        </div>
        <div class="host-message-identity">
          <div class="field-heading">
            <span class="field-label">Message identity</span>
            <span class="host-marker">host administration</span>
          </div>
          <p>Set the badge shown on messages sent from this coordinator. Your personal profile remains separate.</p>
          <div class="badge-editor">
            <button
              class="badge-emoji-trigger"
              type="button"
              aria-label="Choose badge emoji"
              aria-expanded={badgeEmojiPickerOpen}
              disabled={!editable}
              onclick={() => badgeEmojiPickerOpen = !badgeEmojiPickerOpen}
            >{config.hostBadgeEmoji || "＋"}</button>
            <label class="field-label">
              Badge text
              <input
                class="settings-input"
                value={config.hostBadgeLabel}
                maxlength="20"
                disabled={!editable}
                placeholder="host"
                oninput={(event) => config.setHostBadgeLabel(event.currentTarget.value)}
              />
            </label>
          </div>
          {#if badgeEmojiPickerOpen}
            <div class="badge-emoji-picker" role="group" aria-label="Badge emoji">
              {#each badgeEmojis as emoji (emoji)}
                <button
                  class:selected={emoji === config.hostBadgeEmoji}
                  type="button"
                  aria-label={`Use ${emoji} for badge`}
                  onclick={() => {
                    config.setHostBadgeEmoji(emoji);
                    badgeEmojiPickerOpen = false;
                  }}
                >{emoji}</button>
              {/each}
            </div>
          {/if}
          <div class="host-message-preview" data-testid="host-message-identity-preview" aria-label="Outgoing host message identity preview">
            <span class="host-preview-avatar" aria-hidden="true">{config.hostBadgeEmoji || "🛡️"}</span>
            <span><strong>{config.hostBadgeLabel.trim() || "host"}</strong><small>host · outgoing message</small></span>
          </div>
        </div>
        <NpubDisplay {identity} />
        <div class="persistence-row">
          <div>
            <strong>Encrypted browser key</strong>
            <small>{coordinator.persistenceEnabled ? "Saved on this device" : "Ephemeral until this tab closes"}</small>
            <span class="sr-only" data-testid="persistence-state">{coordinator.persistenceEnabled ? "encrypted" : "off"}</span>
          </div>
          {#if coordinator.persistenceEnabled}
            <div class="persistence-actions">
              <button
                bind:this={exportTrigger}
                class="export-trigger"
                type="button"
                onclick={() => void openExportDialog()}
              >Export backup</button>
              <button class="remove-key" type="button" disabled={!editable} onclick={() => void coordinator.disablePersistence()}>Remove saved key</button>
            </div>
          {:else if enablingPersistence}
            <form onsubmit={(event) => { event.preventDefault(); void savePersistence(); }}>
              <input class="settings-input" type="password" autocomplete="new-password" placeholder="passphrase" bind:value={passphrase} />
              <input class="settings-input" type="password" autocomplete="new-password" placeholder="confirm passphrase" bind:value={confirmPassphrase} />
              {#if coordinator.persistenceError}<p class="field-error">{coordinator.persistenceError}</p>{/if}
              <div class="inline-actions">
                <button type="button" onclick={() => { enablingPersistence = false; passphrase = ""; confirmPassphrase = ""; coordinator.clearPersistenceError(); }}>Cancel</button>
                <button class="primary-small" type="submit">Save key</button>
              </div>
            </form>
          {:else}
            <button type="button" disabled={!editable} onclick={() => { coordinator.clearPersistenceError(); enablingPersistence = true; }}>Enable persistence</button>
          {/if}
        </div>
        {#if exportConfirmation}
          <p class="export-confirmation" role="status">{exportConfirmation}</p>
        {/if}
      </section>

      <section class="settings-section">
        <div class="section-heading">
          <span class="section-number">02</span>
          <div><h3>Relay network</h3><p>Where the coordinator listens and publishes.</p></div>
        </div>
        <div class="relay-list">
          {#each config.relays as relay (relay.id)}
            <div class="relay-row">
              <input type="checkbox" aria-label={`Toggle ${relay.url}`} checked={relay.enabled} disabled={!editable} onchange={() => config.toggleRelay(relay.id)} />
              <span class:disabled={!relay.enabled}>{relay.url}</span>
              {#if coordinator.relayStatuses[relay.url]}<small class={coordinator.relayStatuses[relay.url]}>{coordinator.relayStatuses[relay.url]}</small>{/if}
              <button type="button" aria-label={`Remove ${relay.url}`} disabled={!editable} onclick={() => config.removeRelay(relay.id)}>×</button>
            </div>
          {/each}
        </div>
        <form class="add-relay" onsubmit={(event) => { event.preventDefault(); addRelay(); }}>
          <input class="settings-input" bind:value={relayInput} disabled={!editable} placeholder="wss://relay.example" />
          <button type="submit" disabled={!editable}>Add</button>
        </form>
        {#if config.relayError}<p class="field-error" data-testid="relay-error">{config.relayError}</p>{/if}
      </section>

      <section class="settings-section">
        <div class="section-heading">
          <span class="section-number">03</span>
          <div><h3>Runtime</h3><p>Behavior and capacity for the next run.</p></div>
        </div>
        <label class="toggle-row">
          <span><strong>Announcement</strong><small>Publish coordinator availability.</small></span>
          <input type="checkbox" checked={config.announce} disabled={!editable} aria-label="Toggle announcement" onchange={(event) => config.setAnnouncement(event.currentTarget.checked)} />
        </label>
        <label class="toggle-row">
          <span><strong>Autostart</strong><small>Start when this workspace opens.</small></span>
          <input type="checkbox" checked={config.autostart} disabled={!editable} aria-label="Toggle autostart" onchange={(event) => config.setAutostart(event.currentTarget.checked)} />
        </label>
        <label class="field-label">
          Key-package quota
          <input class="settings-input" type="number" min="1" max="256" step="1" value={config.maxUsers} disabled={!editable} aria-label="Key-package quota" data-testid="max-users-input" onchange={updateMaxUsers} />
        </label>
        <span class="sr-only" data-testid="max-users-state">{config.maxUsers} key packages / identity</span>
        {#if config.limitError}<p class="field-error">{config.limitError}</p>{/if}
      </section>
    </div>
    </div>

    <dialog
      bind:this={exportDialog}
      class="export-dialog"
      aria-busy={exportingBackup}
      aria-labelledby="export-title"
      aria-describedby="export-description"
      data-testid="coordinator-export-dialog"
      oncancel={handleExportDialogCancel}
      onclose={() => void handleExportDialogClose()}
    >
      <form onsubmit={(event) => { event.preventDefault(); void downloadBackup(); }}>
        <header>
          <div>
            <p>Encrypted backup</p>
            <h3 id="export-title">Export coordinator</h3>
          </div>
          <button type="button" aria-label="Close export coordinator dialog" disabled={exportingBackup} onclick={closeExportDialog}>×</button>
        </header>
        <div class="export-content">
          <p id="export-description">
            Enter this coordinator's passphrase. The downloaded identity backup stays encrypted with the same passphrase; rooms and messages are not included.
          </p>
          <label>
            Current passphrase
            <input
              bind:this={exportPassphraseInput}
              class="settings-input"
              type="password"
              autocomplete="current-password"
              disabled={exportingBackup}
              bind:value={exportPassphrase}
              oninput={() => { coordinator.clearPersistenceError(); exportDownloadError = ""; }}
            />
          </label>
          {#if coordinator.persistenceError || exportDownloadError}
            <p class="field-error" data-testid="export-error">{coordinator.persistenceError || exportDownloadError}</p>
          {/if}
          <div class="export-note">
            <span aria-hidden="true">⌁</span>
            <span><strong>No plaintext key is written.</strong><small>Keep the backup and its passphrase somewhere separate.</small></span>
          </div>
        </div>
        <footer>
          <button type="button" disabled={exportingBackup} onclick={closeExportDialog}>Cancel</button>
          <button class="export-primary" type="submit" disabled={exportingBackup}>
            {exportingBackup ? "Verifying…" : "Download backup"}
          </button>
        </footer>
      </form>
    </dialog>
  </div>
</div>

<style>
  .settings-layer { position: fixed; z-index: 100; inset: 0; display: grid; height: 100dvh; max-height: 100dvh; justify-items: end; overflow: hidden; overscroll-behavior: contain; }
  .settings-backdrop { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: rgb(2 7 4 / .5); cursor: default; touch-action: none; backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); }
  .settings-dialog { position: relative; z-index: 1; display: flex; width: min(42rem, 100%); height: 100dvh; max-height: 100dvh; flex-direction: column; overflow: hidden; border-left: 1px solid #496451; background: #09100c; box-shadow: -24px 0 72px rgb(0 0 0 / .58); }
  .settings-surface { display: flex; min-height: 0; flex: 1; flex-direction: column; }
  .settings-header { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 1rem; border-bottom: 1px solid #293832; padding: 1rem 1.1rem; }
  .settings-header p { color: #7cf59d; font-size: .55rem; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
  .settings-header h2 { margin-top: .2rem; color: white; font-size: 1.2rem; font-weight: 650; }
  .settings-header-actions { display: flex; align-items: center; gap: .65rem; }
  .settings-header-actions > button { display: grid; width: 2rem; height: 2rem; place-items: center; border: 1px solid #34483a; color: #82958a; font-size: 1.1rem; }
  .settings-header-actions > button:hover { border-color: #7cf59d; color: white; }
  .settings-status { display: flex; align-items: center; gap: .4rem; color: #7d8e82; font-size: .55rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
  .settings-status > span { width: .4rem; height: .4rem; border-radius: 999px; background: #59655d; }
  .settings-status.online { color: #9bf6b3; }
  .settings-status.online > span { background: #7cf59d; box-shadow: 0 0 8px rgb(124 245 157 / .38); }
  .settings-status.busy > span { background: #e4e78d; animation: pulse 1s ease-in-out infinite; }
  .restart-banner { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: .8rem; border-bottom: 1px solid #675d2f; background: #19180d; padding: .7rem 1rem; }
  .restart-banner strong, .restart-banner small { display: block; }
  .restart-banner strong { color: #e7e79e; font-size: .68rem; }
  .restart-banner small { margin-top: .2rem; color: #989874; font-size: .58rem; }
  .restart-banner button { flex: 0 0 auto; border: 1px solid #b6b65e; padding: .5rem .65rem; color: #eded9b; font-size: .62rem; }
  .edit-guidance { flex: 0 0 auto; border-bottom: 1px solid #293832; background: #101713; padding: .65rem 1rem; color: #91a59a; font-size: .62rem; }
  .settings-toolbar { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 1rem; border-bottom: 1px solid #293832; padding: .7rem 1rem; }
  .settings-toolbar p { color: #718277; font-size: .62rem; }
  .settings-toolbar button, .settings-section button { border: 1px solid #405748; padding: .5rem .65rem; color: #bddbc4; font-size: .62rem; }
  .settings-toolbar button:hover:not(:disabled), .settings-section button:hover:not(:disabled) { border-color: #7cf59d; color: #effff2; }
  button:disabled { opacity: .35; }
  .settings-content { min-height: 0; flex: 1; overflow-y: auto; overscroll-behavior: contain; }
  .settings-section { display: grid; gap: .85rem; border-bottom: 1px solid #293832; padding: 1.1rem; }
  .section-heading { display: grid; grid-template-columns: auto 1fr; gap: .7rem; }
  .section-number { color: #52655a; font-size: .55rem; }
  .section-heading h3 { color: #e8f5eb; font-size: .76rem; font-weight: 650; }
  .section-heading p { margin-top: .2rem; color: #718277; font-size: .62rem; }
  .field-label { color: #83958a; font-size: .56rem; letter-spacing: .1em; text-transform: uppercase; }
  .settings-input { width: 100%; border: 1px solid #34433b; background: #070b08; padding: .68rem .75rem; color: #effff2; font-size: .7rem; outline: none; }
  .field-label .settings-input { margin-top: .45rem; text-transform: none; }
  .settings-input:focus { border-color: #7cf59d; }
  .settings-input:disabled { color: #82958a; opacity: .72; }
  .coordinator-name-helper { color: #91a59a; font-size: .58rem; line-height: 1.45; }
  .coordinator-name-actions { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; gap: .55rem; }
  .coordinator-name-actions button { min-height: 44px; }
  .coordinator-name-actions p { flex: 1 1 12rem; color: #9bf6b3; font-size: .62rem; line-height: 1.45; }
  .coordinator-name-actions .field-error { color: #ffaaa3; }
  .host-message-identity { display: grid; gap: .65rem; border: 1px solid #293832; background: #0b0e0d; padding: .75rem; }
  .field-heading { display: flex; align-items: center; justify-content: space-between; gap: .6rem; }
  .host-marker { color: #7cf59d; font-size: .5rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
  .host-message-identity > p { color: #718277; font-size: .58rem; line-height: 1.45; }
  .badge-editor { display: grid; grid-template-columns: 2.6rem minmax(0, 1fr); align-items: end; gap: .55rem; }
  .badge-emoji-trigger { display: grid; width: 2.6rem; height: 2.6rem; place-items: center; border: 1px solid #34433b; background: #070b08; font-size: 1rem; }
  .badge-emoji-trigger:hover:not(:disabled), .badge-emoji-trigger[aria-expanded="true"] { border-color: #7cf59d; background: #111a14; }
  .badge-emoji-picker { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: .25rem; border: 1px solid #293832; background: #070b08; padding: .4rem; }
  .badge-emoji-picker button { display: grid; aspect-ratio: 1; place-items: center; border: 1px solid transparent; font-size: .9rem; }
  .badge-emoji-picker button:hover, .badge-emoji-picker button.selected { border-color: #7cf59d; background: #17241b; }
  .host-message-preview { display: flex; align-items: center; gap: .5rem; border-top: 1px solid #202d25; padding-top: .65rem; }
  .host-preview-avatar { display: grid; width: 1.9rem; height: 1.9rem; place-items: center; background: #17241b; font-size: .85rem; }
  .host-message-preview strong, .host-message-preview small { display: block; }
  .host-message-preview strong { color: #dfffe7; font-size: .64rem; font-weight: 650; }
  .host-message-preview small { margin-top: .16rem; color: #718277; font-size: .52rem; }
  .persistence-row, .toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border: 1px solid #293832; background: #0b0e0d; padding: .75rem; }
  .persistence-row strong, .persistence-row small, .toggle-row strong, .toggle-row small { display: block; }
  .persistence-row strong, .toggle-row strong { color: #cfe2d4; font-size: .68rem; font-weight: 500; }
  .persistence-row small, .toggle-row small { margin-top: .22rem; color: #718277; font-size: .57rem; }
  .persistence-row form { display: grid; min-width: min(17rem, 55%); gap: .4rem; }
  .persistence-actions { display: flex; flex: 0 0 auto; flex-wrap: wrap; justify-content: flex-end; gap: .45rem; }
  .persistence-actions .export-trigger { border-color: #507b5d; color: #b7efc4; }
  .persistence-actions .remove-key { border-color: #513b3b; color: #a77b7b; }
  .export-confirmation { color: #9bf6b3; font-size: .6rem; text-align: right; }
  input[type="checkbox"] { width: 1rem; height: 1rem; flex: 0 0 auto; accent-color: #7cf59d; }
  .relay-list { display: grid; gap: .25rem; }
  .relay-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: .6rem; border-bottom: 1px solid #202d25; padding: .55rem .25rem; }
  .relay-row > span { overflow: hidden; color: #c6d7cb; font-size: .68rem; text-overflow: ellipsis; white-space: nowrap; }
  .relay-row > span.disabled { color: #59675e; text-decoration: line-through; }
  .relay-row small { color: #82958a; font-size: .5rem; text-transform: uppercase; }
  .relay-row small.connected { color: #7cf59d; }
  .relay-row small.error { color: #ffaaa3; }
  .relay-row button { width: 1.7rem; height: 1.7rem; padding: 0; border-color: transparent; color: #9a6f6f; }
  .add-relay { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .45rem; }
  .field-error { color: #ffaaa3; font-size: .62rem; }
  .inline-actions { display: flex; justify-content: flex-end; gap: .4rem; }
  .primary-small { border-color: #7cf59d !important; background: #7cf59d; color: #071009 !important; }
  .export-dialog { position: fixed; inset: 0; width: min(28rem, calc(100% - 1rem)); max-width: none; max-height: calc(100dvh - 1rem); margin: auto; overflow: hidden; border: 1px solid #557060; background: #09100c; padding: 0; color: #cfe2d4; box-shadow: 0 24px 80px rgb(0 0 0 / .72); }
  .export-dialog::backdrop { background: rgb(1 5 2 / .7); backdrop-filter: blur(1.5px); -webkit-backdrop-filter: blur(1.5px); }
  .export-dialog > form { display: flex; max-height: calc(100dvh - 1rem - 2px); flex-direction: column; overflow: hidden; }
  .export-dialog > form > header { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 1rem; border-bottom: 1px solid #293832; padding: .9rem 1rem; }
  .export-dialog > form > header p { color: #7cf59d; font-size: .52rem; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
  .export-dialog > form > header h3 { margin-top: .2rem; color: #effff2; font-size: 1rem; }
  .export-dialog > form > header button { display: grid; width: 2rem; height: 2rem; place-items: center; border: 1px solid #34483a; color: #82958a; font-size: 1rem; }
  .export-content { display: grid; min-height: 0; gap: .85rem; overflow-y: auto; overscroll-behavior: contain; padding: 1rem; }
  .export-content > p { color: #8da096; font-size: .65rem; line-height: 1.55; }
  .export-content label { color: #83958a; font-size: .56rem; letter-spacing: .1em; text-transform: uppercase; }
  .export-content label .settings-input { margin-top: .45rem; text-transform: none; }
  .export-note { display: grid; grid-template-columns: auto 1fr; gap: .7rem; border-left: 2px solid #496451; background: #0d1510; padding: .7rem .8rem; }
  .export-note > span:first-child { color: #7cf59d; font-size: 1rem; }
  .export-note strong, .export-note small { display: block; }
  .export-note strong { color: #cfe2d4; font-size: .62rem; font-weight: 550; }
  .export-note small { margin-top: .18rem; color: #718277; font-size: .56rem; line-height: 1.45; }
  .export-dialog > form > footer { display: flex; flex: 0 0 auto; flex-wrap: wrap; justify-content: flex-end; gap: .5rem; border-top: 1px solid #293832; padding: .8rem 1rem; }
  .export-dialog > form > footer button { border: 1px solid #405748; padding: .55rem .75rem; color: #bddbc4; font-size: .62rem; }
  .export-dialog > form > footer button:hover:not(:disabled), .export-dialog > form > header button:hover:not(:disabled) { border-color: #7cf59d; color: #effff2; }
  .export-dialog > form > footer .export-primary { border-color: #7cf59d; background: #7cf59d; color: #071009; font-weight: 700; }
  .export-dialog > form > footer .export-primary:hover:not(:disabled) { background: #9bf6b3; color: #071009; }
  button:focus-visible, input:focus-visible { outline: 2px solid #7cf59d; outline-offset: 2px; }

  @media (max-width: 520px) {
    .settings-dialog { width: 100%; border-left: 0; }
    .persistence-row { align-items: stretch; flex-direction: column; }
    .persistence-row form { min-width: 0; }
    .persistence-actions { justify-content: stretch; }
    .persistence-actions button { flex: 1; }
    .export-dialog { width: calc(100% - 1rem); }
  }

  @media (max-height: 420px) {
    .settings-header { padding-block: .65rem; }
    .settings-toolbar { padding-block: .5rem; }
    .restart-banner { padding-block: .5rem; }
    .export-dialog > form > header { padding-block: .6rem; }
    .export-content { gap: .65rem; padding-block: .7rem; }
    .export-dialog > form > footer { padding-block: .6rem; }
  }

  @keyframes pulse { 50% { opacity: .35; } }
</style>
