<script lang="ts">
  import { onMount } from "svelte";
  import HostWorkspace from "./components/HostWorkspace.svelte";
  import MessageGroupTestHarness from "./components/MessageGroupTestHarness.svelte";
  import PassphrasePrompt from "./components/PassphrasePrompt.svelte";
  import { configStore } from "./config/config.svelte";
  import { coordinatorStore } from "./coordinator/coordinator.svelte";
  import { userProfileStore } from "./identity/user-profile.svelte";
  import { nostrSocialStore } from "./invites/nostr-social.svelte";
  import {
    initialWorkspaceIntent,
    isLegacyChatIndexPath,
    withWorkspaceIntent,
    workspaceIntentFromHref,
  } from "./navigation/workspace-route";

  const shellOrigin = window.location.origin;
  const initialSearchParams = new URL(window.location.href).searchParams;
  const e2eBuild = import.meta.env.VITE_E2E === "1";
  const messageGroupTestHarness = e2eBuild && initialSearchParams.has("__message-group-test-harness");
  const messageGroupTestHarnessPane = initialSearchParams.get("pane") === "host" ? "host" : "guest";
  const rootUrl = new URL("/", shellOrigin).href;
  const initialIntent = initialWorkspaceIntent(window.location.href, window.history.state, shellOrigin);
  let currentUrl = $state(initialIntent ?? rootUrl);
  let lockedWorkspaceOpen = $state(initialIntent !== null);
  const hasWorkspaceIntent = $derived(currentUrl !== rootUrl);
  const homeCoordinatorPubkey = $derived(
    coordinatorStore.loadState === "ready" ? coordinatorStore.identity.publicKeyHex : undefined,
  );
  const identityReady = $derived(userProfileStore.initialized);
  const e2eContactFollowing = $derived([...nostrSocialStore.following].sort());
  const e2eContactOwnerReady = $derived(
    nostrSocialStore.contactPubkey.length > 0 && nostrSocialStore.contactStatus !== "idle",
  );
  const emptyIdentity = { publicKeyHex: "", npub: "" };

  canonicalize(initialIntent);

  $effect(() => {
    void userProfileStore.initialize(configStore.userName);
  });

  $effect(() => {
    const signer = userProfileStore.activeSigner;
    const authenticated = userProfileStore.initialized
      && userProfileStore.method !== "anonymous"
      && signer !== null
      && userProfileStore.pubkey.length > 0;
    if (!authenticated || !signer) {
      nostrSocialStore.stopContactList();
      return;
    }
    void nostrSocialStore.startContactList(signer);
    return () => nostrSocialStore.stopContactList();
  });

  function canonicalize(intent: string | null): void {
    window.history.replaceState(
      withWorkspaceIntent(window.history.state, intent),
      "",
      "/",
    );
  }

  function navigate(href: string) {
    const target = new URL(href, shellOrigin);
    const intent = workspaceIntentFromHref(target.href, shellOrigin);
    if (intent) {
      currentUrl = intent;
      canonicalize(intent);
      return;
    }
    if (target.origin !== shellOrigin) {
      window.location.assign(target.href);
      return;
    }
    if (target.pathname === "/" || isLegacyChatIndexPath(target.pathname)) {
      currentUrl = rootUrl;
      canonicalize(null);
      return;
    }
    window.location.assign(target.href);
  }

  onMount(() => {
    const handlePopState = () => {
      const intent = initialWorkspaceIntent(window.location.href, window.history.state, shellOrigin);
      currentUrl = intent ?? rootUrl;
      canonicalize(intent);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  });
</script>

{#if messageGroupTestHarness}
  <MessageGroupTestHarness pane={messageGroupTestHarnessPane} />
{:else if coordinatorStore.loadState === "prompting" && !lockedWorkspaceOpen && !hasWorkspaceIntent}
  <PassphrasePrompt
    coordinator={coordinatorStore}
    onOpenChats={() => lockedWorkspaceOpen = true}
  />
{:else}
  {#key coordinatorStore.loadState}
    <HostWorkspace
      coordinator={coordinatorStore}
      config={configStore}
      identity={coordinatorStore.loadState === "ready" ? coordinatorStore.identity : emptyIdentity}
      coordinatorPubkey={homeCoordinatorPubkey ?? ""}
      relayUrls={configStore.inviteRelayUrls}
      {currentUrl}
      {homeCoordinatorPubkey}
      {identityReady}
      locked={coordinatorStore.loadState === "prompting"}
      onNavigate={navigate}
    />
  {/key}
{/if}

{#if e2eBuild}
  <output
    hidden
    aria-hidden="true"
    data-testid="contact-lifecycle-probe"
    data-contact-pubkey={nostrSocialStore.contactPubkey}
    data-contact-status={nostrSocialStore.contactStatus}
    data-following={e2eContactFollowing.join(",")}
    data-owner-ready={e2eContactOwnerReady ? "true" : "false"}
  >contact-lifecycle-probe</output>
{/if}
