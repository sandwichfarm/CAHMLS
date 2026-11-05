<script lang="ts">
  import { tick } from "svelte";
  import { validateShareableRelayUrl } from "@cahmls/sdk/runtime";
  import { userProfileStore } from "../identity/user-profile.svelte";
  import type { CoordinatorSetupSubmission } from "./coordinator-setup";
  import IdentityRotationDialog from "./IdentityRotationDialog.svelte";
  import OperatorIdentityChoices from "./OperatorIdentityChoices.svelte";

  type Stage = "identity" | "name" | "path" | "password" | "persistence" | "relays" | "announce" | "autostart";

  interface Props {
    setupState: "checking" | "identity" | "required-name" | "saving";
    initialRelays: string[];
    onComplete: (submission: CoordinatorSetupSubmission) => Promise<string | null>;
  }

  let { setupState: requestedState, initialRelays, onComplete }: Props = $props();
  let stage = $state<Stage>("identity");
  let name = $state("My coordinator");
  let nameTouched = $state(false);
  let profileNameMissing = $state(false);
  let profileSuggestionAnnouncement = $state("");
  let nameInvalid = $state(false);
  let saving = $state(false);
  let nameInput = $state<HTMLInputElement>();
  let passphraseInput = $state<HTMLInputElement>();
  let persistence = $state<"persistent" | "ephemeral">("persistent");
  let passphrase = $state("");
  let confirmPassphrase = $state("");
  let relays = $state<string[]>([]);
  let relaysInitialized = $state(false);
  let relayError = $state<string | null>(null);
  let announce = $state(false);
  let autostart = $state(true);
  let completionError = $state<string | null>(null);

  const normalizedName = $derived(name.trim());
  const canSaveName = $derived(normalizedName.length > 0 && !saving);
  const visibleState = $derived(requestedState === "checking" ? "checking" : saving ? "saving" : stage === "name" ? "required-name" : stage === "identity" ? "identity" : "preferences");

  $effect(() => {
    if (relaysInitialized) return;
    relays = [...initialRelays];
    relaysInitialized = true;
  });

  async function focusName(): Promise<void> {
    stage = "name";
    await tick();
    nameInput?.focus();
  }

  async function continueAnonymously(): Promise<void> {
    userProfileStore.setAnonymous();
    await focusName();
  }

  async function continueWithSigner(): Promise<void> {
    const suggestedName = profileSuggestion();
    profileNameMissing = suggestedName === "My coordinator";
    if (!nameTouched && (name === "My coordinator" || !name.trim())) name = Array.from(suggestedName).slice(0, 48).join("");
    await focusName();
  }

  function profileSuggestion(): string {
    const profile = userProfileStore.profile;
    if (typeof profile?.display_name === "string" && profile.display_name.trim()) return profile.display_name.trim();
    if (typeof profile?.name === "string" && profile.name.trim()) return profile.name.trim();
    return "My coordinator";
  }

  $effect(() => {
    if (stage !== "name" || userProfileStore.method === "anonymous" || nameTouched) return;
    const suggestion = profileSuggestion();
    if (suggestion === "My coordinator" || (name !== "My coordinator" && name.trim())) return;
    name = Array.from(suggestion).slice(0, 48).join("");
    profileNameMissing = false;
    profileSuggestionAnnouncement = "Coordinator name suggestion updated from your Nostr profile.";
  });

  function validateName(): boolean {
    nameInvalid = normalizedName.length === 0;
    return !nameInvalid;
  }

  function continueFromName(): void {
    if (!validateName()) return;
    stage = "path";
  }

  async function chooseRecommended(): Promise<void> {
    persistence = "persistent";
    announce = false;
    autostart = true;
    relays = [...initialRelays];
    stage = "password";
    await tick();
    passphraseInput?.focus();
  }

  function validateRelays(): boolean {
    if (relays.length === 0) {
      relayError = "Add at least one relay to continue.";
      return false;
    }
    const normalized = relays.map((relay) => relay.trim());
    const invalid = normalized.find((relay) => validateShareableRelayUrl(relay));
    if (invalid !== undefined) {
      relayError = validateShareableRelayUrl(invalid);
      return false;
    }
    if (normalized.some((relay, index) => normalized.indexOf(relay) !== index)) {
      relayError = "Relay URLs must be unique.";
      return false;
    }
    relayError = null;
    return true;
  }

  function updateRelay(index: number, value: string): void {
    relays[index] = value;
    relays = [...relays];
    if (relayError) validateRelays();
  }

  function removeRelay(index: number): void {
    relays = relays.filter((_, relayIndex) => relayIndex !== index);
    validateRelays();
  }

  function addRelay(): void {
    relays = [...relays, "wss://"];
    relayError = null;
  }

  function continueRelays(): void {
    if (validateRelays()) stage = "announce";
  }

  function persistenceError(): string | null {
    if (persistence === "ephemeral") return null;
    if (!passphrase) return "Passphrase is required";
    if (passphrase !== confirmPassphrase) return "Passphrases do not match";
    return null;
  }

  async function finish(): Promise<void> {
    const localError = persistenceError();
    if (localError) {
      completionError = localError;
      return;
    }
    if (!validateRelays() || saving) return;
    saving = true;
    completionError = null;
    try {
      completionError = await onComplete({
        name: normalizedName,
        persistence,
        passphrase,
        confirmPassphrase,
        relays: relays.map((relay) => relay.trim()),
        announce,
        autostart,
      });
    } finally {
      saving = false;
    }
  }

  async function recoverAnonymousIdentity(): Promise<void> {
    if (saving) return;
    saving = true;
    try {
      await userProfileStore.recoverAnonymousIdentity();
    } finally {
      saving = false;
    }
  }
