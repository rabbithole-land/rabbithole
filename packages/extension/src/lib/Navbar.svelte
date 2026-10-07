<script lang="ts">
  import { onMount, createEventDispatcher } from "svelte";
  import { Button, ActionIcon, Menu, Tooltip } from "@svelteuidev/core";
  import { Agent } from "@atproto/api";
  import {
    MagnifyingGlass,
    Person,
    Sun,
    Moon,
    Gear,
    Exit,
    Download,
    Upload,
    QuestionMarkCircled,
    FileText,
    EyeNone,
    EyeOpen,
    Globe,
    BarChart,
  } from "svelte-radix";
  import SearchEverywhereModal from "src/lib/SearchEverywhereModal.svelte";
  import Modal from "src/lib/Modal.svelte";
  import logoStars from "@rabbithole/shared/assets/rabbithole-logo-stars.svg";
  import Auth from "src/lib/Auth.svelte";
  import OnboardingModal from "src/lib/OnboardingModal.svelte";
  import CategoriseModal from "src/lib/CategoriseModal.svelte";
  import { getSession, clearSession } from "../atproto/client";
  import { MessageRequest, Logger } from "../utils";
  import { initPostHog, stopPostHog } from "../utils/posthog";
  import type { Settings } from "src/utils/types";

  export let onRabbitholesClick = () => {};
  export let onBurrowsClick = () => {};
  export let onExploreClick = () => {};
  export let isDark: boolean = false;

  const dispatch = createEventDispatcher();

  let showSearchModal: boolean = false;
  let showAuthModal: boolean = false;
  let showOnboardingModal: boolean = false;
  let showCategoriseModal: boolean = false;
  let showImportModal: boolean = false;
  let importSyncing: boolean = false;
  let importResult: string | null = null;
  let importError: string | null = null;
  let showHelpTooltip: boolean = false;
  let isMac = navigator.userAgent.includes("Mac");
  let isLoggedIn: boolean = false;
  let userHandle: string = "";
  let userAvatar: string = "";
  let fileInput: HTMLInputElement;

  let settings: Settings | null = null;
  let showOverlay: boolean = true;
  let analyticsEnabled: boolean = false;
  let showAnalyticsNudge: boolean = false;

  function dismissHelpTooltip() {
    if (showHelpTooltip) {
      showHelpTooltip = false;
      localStorage.setItem("rabbithole_has_seen_help_v2", "true");
    }
  }

  function handleWindowClick() {
    dismissHelpTooltip();
  }

  onMount(async () => {
    chrome.storage.local
      .get("loggingEnabled")
      .then((v) => (loggingEnabled = v.loggingEnabled === true));
    settings = await chrome.runtime.sendMessage({
      type: MessageRequest.GET_SETTINGS,
    });
    showOverlay = settings?.show ?? true;
    analyticsEnabled = settings?.analyticsEnabled ?? false;
    showAnalyticsNudge =
      settings?.hasSeenOnboarding && !settings?.analyticsEnabled;

    const session = await getSession();
    if (session) {
      isLoggedIn = true;
      userHandle = session.handle || "";
      loadUserProfile(session);
    }

    function handleKeydown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        openSearchModal();
      }
    }

    window.addEventListener("keydown", handleKeydown);

    // Show help tooltip on first startup
    if (!localStorage.getItem("rabbithole_has_seen_help_v2")) {
      setTimeout(() => {
        showHelpTooltip = true;
        setTimeout(() => {
          dismissHelpTooltip();
        }, 3000);
      }, 1000);
    }

    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  });

  async function loadUserProfile(session): Promise<void> {
    try {
      const agent = new Agent("https://public.api.bsky.app");
      const response = await agent.getProfile({ actor: session.did });
      if (response.success) {
        userAvatar = response.data.avatar;
        userHandle = response.data.handle;
      }
    } catch (e) {
      Logger.error("Failed to load user profile", e);
    }
  }

  function openSearchModal(): void {
    showSearchModal = true;
  }

  function handleSignIn(): void {
    showAuthModal = true;
  }

  function handleCleanUpTabs(): void {
    showCategoriseModal = true;
  }

  function handleToggleTheme(): void {
    dispatch("toggleTheme");
  }

  async function handleToggleOverlay(): Promise<void> {
    showOverlay = !showOverlay;
    if (settings) {
      settings.show = showOverlay;
      await chrome.runtime.sendMessage({
        type: MessageRequest.UPDATE_SETTINGS,
        settings,
      });
    }
  }

  async function handleToggleAnalytics(): Promise<void> {
    analyticsEnabled = !analyticsEnabled;
    showAnalyticsNudge = false;
    if (settings) {
      settings.analyticsEnabled = analyticsEnabled;
      await chrome.runtime.sendMessage({
        type: MessageRequest.UPDATE_SETTINGS,
        settings,
      });
      if (analyticsEnabled) {
        initPostHog();
      } else {
        stopPostHog();
      }
    }
  }

  async function handleAuthSuccess(
    event: CustomEvent<{ imported: { trails: number; collections: number } }>,
  ): Promise<void> {
    showAuthModal = false;

    // Refresh login state
    const session = await getSession();
    if (session) {
      isLoggedIn = true;
      userHandle = session.handle || "";
      await loadUserProfile(session);
    }

    const imported = event.detail?.imported;
    dispatch("authStateChange", { type: "login", imported });
  }

  async function handleSignOut(): Promise<void> {
    await clearSession();
    isLoggedIn = false;
    userHandle = "";
    userAvatar = "";
    dispatch("authStateChange", { type: "logout" });
  }

  async function handleDownloadLogs(): Promise<void> {
    await Logger.downloadLogs();
  }

  // persistent logging is opt-in (see utils/logger)
  let loggingEnabled: boolean = false;

  async function handleToggleLogging(): Promise<void> {
    loggingEnabled = !loggingEnabled;
    await chrome.storage.local.set({ loggingEnabled });
  }

  async function exportData(): Promise<void> {
    const burrows = await chrome.runtime.sendMessage({
      type: MessageRequest.GET_ALL_BURROWS,
    });
    const websites = await chrome.runtime.sendMessage({
      type: MessageRequest.GET_ALL_ITEMS,
    });
    const rabbitholes = await chrome.runtime.sendMessage({
      type: MessageRequest.GET_ALL_RABBITHOLES,
    });
    const trails = await chrome.runtime.sendMessage({
      type: MessageRequest.GET_ALL_TRAILS,
    });

    const exportData = {
      burrows,
      websites,
      rabbitholes,
      trails,
    };

    const blob = new Blob([JSON.stringify(exportData)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const date = new Date();
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = date.getFullYear();
    const filename = `rabbithole-${day}-${month}-${year}.json`;

    link.href = url;
    link.setAttribute("download", filename);
    link.click();
  }

  async function handleImport(event: CustomEvent<any>): Promise<void> {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e: CustomEvent<any>) => {
      try {
        const data = JSON.parse(e.target.result);

        let burrowsToImport = [];
        let websitesToImport = [];
        let rabbitholesToImport = [];

        if (Array.isArray(data)) {
          burrowsToImport = data;
        } else if (data && typeof data === "object") {
          burrowsToImport = data.burrows ?? data.projects ?? [];
          websitesToImport = data.websites ?? data.savedWebsites ?? [];
          rabbitholesToImport = data.rabbitholes ?? [];
        }

        await chrome.runtime.sendMessage({
          type: MessageRequest.IMPORT_DATA,
          burrows: burrowsToImport,
          websites: websitesToImport,
          rabbitholes: rabbitholesToImport,
        });

        onBurrowsClick();
      } catch (err) {
        Logger.error("Failed to parse import file", err);
      }
    };
    reader.readAsText(file);
    event.target.value = "";
  }

  function triggerImport(): void {
    if (isLoggedIn) {
      showImportModal = true;
    } else {
      fileInput.click();
    }
  }

  async function importFromAtmosphere(): Promise<void> {
    importSyncing = true;
    importResult = null;
    importError = null;
    try {
      const response = await chrome.runtime.sendMessage({
        type: MessageRequest.SYNC_ATPROTO,
      });
      if (response?.imported) {
        const { trails, burrows } = response.imported;
        const parts = [];
        if (trails?.count) parts.push(`${trails.count} trail(s)`);
        if (burrows?.count) parts.push(`${burrows.count} collection(s)`);
        importResult = parts.length
          ? `Imported ${parts.join(" and ")} from Atmosphere.`
          : "No new data found on Atmosphere.";
      }
      onBurrowsClick();
    } catch (e) {
      Logger.error("Atmosphere import failed", e);
      importError = "Failed to import: " + e.message;
    } finally {
      importSyncing = false;
    }
  }

  function importFromFile(): void {
    showImportModal = false;
    fileInput.click();
  }

  function handleSearchSelectRabbithole(event: CustomEvent<any>): void {
    dispatch("selectRabbithole", event.detail);
  }

  function handleSearchSelectBurrow(event: CustomEvent<any>): void {
    dispatch("selectBurrow", event.detail);
  }

  function handleSearchSelectTrail(event: CustomEvent<any>): void {
    dispatch("selectTrail", event.detail);
  }
</script>

<svelte:window on:click={handleWindowClick} />

<SearchEverywhereModal
  bind:isOpen={showSearchModal}
  on:selectRabbithole={handleSearchSelectRabbithole}
  on:selectBurrow={handleSearchSelectBurrow}
  on:selectTrail={handleSearchSelectTrail}
/>

<Modal
  isOpen={showAuthModal}
  title="Sign in with Atmosphere Account"
  titleLink="https://atmosphereaccount.com"
  on:close={() => (showAuthModal = false)}
>
  <Auth on:authSuccess={handleAuthSuccess} showWhyBluesky={true} />
</Modal>

<Modal
  isOpen={showImportModal}
  title="Import Data"
  on:close={() => {
    showImportModal = false;
    importResult = null;
    importError = null;
  }}
>
  {#if importSyncing}
    <div class="import-syncing">
      <span class="import-syncing-text">Syncing from Atmosphere...</span>
    </div>
  {:else if importResult}
    <p class="import-result">{importResult}</p>
    <div style="text-align: right; margin-top: 16px;">
      <Button
        on:click={() => {
          showImportModal = false;
          importResult = null;
        }}>Done</Button
      >
    </div>
  {:else if importError}
    <p class="import-error">{importError}</p>
    <div style="text-align: right; margin-top: 16px;">
      <Button
        variant="subtle"
        color="gray"
        on:click={() => {
          importError = null;
        }}>Back</Button
      >
    </div>
  {:else}
    <p style="margin-bottom: 16px; color: #868e96; font-size: 14px;">
      Where would you like to import from?
    </p>

    <div class="import-options">
      <button class="import-option" on:click={importFromFile}>
        <div class="import-option-icon"><Upload size={20} /></div>
        <div class="import-option-text">
          <div class="import-option-title">From File</div>
          <div class="import-option-desc">Import a JSON backup file</div>
        </div>
      </button>

      <button class="import-option" on:click={importFromAtmosphere}>
        <div class="import-option-icon"><Globe size={20} /></div>
        <div class="import-option-text">
          <div class="import-option-title">From Atmosphere</div>
          <div class="import-option-desc">
            Sync your Semble collections and Sidetrails
          </div>
        </div>
      </button>
    </div>
  {/if}
</Modal>

<input
  type="file"
  accept=".json"
  style="display: none;"
  bind:this={fileInput}
  on:change={handleImport}
/>

<nav class="navbar">
  <div class="navbar-left">
    <div class="logo-container">
      <img class="logo" alt="Rabbithole logo" src={logoStars} /><span
        class="alpha-badge">alpha</span
      >
    </div>
    <Button
      variant="subtle"
      color="gray"
      size="md"
      on:click={onRabbitholesClick}
      class="rabbitholes-btn"
    >
      Rabbitholes
    </Button>
    <Button
      variant="subtle"
      color="gray"
      size="md"
      on:click={onExploreClick}
      class="rabbitholes-btn"
    >
      Explore
    </Button>
  </div>

  <div class="navbar-center">
    <button class="search-button" on:click={openSearchModal}>
      <MagnifyingGlass size={14} />
      <span class="search-text">Search everywhere...</span>
      <span class="search-shortcut">{isMac ? "⌘K" : "Ctrl+K"}</span>
    </button>
  </div>

  <div class="navbar-right">
    <Tooltip
      label={showHelpTooltip ? "Click here to see the tour again" : "Help"}
      opened={showHelpTooltip || undefined}
      withArrow
    >
      <ActionIcon
        color="gray"
        size="lg"
        radius="xl"
        on:click={(e) => {
          e.stopPropagation();
          showOnboardingModal = true;
          dismissHelpTooltip();
        }}
      >
        <QuestionMarkCircled size={18} />
      </ActionIcon>
    </Tooltip>

    <ActionIcon
      color="gray"
      size="lg"
      radius="xl"
      on:click={handleToggleTheme}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {#if isDark}
        <Sun size={18} />
      {:else}
        <Moon size={18} />
      {/if}
    </ActionIcon>

    {#if isLoggedIn}
      <div class="profile-btn-wrapper">
        <Menu placement="end" withArrow>
          <ActionIcon
            slot="control"
            variant="light"
            color="blue"
            size="lg"
            radius="xl"
            title={userHandle}
            style="overflow: hidden; padding: {userAvatar ? '0' : ''};"
          >
            {#if userAvatar}
              <img
                src={userAvatar}
                alt={userHandle}
                style="width: 100%; height: 100%; object-fit: cover;"
              />
            {:else}
              <Person size={18} />
            {/if}
          </ActionIcon>

          <Menu.Item
            icon={showOverlay ? EyeNone : EyeOpen}
            on:click={handleToggleOverlay}
          >
            {showOverlay ? "Hide Overlay" : "Show Overlay"}
          </Menu.Item>
          <Menu.Item
            icon={BarChart}
            on:click={handleToggleAnalytics}
            class={showAnalyticsNudge ? "analytics-nudge-item" : ""}
          >
            <span class="analytics-menu-item">
              <span>{analyticsEnabled ? "Disable" : "Enable"} Analytics</span>
              {#if showAnalyticsNudge}
                <span class="analytics-nudge-text">Help us improve!</span>
              {/if}
            </span>
          </Menu.Item>
          <Menu.Item icon={Upload} on:click={triggerImport}>
            Import Data
          </Menu.Item>
          <Menu.Item icon={Download} on:click={exportData}
            >Export Data</Menu.Item
          >
          <Menu.Item icon={FileText} on:click={handleToggleLogging}>
            {loggingEnabled ? "Disable" : "Enable"} Logging
          </Menu.Item>
          <Menu.Item icon={FileText} on:click={handleDownloadLogs}>
            Download Logs
          </Menu.Item>
          <Menu.Item icon={Exit} color="red" on:click={handleSignOut}>
            Sign Out
          </Menu.Item>
        </Menu>
        {#if showAnalyticsNudge}
          <div class="analytics-nudge-badge"></div>
        {/if}
      </div>
    {:else}
      <div class="connect-container" id="tour-signin-btn">
        <Button
          variant="light"
          color="blue"
          size="sm"
          on:click={handleCleanUpTabs}
        >
          Clean Up My Tabs
        </Button>
        <Button variant="light" color="blue" size="sm" on:click={handleSignIn}>
          Sign in
        </Button>
        <div class="profile-btn-wrapper">
          <Menu placement="end" withArrow>
            <ActionIcon
              slot="control"
              variant="filled"
              color="gray"
              size="lg"
              radius="xl"
              title="Settings"
            >
              <Gear size={18} />
            </ActionIcon>

            <Menu.Item
              icon={BarChart}
              on:click={handleToggleAnalytics}
              class={showAnalyticsNudge ? "analytics-nudge-item" : ""}
            >
              <span class="analytics-menu-item">
                <span>{analyticsEnabled ? "Disable" : "Enable"} Analytics</span>
                {#if showAnalyticsNudge}
                  <span class="analytics-nudge-text">Help us improve!</span>
                {/if}
              </span>
            </Menu.Item>
            <Menu.Item
              icon={showOverlay ? EyeNone : EyeOpen}
              on:click={handleToggleOverlay}
            >
              {showOverlay ? "Hide Overlay" : "Show Overlay"}
            </Menu.Item>
            <Menu.Item icon={Upload} on:click={triggerImport}>
              Import Data
            </Menu.Item>
            <Menu.Item icon={Download} on:click={exportData}>
              Export Data
            </Menu.Item>
            <Menu.Item icon={FileText} on:click={handleToggleLogging}>
              {loggingEnabled ? "Disable" : "Enable"} Logging
            </Menu.Item>
            <Menu.Item icon={FileText} on:click={handleDownloadLogs}>
              Download Logs
            </Menu.Item>
          </Menu>
          {#if showAnalyticsNudge}
            <div class="analytics-nudge-badge"></div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</nav>

<OnboardingModal
  isOpen={showOnboardingModal}
  on:close={() => (showOnboardingModal = false)}
/>

<CategoriseModal
  bind:isOpen={showCategoriseModal}
  on:applied={() => dispatch("authStateChange", { type: "refresh" })}
/>

<style>
  .import-options {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .import-option {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 16px;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 10px;
    background: transparent;
    cursor: pointer;
    text-align: left;
    transition:
      background 0.15s,
      border-color 0.15s;
    font-family: inherit;
  }

  .import-option:hover {
    background: #f8f9fa;
    border-color: #1185fe59;
  }

  .import-option-icon {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    background: #1185fe0d;
    border: 1px solid rgba(17, 133, 254, 0.15);
    display: flex;
    align-items: center;
    justify-content: center;
    color: #1185fe;
    flex-shrink: 0;
  }

  .import-option-title {
    font-size: 14px;
    font-weight: 600;
    color: #1a1b1e;
  }

  .import-option-desc {
    font-size: 12px;
    color: #868e96;
    margin-top: 2px;
  }

  :global(body.dark-mode) .import-option {
    border-color: rgba(255, 255, 255, 0.08);
  }

  :global(body.dark-mode) .import-option:hover {
    background: #ffffff0a;
    border-color: #4dabf773;
  }

  :global(body.dark-mode) .import-option-icon {
    background: #4dabf714;
    border-color: rgba(77, 171, 247, 0.2);
    color: #4dabf7;
  }

  :global(body.dark-mode) .import-option-title {
    color: #e7e7e7;
  }

  .import-syncing {
    display: flex;
    justify-content: center;
    padding: 20px 0;
  }

  .import-syncing-text {
    font-size: 14px;
    color: #868e96;
  }

  .import-result {
    font-size: 14px;
    color: #2b8a3e;
    margin: 0;
  }

  .import-error {
    font-size: 14px;
    color: #e03131;
    margin: 0;
  }

  :global(body.dark-mode) .import-result {
    color: #69db7c;
  }

  :global(body.dark-mode) .import-error {
    color: #ff6b6b;
  }

  .navbar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 58px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 26px;
    background-color: rgba(255, 255, 255, 0.4);
    backdrop-filter: blur(10px);
    transition: background-color 0.3s ease;
    border-bottom: 1px solid rgba(0, 0, 0, 0.05);
    z-index: 1000;
    gap: 26px;
    color: #1a1b1e;
  }

  .navbar:hover {
    background-color: rgba(255, 255, 255, 0.95);
  }

  .navbar-left {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-shrink: 0;
  }

  .logo-container {
    display: flex;
    align-items: center;
  }

  .logo {
    width: 38px;
    height: auto;
  }

  :global(body.dark-mode) .logo {
    filter: invert(1);
  }

  .alpha-badge {
    font-size: 9px;
    font-weight: 700;
    color: #4dabf7;
    background: rgba(77, 171, 247, 0.15);
    padding: 2px 5px;
    border-radius: 4px;
    margin-left: 6px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  :global(.rabbitholes-btn) {
    font-weight: 600;
    font-size: 13px;
  }

  .navbar-center {
    flex: 1;
    max-width: 560px;
    display: flex;
    justify-content: center;
  }

  .search-button {
    width: 100%;
    max-width: 480px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 13px;
    background-color: rgba(0, 0, 0, 0.05);
    backdrop-filter: blur(8px);
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s ease;
    font-size: 12px;
    color: #1a1b1e;
  }

  .search-button:hover {
    background-color: rgba(0, 0, 0, 0.08);
    border-color: rgba(0, 0, 0, 0.2);
  }

  .search-text {
    flex: 1;
    text-align: left;
  }

  .search-shortcut {
    font-size: 10px;
    padding: 2px 6px;
    background-color: rgba(255, 255, 255, 0.5);
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 4px;
    color: #1a1b1e;
    font-family: monospace;
  }

  .navbar-right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .connect-container {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .profile-btn-wrapper {
    position: relative;
    display: inline-flex;
  }

  .analytics-nudge-badge {
    position: absolute;
    top: -2px;
    right: -2px;
    width: 10px;
    height: 10px;
    background: #fa5252;
    border: 2px solid white;
    border-radius: 50%;
    z-index: 1;
  }

  :global(body.dark-mode) .analytics-nudge-badge {
    border-color: #25262b;
  }

  .analytics-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .analytics-nudge-text {
    font-size: 10px;
    color: #fa5252;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  :global(.analytics-nudge-item) {
    background: rgba(250, 82, 82, 0.06) !important;
  }

  :global(body.dark-mode .analytics-nudge-item) {
    background: rgba(250, 82, 82, 0.1) !important;
  }

  /* Dark mode */
  :global(body.dark-mode) .navbar {
    background-color: rgba(37, 38, 43, 0.4);
    border-bottom-color: rgba(255, 255, 255, 0.1);
    color: white;
  }

  :global(body.dark-mode) .navbar:hover {
    background-color: rgba(37, 38, 43, 0.95);
  }

  :global(body.dark-mode) .search-button {
    background-color: rgba(37, 38, 43, 0.8);
    border-color: rgba(55, 58, 64, 0.6);
    color: white;
  }

  :global(body.dark-mode) .search-button:hover {
    background-color: rgba(44, 46, 51, 0.9);
    border-color: rgba(73, 80, 87, 0.8);
  }

  :global(body.dark-mode) .search-shortcut {
    background-color: rgba(26, 27, 30, 0.9);
    border-color: rgba(55, 58, 64, 0.6);
    color: white;
  }

  /* Responsive */
  @media (max-width: 768px) {
    .navbar {
      padding: 0 16px;
      gap: 13px;
      height: 51px;
    }

    .navbar-center {
      max-width: 320px;
    }

    .search-text {
      display: none;
    }

    .search-button {
      padding: 10px;
      justify-content: center;
    }

    .logo {
      width: 32px;
    }
  }

  @media (max-width: 480px) {
    .logo {
      width: 28px;
    }

    :global(.rabbitholes-btn) {
      font-size: 12px;
      padding: 8px 11px;
    }

    .navbar-center {
      max-width: 160px;
    }
  }
</style>