</script>

<section class="coordinator-setup" data-testid="coordinator-setup" data-setup-state={visibleState} aria-labelledby="coordinator-setup-heading">
  {#if requestedState === "checking"}
    <div class="setup-copy">
      <p class="setup-kicker">First run</p>
      {#if userProfileStore.recoveryRequired}
        <h1 id="coordinator-setup-heading">Identity recovery required</h1>
        <p>Your local operator identity needs recovery before coordinator setup can continue.</p>
        <IdentityRotationDialog variant="recovery" membershipCount={0} onConfirm={recoverAnonymousIdentity} onClose={() => undefined} />
      {:else}
        <h1 id="coordinator-setup-heading">Preparing your coordinator</h1>
        <p role="status">Checking local coordinator setup…</p>
      {/if}
    </div>
  {:else if stage === "identity"}
    <div class="setup-copy" data-testid="setup-identity-stage">
      <p class="setup-kicker">First run · 1 of 3</p>
      <h1 id="coordinator-setup-heading">Choose your operator identity</h1>
      <p>Use a Nostr signer or continue with a durable identity stored only in this browser.</p>
    </div>
    <div class="setup-actions">
      <OperatorIdentityChoices testIdPrefix="setup" autoFocus onIdentityReady={continueWithSigner} />
      <button class="choice" data-testid="setup-anonymous" type="button" disabled={!userProfileStore.initialized || userProfileStore.recoveryRequired} onclick={() => void continueAnonymously()}>
        <strong>Continue anonymously</strong><small>No account required. This browser keeps a durable local identity.</small>
      </button>
    </div>
  {:else if stage === "name"}
    <form class="setup-form" data-testid="setup-name-stage" onsubmit={(event) => { event.preventDefault(); continueFromName(); }}>
      <div class="setup-copy">
        <p class="setup-kicker">First run · 2 of 3</p>
        <h1 id="coordinator-setup-heading">Name your coordinator</h1>
        <p>This name identifies the coordinator to people using Cordn-compatible clients. It is separate from your operator profile.</p>
      </div>
      <label for="setup-coordinator-name">Coordinator name</label>
      {#if profileNameMissing}<div data-testid="setup-profile-empty" class="profile-empty"><strong>No Nostr profile name available</strong><p>Choose a coordinator name to continue.</p></div>{/if}
      <input bind:this={nameInput} id="setup-coordinator-name" data-testid="setup-coordinator-name" value={name} maxlength="48" aria-invalid={nameInvalid ? "true" : undefined} aria-describedby={nameInvalid ? "setup-name-error" : undefined} oninput={(event) => { name = event.currentTarget.value; nameTouched = true; if (nameInvalid) validateName(); }} onblur={validateName} />
      {#if nameInvalid}<p id="setup-name-error" data-testid="setup-name-error" role="alert">Enter a coordinator name to continue.</p>{/if}
      <button class="primary final-action" data-testid="setup-save" type="submit" disabled={!canSaveName}>Save and continue</button>
      <p class="setup-note" aria-live="polite">{nameTouched ? "You can change this name later in coordinator settings." : ""}</p>
      <p class="sr-only" aria-live="polite">{profileSuggestionAnnouncement}</p>
    </form>
  {:else if stage === "path"}
    <div class="setup-form" data-testid="setup-path-stage">
      <div class="setup-copy"><p class="setup-kicker">First run · 3 of 3</p><h1 id="coordinator-setup-heading">Set up your coordinator</h1><p>Choose the recommended setup or configure each decision yourself.</p></div>
      <button class="choice recommended" data-testid="setup-recommended" type="button" onclick={() => void chooseRecommended()}><strong>Use recommended setup</strong><small>Save this coordinator securely and start it automatically.</small></button>
      <button class="choice" data-testid="setup-advanced" type="button" onclick={() => { stage = "persistence"; }}><strong>Advanced setup</strong><small>Choose persistence, relays, public announcements, and startup behavior.</small></button>
      <button class="back" type="button" onclick={() => { stage = "name"; }}>Back to coordinator name</button>
    </div>
  {:else if stage === "password"}
    <form class="setup-form" data-testid="setup-password-stage" onsubmit={(event) => { event.preventDefault(); void finish(); }}>
      <div class="setup-copy"><p class="setup-kicker">Recommended setup</p><h1 id="coordinator-setup-heading">Choose a coordinator password</h1><p>This encrypts the coordinator identity saved on this device. You will need it after restarting the browser.</p></div>
      <label for="setup-passphrase">Password</label><input bind:this={passphraseInput} id="setup-passphrase" data-testid="setup-passphrase" type="password" autocomplete="new-password" bind:value={passphrase} />
      <label for="setup-passphrase-confirmation">Confirm password</label><input id="setup-passphrase-confirmation" data-testid="setup-passphrase-confirmation" type="password" autocomplete="new-password" bind:value={confirmPassphrase} />
      {#if completionError}<p data-testid="setup-persistence-error" role="alert">{completionError}</p>{/if}
      <div class="footer-actions"><button class="back" type="button" disabled={saving} onclick={() => { stage = "path"; completionError = null; }}>Back to setup choices</button><button class="primary final-action" data-testid="setup-save-and-start" type="submit" disabled={saving}>{saving ? "Saving…" : "Save and start"}</button></div>
    </form>
  {:else if stage === "persistence"}
    <div class="setup-form" data-testid="setup-advanced-persistence" data-step="1">
      <div class="setup-copy"><p class="setup-kicker">Advanced setup · 1 of 4</p><h1 id="coordinator-setup-heading">Choose persistence</h1><p>Decide whether this browser can restore the same coordinator after it closes.</p></div>
      <button class:recommended={persistence === "persistent"} class="choice" data-testid="setup-persistent" type="button" aria-pressed={persistence === "persistent"} onclick={() => { persistence = "persistent"; completionError = null; }}><strong>Persistent</strong><small>Encrypt and save this coordinator on this device. Recommended.</small></button>
      <button class:recommended={persistence === "ephemeral"} class="choice" data-testid="setup-ephemeral" type="button" aria-pressed={persistence === "ephemeral"} onclick={() => { persistence = "ephemeral"; completionError = null; }}><strong>Ephemeral</strong><small>Use this coordinator only for the current browser session.</small></button>
      {#if persistence === "persistent"}<label for="advanced-passphrase">Password</label><input bind:this={passphraseInput} id="advanced-passphrase" data-testid="setup-passphrase" type="password" autocomplete="new-password" bind:value={passphrase} /><label for="advanced-passphrase-confirmation">Confirm password</label><input id="advanced-passphrase-confirmation" data-testid="setup-passphrase-confirmation" type="password" autocomplete="new-password" bind:value={confirmPassphrase} />{/if}
      {#if completionError}<p data-testid="setup-persistence-error" role="alert">{completionError}</p>{/if}
      <div class="footer-actions"><button class="back" type="button" onclick={() => { stage = "path"; }}>Back to setup choices</button><button class="primary" type="button" onclick={() => { const error = persistenceError(); if (error) completionError = error; else { completionError = null; stage = "relays"; } }}>Continue to relays</button></div>
    </div>
  {:else if stage === "relays"}
    <div class="setup-form" data-testid="setup-advanced-relays" data-step="2">
      <div class="setup-copy"><p class="setup-kicker">Advanced setup · 2 of 4</p><h1 id="coordinator-setup-heading">Choose relays</h1><p>These relays carry encrypted coordinator traffic. The defaults work for most people.</p></div>
      <div class="relay-list">{#each relays as relay, index (index)}<div class="relay-row"><input data-testid="setup-relay-input" aria-label={`Relay ${index + 1}`} value={relay} oninput={(event) => updateRelay(index, event.currentTarget.value)} /><button type="button" aria-label={`Remove relay ${index + 1}`} onclick={() => removeRelay(index)}>×</button></div>{/each}</div>
      {#if relayError}<p role="alert">{relayError}</p>{/if}
      <button class="choice add-relay" data-testid="setup-add-relay" type="button" onclick={addRelay}>+ Add relay</button>
      <div class="footer-actions"><button class="back" type="button" onclick={() => { stage = "persistence"; }}>Back to persistence</button><button class="primary" type="button" onclick={continueRelays}>Continue to announcement</button></div>
    </div>
  {:else if stage === "announce"}
    <div class="setup-form" data-testid="setup-advanced-announce" data-step="3">
      <div class="setup-copy"><p class="setup-kicker">Advanced setup · 3 of 4</p><h1 id="coordinator-setup-heading">Announce publicly?</h1><p>Public announcements make this coordinator discoverable beyond direct invitations.</p></div>
      <button class:recommended={!announce} class="choice" type="button" aria-pressed={!announce} onclick={() => { announce = false; }}><strong>No</strong><small>Keep the coordinator private unless you invite someone.</small></button>
      <button class:recommended={announce} class="choice" type="button" aria-pressed={announce} onclick={() => { announce = true; }}><strong>Yes</strong><small>Publish public discovery announcements.</small></button>
      <div class="footer-actions"><button class="back" type="button" onclick={() => { stage = "relays"; }}>Back to relays</button><button class="primary" type="button" onclick={() => { stage = "autostart"; }}>Continue to autostart</button></div>
    </div>
  {:else}
    <form class="setup-form" data-testid="setup-advanced-autostart" data-step="4" onsubmit={(event) => { event.preventDefault(); void finish(); }}>
      <div class="setup-copy"><p class="setup-kicker">Advanced setup · 4 of 4</p><h1 id="coordinator-setup-heading">Start automatically?</h1><p>Choose whether this coordinator starts whenever you open the app.</p></div>
      <button class:recommended={autostart} class="choice" type="button" aria-pressed={autostart} onclick={() => { autostart = true; }}><strong>Yes</strong><small>Start now and automatically on future visits.</small></button>
      <button class:recommended={!autostart} class="choice" type="button" aria-pressed={!autostart} onclick={() => { autostart = false; }}><strong>No</strong><small>Wait for you to start it manually.</small></button>
      {#if completionError}<p data-testid="setup-persistence-error" role="alert">{completionError}</p>{/if}
      <div class="footer-actions"><button class="back" type="button" disabled={saving} onclick={() => { stage = "announce"; }}>Back to announcement</button><button class="primary final-action" data-testid="setup-finish" type="submit" disabled={saving}>{saving ? "Saving…" : autostart ? "Save and start" : "Finish setup"}</button></div>
    </form>
  {/if}
</section>

<style>
  .coordinator-setup { width: min(34rem, calc(100% - 32px)); max-height: 100%; overflow-y: auto; border: 1px solid #496451; background: #101614; padding: 1.5rem; color: #dfffe7; }
  .setup-copy, .setup-form, .setup-actions { display: grid; gap: 1rem; }
  .setup-copy { margin-bottom: 1.5rem; }
  .setup-kicker { margin: 0; color: #7cf59d; font-size: 10px; letter-spacing: .14em; line-height: 1.3; text-transform: uppercase; }
  h1 { margin: 0; color: #effff2; font-size: 28px; font-weight: 600; line-height: 1.2; }
  p { margin: 0; color: #82958a; font-size: 12px; line-height: 1.5; }
  label { color: #cfe2d4; font-size: 12px; line-height: 1.5; }
  input { box-sizing: border-box; width: 100%; min-height: 44px; border: 1px solid #34483a; background: #030303; padding: .5rem 1rem; color: #effff2; font: inherit; }
  input:focus-visible, button:focus-visible { outline: 2px solid #7cf59d; outline-offset: 2px; }
  input[aria-invalid="true"] { border-color: #ffaaa3; }
  [role="alert"] { color: #ffaaa3; }
  button { cursor: pointer; font: inherit; }
  .choice, .primary, .back { min-height: 44px; border: 1px solid #34483a; background: #0d1711; padding: 1rem; color: #dfffe7; text-align: left; }
  .choice:hover { border-color: #496451; background: #111a14; }
  .choice.recommended { border-color: #7cf59d; background: #102017; }
  .choice strong, .choice small { display: block; }
  .choice strong { font-size: 18px; font-weight: 600; line-height: 1.25; }
  .choice small { margin-top: .25rem; color: #82958a; font-size: 12px; line-height: 1.5; }
  .primary { color: #cfe2d4; text-align: center; }
  .primary.final-action { border-color: #7cf59d; color: #7cf59d; }
  .back { border-color: transparent; background: transparent; color: #82958a; text-align: center; }
  .footer-actions { position: sticky; bottom: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 1rem; margin-top: .5rem; background: #101614; padding-top: 1rem; }
  button:disabled { cursor: not-allowed; opacity: .45; }
  .setup-note { min-height: 1.25rem; }
  .profile-empty { display: grid; gap: 4px; border-left: 2px solid #496451; padding-left: 8px; }
  .profile-empty strong { color: #dfffe7; font-size: 12px; font-weight: 600; }
  .relay-list { display: grid; gap: .5rem; }
  .relay-row { display: grid; grid-template-columns: minmax(0, 1fr) 44px; gap: .5rem; }
  .relay-row button { border: 1px solid #34483a; background: #0d1711; color: #ffaaa3; }
  .add-relay { color: #7cf59d; text-align: center; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  @media (max-width: 520px) { .coordinator-setup { width: min(100% - 16px, 34rem); padding: 1.5rem 1rem; } .footer-actions { grid-template-columns: 1fr; } }
</style>
