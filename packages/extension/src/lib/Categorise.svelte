<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import { Button } from "@svelteuidev/core";
  import { ArrowRight, Plus, Cross1, Pencil1 } from "svelte-radix";
  import { MessageRequest } from "../utils/types";
  import { warn as logWarn, debug as logDebug } from "../utils/logger";
  import type { CloudProviderConfig, CloudProviderId } from "../llm/cloud";
  import { CloudProviders } from "../llm/cloud";
  import type { Rabbithole } from "../utils/types";
  import type { TabInfo } from "../utils/types";
  import type { Candidate } from "../llm/pipeline";

  const dispatch = createEventDispatcher();

  export let onboarding = false;

  const providerEntries = Object.entries(CloudProviders) as [
    CloudProviderId,
    (typeof CloudProviders)[CloudProviderId],
  ][];

  interface CategoriseGroup {
    id: string;
    title: string;
    description: string;
    isNew: boolean;
    isMisc?: boolean;
    tabIndices: number[];
  }

  // user-only bucket: tabs stay open, never saved to a rabbithole
  const MiscGroupId = "misc";

  let loading: boolean = false;
  let error: string | null = null;
  let needsSetup: boolean = false;
  let setupProvider: string = "";
  let setupApiKey: string = "";
  let setupModel: string = "";
  let tabs: TabInfo[] = [];
  let candidates: Candidate[] = [];
  let groups: CategoriseGroup[] = [];
  let allRabbitholes: Rabbithole[] = [];
  let applying: boolean = false;
  let showSuccess: boolean = false;
  let savedTabCount: number = 0;
  let savedGroupCount: number = 0;
  let rerunCount: number = 0;
  let rerunning: boolean = false;
  let candidatesDirty: boolean = false;
  let showAddCandidate: boolean = false;
  let editingCandidateIdx: number | null = null;
  let newCandidateTitle: string = "";
  let newCandidateDesc: string = "";

  let newRabbitholeDefs: Map<string, { title: string; description: string }> =
    new Map();

  let movingTabIdx: number | null = null;
  let searchQuery: string = "";
  let searchInput: HTMLInputElement;

  onMount(() => {
    checkSetup();
  });

  async function loadCloudConfig(): Promise<CloudProviderConfig | undefined> {
    const saved = await chrome.storage.local.get([
      "cloudProvider",
      "cloudApiKey",
      "cloudModel",
    ]);
    if (saved.cloudProvider && saved.cloudApiKey) {
      return {
        apiKey: saved.cloudApiKey,
        providerId: saved.cloudProvider as CloudProviderId,
        model: saved.cloudModel || undefined,
      };
    }
    return undefined;
  }

  async function checkSetup(): Promise<void> {
    const config = await loadCloudConfig();
    if (!config) {
      needsSetup = true;
      const saved = await chrome.storage.local.get([
        "cloudProvider",
        "cloudModel",
      ]);
      setupProvider = saved.cloudProvider ?? "";
      setupModel = saved.cloudModel ?? "";
    } else {
      needsSetup = false;
      runProposal();
    }
  }

  async function saveSetup(): Promise<void> {
    await chrome.storage.local.set({
      cloudProvider: setupProvider,
      cloudApiKey: setupApiKey,
      cloudModel: setupModel,
    });
    needsSetup = false;
    runProposal();
  }

  function modelPlaceholder(): string {
    if (!setupProvider) return "Model (optional override)";
    const p = CloudProviders[setupProvider as CloudProviderId];
    return p ? `Model (default: ${p.model})` : "Model (optional override)";
  }

  function getDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  async function runProposal(): Promise<void> {
    loading = true;
    error = null;
    candidates = [];

    try {
      const cloudConfig = await loadCloudConfig();
      const result = await chrome.runtime.sendMessage({
        type: MessageRequest.PROPOSE_CATEGORISE,
        cloudConfig,
      });

      if (result?.error) {
        const errStr = String(result.error);
        if (
          errStr.includes("invalid_api_key") ||
          errStr.includes("401") ||
          errStr.includes("Incorrect API key")
        ) {
          needsSetup = true;
          const saved = await chrome.storage.local.get([
            "cloudProvider",
            "cloudModel",
          ]);
          setupProvider = saved.cloudProvider ?? "";
          setupModel = saved.cloudModel ?? "";
          setupApiKey = "";
        } else {
          error = result.error;
        }
        return;
      }

      tabs = result.tabs ?? [];
      candidates = result.candidates ?? [];

      if (result.assignments) {
        // pipeline already computed assignments — render them directly
        // without a redundant Jev pass
        await renderAssignments(result.assignments ?? {});
      } else {
        // fallback: candidates without assignments (older message shape)
        await runAssignment(true);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to propose categories";
    } finally {
      loading = false;
    }
  }

  function candidateGroupId(c: Candidate): string {
    return c.existingId ?? `new-${c.key}`;
  }

  function addCandidate(): void {
    if (!newCandidateTitle.trim()) return;
    const base = newCandidateTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 20);
    let key = base;
    let suffix = 2;
    while (candidates.some((c) => c.key === key)) {
      key = `${base}-${suffix}`;
      suffix += 1;
    }
    candidates.push({
      key,
      title: newCandidateTitle.trim(),
      description: newCandidateDesc.trim() || newCandidateTitle.trim(),
      userAdded: true,
    });
    candidates = candidates;
    candidatesDirty = true;
    showAddCandidate = false;
    newCandidateTitle = "";
    newCandidateDesc = "";
  }

  function removeCandidate(idx: number): void {
    const removed = candidates[idx];
    candidates.splice(idx, 1);
    candidates = candidates;
    candidatesDirty = true;
    // Drop the removed candidate's group so Confirm can't save its tabs
    const groupId = candidateGroupId(removed);
    groups = groups.filter((g) => g.id !== groupId);
    newRabbitholeDefs.delete(groupId);
  }

  function closeAddCandidate(): void {
    showAddCandidate = false;
    editingCandidateIdx = null;
    newCandidateTitle = "";
    newCandidateDesc = "";
  }

  function startEditCandidate(idx: number): void {
    editingCandidateIdx = idx;
    newCandidateTitle = candidates[idx].title;
    newCandidateDesc = candidates[idx].description;
    showAddCandidate = true;
  }

  function saveCandidateEdit(): void {
    if (editingCandidateIdx === null || !newCandidateTitle.trim()) {
      return;
    }
    candidates[editingCandidateIdx] = {
      ...candidates[editingCandidateIdx],
      title: newCandidateTitle.trim(),
      description: newCandidateDesc.trim() || newCandidateTitle.trim(),
    };
    candidates = candidates;
    candidatesDirty = true;
    closeAddCandidate();
  }

  // Render pipeline/jev assignments into groups. `assignments` is a
  // candidate-key → tab-indices map (pipeline shape); candidates carry the
  // existingId mapping. Shared by the initial pipeline run and reruns.
  async function renderAssignments(
    assignments: Record<string, number[]>,
  ): Promise<void> {
    allRabbitholes = await chrome.runtime.sendMessage({
      type: MessageRequest.GET_ALL_RABBITHOLES,
    });

    newRabbitholeDefs = new Map();

    groups = [];

    for (const [key, indices] of Object.entries(assignments)) {
      const candidate = candidates.find((c) => c.key === key);
      if (!candidate) {
        continue;
      }
      if (candidate.existingId) {
        const rh = allRabbitholes.find((r) => r.id === candidate.existingId);
        // two candidates can point at the same rabbithole — merge their
        // tabs into one group instead of producing duplicate keyed rows
        const existing = groups.find((g) => g.id === candidate.existingId);
        if (existing) {
          existing.tabIndices.push(...indices);
        } else {
          groups.push({
            id: candidate.existingId,
            title: candidate.title || rh?.title || candidate.existingId,
            description: rh?.description ?? "",
            isNew: !rh,
            tabIndices: indices,
          });
        }
      } else {
        const id = `new-${candidate.key}`;
        newRabbitholeDefs.set(id, {
          title: candidate.title,
          description: candidate.description,
        });
        groups.push({
          id,
          title: candidate.title,
          description: candidate.description,
          isNew: true,
          tabIndices: [...indices],
        });
      }
    }

    rerunCount++;
    candidatesDirty = false;
    dispatch("results");
  }

  async function runAssignment(isInitialRun: boolean = false): Promise<void> {
    // Only show the full-screen loading state for the initial run;
    // reruns keep the results visible with an inline indicator
    if (isInitialRun) {
      loading = true;
    } else {
      rerunning = true;
    }
    error = null;
    logDebug(
      `[categorise] runAssignment start (initial=${isInitialRun}, tabs=${tabs.length}, candidates=${candidates.length})`,
    );

    try {
      const result = await chrome.runtime.sendMessage({
        type: MessageRequest.RUN_ASSIGNMENT,
        tabs,
        candidates,
      });
      logDebug("[categorise] runAssignment result:", result);

      if (result?.error) {
        error = result.error;
        return;
      }

      tabs = result.tabs ?? [];
      // RUN_ASSIGNMENT returns candidate-key → tab-indices (pipeline shape)
      await renderAssignments(result.assignments ?? {});

      rerunCount++;
      candidatesDirty = false;
      dispatch("results");
    } catch (e) {
      logWarn("[categorise] runAssignment failed:", e);
      error = e instanceof Error ? e.message : "Failed to assign tabs";
    } finally {
      loading = false;
      rerunning = false;
    }
  }

  function startMove(tabIdx: number): void {
    if (movingTabIdx === tabIdx) {
      movingTabIdx = null;
      searchQuery = "";
      return;
    }
    movingTabIdx = tabIdx;
    searchQuery = "";
    setTimeout(() => searchInput?.focus(), 0);
  }

  function closeFloatingPanels(): void {
    if (movingTabIdx !== null) {
      movingTabIdx = null;
      searchQuery = "";
    }
    if (showAddCandidate) {
      closeAddCandidate();
    }
  }

  function getMoveTargets(): { id: string; title: string; isNew: boolean }[] {
    const targets: { id: string; title: string; isNew: boolean }[] = [];

    for (const rh of allRabbitholes) {
      targets.push({ id: rh.id, title: rh.title, isNew: false });
    }

    // Every proposed candidate is a valid move target, even if no tabs
    // were assigned to it yet
    for (const c of candidates) {
      const id = candidateGroupId(c);
      if (!targets.find((t) => t.id === id)) {
        targets.push({ id, title: c.title, isNew: !c.existingId });
      }
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return targets.filter((t) => t.title.toLowerCase().includes(q));
    }

    return targets;
  }

  function moveTab(tabIdx: number, targetId: string): void {
    // Resolve the target before removing the tab so it can never be dropped
    let target = groups.find((g) => g.id === targetId);
    if (!target) {
      const rh = allRabbitholes.find((r) => r.id === targetId);
      if (rh) {
        target = {
          id: rh.id,
          title: rh.title,
          description: rh.description ?? "",
          isNew: false,
          tabIndices: [],
        };
        groups.push(target);
      } else {
        const nrDef = newRabbitholeDefs.get(targetId);
        if (nrDef) {
          target = {
            id: targetId,
            title: nrDef.title,
            description: nrDef.description,
            isNew: true,
            tabIndices: [],
          };
          groups.push(target);
        } else {
          // Candidate that received no tabs yet — materialise a group for it
          const cand = candidates.find((c) => candidateGroupId(c) === targetId);
          if (cand) {
            const def = {
              title: cand.title,
              description: cand.description,
            };
            newRabbitholeDefs.set(targetId, def);
            target = {
              id: targetId,
              title: def.title,
              description: def.description,
              isNew: true,
              tabIndices: [],
            };
            groups.push(target);
          }
        }
      }
    }

    for (const g of groups) {
      g.tabIndices = g.tabIndices.filter((i) => i !== tabIdx);
    }

    if (target) {
      target.tabIndices.push(tabIdx);
    }

    movingTabIdx = null;
    searchQuery = "";
    groups = groups.filter((g) => g.tabIndices.length > 0);
  }

  function moveTabToMisc(tabIdx: number): void {
    let target = groups.find((g) => g.isMisc);
    if (!target) {
      target = {
        id: MiscGroupId,
        title: "Don't Save",
        description: "",
        isNew: false,
        isMisc: true,
        tabIndices: [],
      };
      // pinned to the top — visually distinct from saved groups
      groups.unshift(target);
    }

    for (const g of groups) {
      g.tabIndices = g.tabIndices.filter((i) => i !== tabIdx);
    }
    target.tabIndices.push(tabIdx);

    movingTabIdx = null;
    searchQuery = "";
    groups = groups
      .filter((g) => g.tabIndices.length > 0)
      .sort((a, b) => (b.isMisc ? 1 : 0) - (a.isMisc ? 1 : 0));
  }

  async function applyChanges(): Promise<void> {
    applying = true;
    try {
      const assignments = groups
        .filter((g) => !g.isMisc && !g.isNew && g.tabIndices.length > 0)
        .map((g) => ({
          rabbitholeId: g.id,
          tabIndices: g.tabIndices,
        }));

      const newRabbitholes = groups
        .filter((g) => !g.isMisc && g.isNew && g.tabIndices.length > 0)
        .map((g) => ({
          topic: g.title,
          description: g.description,
          tabIndices: g.tabIndices,
        }));

      const result = await chrome.runtime.sendMessage({
        type: MessageRequest.APPLY_CATEGORISE,
        assignments,
        newRabbitholes,
        tabs,
      });

      if (result?.error) {
        error = String(result.error);
        return;
      }

      const savedGroups = groups.filter(
        (g) => !g.isMisc && g.tabIndices.length > 0,
      );
      savedTabCount = savedGroups.reduce(
        (sum, g) => sum + g.tabIndices.length,
        0,
      );
      savedGroupCount = savedGroups.length;

      // Pre-close the saved tabs so the success screen reflects reality
      const savedTabIds = savedGroups
        .flatMap((g) => g.tabIndices)
        .map((i) => tabs[i]?.tabId)
        .filter((id): id is number => id != null);
      if (savedTabIds.length > 0) {
        try {
          await chrome.tabs.remove(savedTabIds);
        } catch (e) {
          logWarn("Failed to close saved tabs", e);
        }
      }

      // gather misc tabs into their own window, kept open
      const miscTabIds =
        groups
          .find((g) => g.isMisc)
          ?.tabIndices.map((i) => tabs[i]?.tabId)
          .filter((id): id is number => id != null) ?? [];
      if (miscTabIds.length > 0) {
        try {
          const win = await chrome.windows.create({
            tabId: miscTabIds[0],
            focused: true,
          });
          if (win?.id != null && miscTabIds.length > 1) {
            await chrome.tabs.move(miscTabIds.slice(1), {
              windowId: win.id,
              index: -1,
            });
          }
        } catch (e) {
          logWarn("Failed to gather misc tabs into a window", e);
        }
      }

      showSuccess = true;
      dispatch("applied");
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to apply changes";
    } finally {
      applying = false;
    }
  }

  function undoCloseTabs(): void {
    // reopen tabs in their original windows — a flat chrome.tabs.create
    // would dump everything into one window
    const savedTabs = groups
      .filter((g) => !g.isMisc && g.tabIndices.length > 0)
      .flatMap((g) => g.tabIndices)
      .map((i) => tabs[i])
      .filter((t): t is TabInfo => !!t?.url);
    const byWindow = new Map<number, TabInfo[]>();
    const orphans: TabInfo[] = [];
    for (const t of savedTabs) {
      if (t.windowId != null) {
        const list = byWindow.get(t.windowId);
        if (list) {
          list.push(t);
        } else {
          byWindow.set(t.windowId, [t]);
        }
      } else {
        orphans.push(t);
      }
    }
    for (const groupTabs of byWindow.values()) {
      chrome.windows.create({ url: groupTabs[0].url }, (win) => {
        for (const t of groupTabs.slice(1)) {
          chrome.tabs.create({ windowId: win.id, url: t.url });
        }
      });
    }
    for (const t of orphans) {
      chrome.tabs.create({ url: t.url, active: false });
    }
    dispatch("done");
  }

  function finish(): void {
    dispatch("done");
  }

  function handleClose(): void {
    if (loading || applying) return;
    dispatch("close");
  }
</script>

<svelte:window on:click={closeFloatingPanels} />

{#if showSuccess}
  <div class="success">
    <p class="success-text">
      {savedTabCount}
      {savedTabCount === 1 ? "tab" : "tabs"} saved to
      {savedGroupCount === 1 ? "a" : savedGroupCount} rabbithole{savedGroupCount ===
      1
        ? ""
        : "s"}
      and closed.
    </p>
    {#if onboarding}
      <p class="success-subtext">
        This is your first Rabbithole trust fall! All your knowledge is saved
        but your tabs are finally gone. Doesn't that feel good? Don't worry,
        you'll see how easy it is to find them again in just a sec.
      </p>
    {/if}
    <div class="success-actions">
      <Button
        variant="subtle"
        color="gray"
        on:click={undoCloseTabs}
        title="They will still be saved to your rabbitholes"
      >
        I want my tabs back
      </Button>
      <Button variant="light" color="blue" on:click={finish}>Continue</Button>
    </div>
  </div>
{:else if needsSetup}
  <div class="setup">
    <p class="setup-desc">
      Connect an AI provider to categorise your tabs. Your key is stored locally
      and never sent anywhere except the provider's API.
    </p>
    <select bind:value={setupProvider} class="setup-input">
      <option value="">Select a provider...</option>
      {#each providerEntries as [id, p]}
        <option value={id}>{p.label}</option>
      {/each}
    </select>
    <input
      type="password"
      bind:value={setupApiKey}
      placeholder="API key"
      class="setup-input"
    />
    <input
      type="text"
      bind:value={setupModel}
      placeholder={modelPlaceholder()}
      class="setup-input"
    />
    <div class="setup-actions">
      <Button
        variant="light"
        color="blue"
        on:click={saveSetup}
        disabled={!setupProvider || !setupApiKey}
      >
        Connect & Categorise
      </Button>
      <Button variant="subtle" color="gray" on:click={handleClose}>
        Cancel
      </Button>
    </div>
  </div>
{:else if loading}
  <div class="loading">
    <div class="spinner"></div>
    <p>Analyzing your tabs...</p>
  </div>
{:else if error && groups.length === 0}
  <div class="error-view">
    <p class="error">{error}</p>
    <div class="error-actions">
      <Button
        variant="subtle"
        color="gray"
        on:click={() => {
          error = null;
          // If candidates already exist only the assignment failed —
          // skip the paid proposal call and retry the assignment directly
          if (candidates.length > 0) {
            runAssignment(true);
          } else {
            runProposal();
          }
        }}
      >
        Retry
      </Button>
      <Button variant="subtle" color="gray" on:click={handleClose}
        >Cancel</Button
      >
    </div>
  </div>
{:else}
  <div class="combined">
    {#if error}
      <p class="error inline-error">{error}</p>
    {/if}
    <p class="hint">
      We grouped your open tabs into rabbitholes. Move any tab with
      <ArrowRight size={11} class="hint-icon" />, add or remove rabbitholes on
      the left to tell us what we missed, then <strong>Rerun</strong> to re-assign
      with your changes. Confirm when it looks right.
    </p>
    <div class="combined-main">
      <div class="candidate-sidebar">
        <p class="sidebar-title">Rabbitholes</p>
        <p class="sidebar-subtitle">Automatically generated from your tabs</p>
        <div class="candidate-list">
          {#each candidates as c, i (c.key)}
            {@const count =
              groups.find((g) => g.id === candidateGroupId(c))?.tabIndices
                .length ?? 0}
            <div class="candidate-row" class:empty={count === 0}>
              {#if !c.existingId}
                <span class="candidate-new-badge">new</span>
              {/if}
              <div class="candidate-info">
                <span class="candidate-title">{c.title}</span>
                <span class="candidate-desc">{c.description}</span>
              </div>
              <button
                class="remove-btn"
                on:click|stopPropagation={() => startEditCandidate(i)}
                title="Edit"
              >
                <Pencil1 size={14} />
              </button>
              <button
                class="remove-btn"
                on:click={() => removeCandidate(i)}
                title="Remove"
              >
                <Cross1 size={14} />
              </button>
            </div>
          {/each}
        </div>
        <div class="add-candidate">
          {#if showAddCandidate}
            <div class="add-panel" on:click|stopPropagation>
              <input
                type="text"
                bind:value={newCandidateTitle}
                placeholder="Title"
                class="add-input"
              />
              <textarea
                bind:value={newCandidateDesc}
                placeholder="What belongs here (optional)"
                class="add-desc"
                rows="2"
              ></textarea>
              <div class="add-panel-actions">
                <Button
                  variant="subtle"
                  color="gray"
                  on:click={closeAddCandidate}
                >
                  Cancel
                </Button>
                {#if editingCandidateIdx !== null}
                  <Button
                    variant="light"
                    color="blue"
                    on:click={saveCandidateEdit}
                    disabled={!newCandidateTitle.trim()}
                  >
                    Save
                  </Button>
                {:else}
                  <Button
                    variant="light"
                    color="blue"
                    on:click={addCandidate}
                    disabled={!newCandidateTitle.trim()}
                  >
                    Add
                  </Button>
                {/if}
              </div>
            </div>
          {/if}
          <button
            class="add-rabbithole-btn"
            on:click|stopPropagation={() => {
              editingCandidateIdx = null;
              newCandidateTitle = "";
              newCandidateDesc = "";
              showAddCandidate = true;
            }}
          >
            <Plus size={14} /> Add another rabbithole
          </button>
        </div>
      </div>
      <div class="editor">
        <div class="editor-scroll" class:rerunning>
          {#each groups as group (group.id)}
            <div class="group-section" class:misc={group.isMisc}>
              <div class="group-header">
                <span class="group-title">{group.title}</span>
                <span class="group-count">{group.tabIndices.length} tabs</span>
              </div>
              {#if group.isNew && group.description}
                <p class="group-desc">{group.description}</p>
              {/if}
              <div class="tab-list">
                {#each group.tabIndices as tabIdx (tabIdx)}
                  <div class="tab-row">
                    {#if tabs[tabIdx]?.favIconUrl}
                      <img
                        class="tab-favicon"
                        src={tabs[tabIdx].favIconUrl}
                        alt=""
                        loading="lazy"
                      />
                    {:else}
                      <span class="tab-favicon fallback"
                        >{getDomain(tabs[tabIdx]?.url ?? "")
                          .charAt(0)
                          .toUpperCase() || "?"}</span
                      >
                    {/if}
                    <div class="tab-info">
                      <span class="tab-title"
                        >{tabs[tabIdx]?.title || "Untitled"}</span
                      >
                      <span class="tab-domain"
                        >{getDomain(tabs[tabIdx]?.url ?? "")}</span
                      >
                    </div>
                    <button
                      class="move-btn"
                      class:active={movingTabIdx === tabIdx}
                      on:click|stopPropagation={() => startMove(tabIdx)}
                      data-label="Move to another rabbithole"
                    >
                      <ArrowRight size={14} />
                    </button>
                    {#if !group.isMisc}
                      <button
                        class="misc-btn"
                        on:click|stopPropagation={() => moveTabToMisc(tabIdx)}
                        data-label="Don't save — kept open in a separate window"
                      >
                        <Cross1 size={14} />
                      </button>
                    {/if}
                    {#if movingTabIdx === tabIdx}
                      <div class="move-panel" on:click|stopPropagation>
                        <input
                          bind:this={searchInput}
                          bind:value={searchQuery}
                          placeholder="Search rabbitholes..."
                          class="search-input"
                        />
                        <div class="search-results">
                          {#each getMoveTargets() as target (target.id)}
                            <button
                              class="search-result-item"
                              on:click={() => moveTab(tabIdx, target.id)}
                            >
                              <span>{target.title}</span>
                              {#if target.isNew}
                                <span class="badge new-badge">new</span>
                              {/if}
                            </button>
                          {:else}
                            <div class="no-results">
                              No matching rabbitholes
                            </div>
                          {/each}
                        </div>
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>

    {#if error}
      <p class="error inline-error">{error}</p>
    {/if}

    <div class="action-bar">
      {#if candidatesDirty}
        <Button
          variant="default"
          color="gray"
          on:click={() => runAssignment()}
          disabled={rerunning}
        >
          {#if rerunning}
            Rerunning...
          {:else}
            Rerun
          {/if}
        </Button>
      {:else}
        <span></span>
      {/if}
      <Button
        variant="light"
        color="blue"
        on:click={applyChanges}
        disabled={applying || rerunning}
      >
        {applying ? "Applying..." : "Confirm Changes"}
      </Button>
    </div>
  </div>
{/if}

<style>
  .success {
    display: flex;
    flex-direction: column;
    gap: 16px;
    align-items: center;
    padding: 20px 0;
  }

  .success-text {
    font-size: 15px;
    text-align: center;
    margin: 0;
    line-height: 1.5;
  }

  .success-subtext {
    font-size: 13px;
    color: #868e96;
    text-align: center;
    margin: 0;
    line-height: 1.5;
  }

  :global(body.dark-mode) .success-subtext {
    color: #909296;
  }

  .success-actions {
    display: flex;
    gap: 8px;
  }

  .hint {
    font-size: 13px;
    line-height: 1.6;
    color: #868e96;
    margin: 0 auto 12px;
    max-width: 640px;
    text-align: center;
  }

  .hint strong {
    color: #495057;
  }

  .hint-icon {
    display: inline-flex;
    vertical-align: -2px;
  }

  .setup {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .setup-desc {
    font-size: 13px;
    color: #868e96;
    margin: 0 0 4px;
    line-height: 1.5;
  }

  .setup-input {
    padding: 8px 12px;
    border: 1px solid rgba(0, 0, 0, 0.12);
    border-radius: 8px;
    font-size: 14px;
    outline: none;
    background: transparent;
    color: #1a1b1e;
    font-family: inherit;
  }

  .setup-input:focus {
    border-color: #1185fe;
  }

  .setup-actions {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }

  .loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 0;
    gap: 16px;
  }

  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid rgba(0, 0, 0, 0.1);
    border-top-color: #1185fe;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .loading p {
    color: #868e96;
    font-size: 14px;
  }

  .error-view {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 48px 24px;
    text-align: center;
  }

  .error {
    color: #e03131;
    font-size: 14px;
    margin: 0 0 16px;
  }

  .error-actions {
    display: flex;
    gap: 8px;
  }

  .combined {
    display: flex;
    flex-direction: column;
    gap: 16px;
    width: 100%;
  }

  .combined-main {
    display: flex;
    gap: 20px;
    align-items: stretch;
  }

  @media (max-width: 760px) {
    .combined-main {
      flex-direction: column;
    }

    .candidate-sidebar {
      width: 100% !important;
      height: auto !important;
    }
  }

  .combined .editor {
    flex: 1;
    min-width: 0;
  }

  .inline-error {
    width: 100%;
    margin: 0;
  }

  .candidate-sidebar {
    flex-shrink: 0;
    width: 260px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    height: 55vh;
  }

  .sidebar-title {
    font-size: 12px;
    font-weight: 700;
    color: #1a1b1e;
    margin: 0;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .sidebar-subtitle {
    font-size: 11px;
    color: #868e96;
    margin: -6px 0 0;
  }

  .candidate-row.empty {
    opacity: 0.55;
  }

  .tab-favicon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    border-radius: 3px;
  }

  .tab-favicon.fallback {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 700;
    background: rgba(17, 133, 254, 0.12);
    color: #1185fe;
  }

  .editor-scroll.rerunning {
    opacity: 0.5;
    pointer-events: none;
    transition: opacity 0.2s ease;
  }

  .candidate-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
    min-height: 0;
    height: 100%;
    overflow-y: auto;
    padding-right: 4px;
  }

  .candidate-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.03);
  }

  .candidate-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .candidate-title {
    font-size: 13px;
    font-weight: 600;
    color: #1a1b1e;
  }

  .candidate-new-badge {
    position: absolute;
    top: 6px;
    right: 8px;
    font-size: 9px;
    font-weight: 600;
    line-height: 1;
    padding: 3px 6px;
    border: 1px solid #4dabf7;
    border-radius: 4px;
    color: #4dabf7;
    background: transparent;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    pointer-events: none;
  }

  .candidate-desc {
    font-size: 11px;
    color: #868e96;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .remove-btn {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: #868e96;
    cursor: pointer;
    transition:
      background 0.15s ease,
      color 0.15s ease;
  }

  .remove-btn:hover {
    background: rgba(224, 49, 49, 0.1);
    color: #e03131;
  }

  .add-candidate {
    position: relative;
  }

  .add-rabbithole-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
    padding: 8px 12px;
    font-size: 13px;
    font-weight: 500;
    color: #495057;
    background: transparent;
    border: 1px dashed rgba(0, 0, 0, 0.2);
    border-radius: 8px;
    cursor: pointer;
    transition:
      border-color 0.15s ease,
      color 0.15s ease,
      background 0.15s ease;
  }

  .add-rabbithole-btn:hover {
    border-color: #1185fe;
    color: #1185fe;
    background: rgba(17, 133, 254, 0.04);
  }

  .add-panel {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 0;
    right: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    background: #ffffff;
    border: 1px solid rgba(0, 0, 0, 0.12);
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
    z-index: 20;
  }

  .add-desc {
    padding: 8px 12px;
    font-size: 13px;
    font-family: inherit;
    border: 1px solid rgba(0, 0, 0, 0.12);
    border-radius: 6px;
    resize: none;
  }

  .add-desc:focus {
    outline: none;
    border-color: #1185fe;
  }

  .add-panel-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }

  .add-input {
    flex: 1;
    padding: 8px 12px;
    border: 1px solid rgba(0, 0, 0, 0.12);
    border-radius: 8px;
    font-size: 13px;
    outline: none;
    background: transparent;
    color: #1a1b1e;
    font-family: inherit;
  }

  .add-input:focus {
    border-color: #1185fe;
  }

  .editor {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .editor-scroll {
    display: flex;
    flex-direction: column;
    gap: 16px;
    overflow-y: auto;
    max-height: 55vh;
    padding-right: 4px;
  }

  .group-section {
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 10px;
    padding: 14px;
  }

  .group-section.misc {
    border: 1px dashed rgba(250, 82, 82, 0.5);
  }

  .group-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  .group-title {
    font-weight: 700;
    font-size: 14px;
    color: #1a1b1e;
  }

  .group-count {
    font-size: 12px;
    color: #868e96;
    margin-left: auto;
  }

  .group-desc {
    font-size: 12px;
    color: #868e96;
    margin: 0 0 10px;
    line-height: 1.4;
  }

  .badge {
    font-size: 9px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .new-badge {
    color: #2b8a3e;
    background: rgba(43, 138, 62, 0.12);
  }

  .tab-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .tab-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.03);
    transition: background 0.15s ease;
  }

  .tab-row:hover {
    background: rgba(0, 0, 0, 0.06);
  }

  .tab-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .tab-title {
    font-size: 13px;
    font-weight: 600;
    color: #1a1b1e;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tab-domain {
    font-size: 11px;
    color: #868e96;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .move-btn {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: #868e96;
    cursor: pointer;
    transition:
      background 0.15s ease,
      color 0.15s ease;
  }

  .move-btn:hover {
    background: rgba(17, 133, 254, 0.1);
    color: #1185fe;
  }

  .move-btn.active {
    background: rgba(17, 133, 254, 0.15);
    color: #1185fe;
  }

  .misc-btn {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: #868e96;
    cursor: pointer;
    transition:
      background 0.15s ease,
      color 0.15s ease;
  }

  .misc-btn:hover {
    background: rgba(250, 82, 82, 0.1);
    color: #fa5252;
  }

  .move-btn,
  .misc-btn {
    position: relative;
  }

  .move-btn::after,
  .misc-btn::after {
    content: attr(data-label);
    position: absolute;
    bottom: calc(100% + 6px);
    right: 0;
    padding: 4px 8px;
    border-radius: 6px;
    background: #25262b;
    border: 1px solid #373a40;
    color: #c1c2c5;
    font-size: 11px;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s ease;
    z-index: 20;
  }

  .move-btn:hover::after,
  .misc-btn:hover::after {
    opacity: 1;
  }

  .move-panel {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    z-index: 10;
    width: 240px;
    background: white;
    border: 1px solid rgba(0, 0, 0, 0.12);
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
    overflow: hidden;
  }

  .search-input {
    width: 100%;
    padding: 10px 12px;
    border: none;
    border-bottom: 1px solid rgba(0, 0, 0, 0.08);
    font-size: 13px;
    outline: none;
    background: transparent;
    color: #1a1b1e;
  }

  .search-results {
    max-height: 200px;
    overflow-y: auto;
  }

  .search-result-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    border: none;
    background: transparent;
    text-align: left;
    cursor: pointer;
    font-size: 13px;
    color: #1a1b1e;
    transition: background 0.1s ease;
  }

  .search-result-item:hover {
    background: rgba(17, 133, 254, 0.08);
  }

  .no-results {
    padding: 12px;
    font-size: 13px;
    color: #868e96;
    text-align: center;
  }

  .action-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-top: 1px solid rgba(0, 0, 0, 0.08);
    padding-top: 12px;
  }

  /* Dark mode */
  :global(body.dark-mode) .group-section {
    border-color: rgba(255, 255, 255, 0.08);
  }

  :global(body.dark-mode) .group-title {
    color: #e7e7e7;
  }

  :global(body.dark-mode) .group-desc {
    color: #909296;
  }

  :global(body.dark-mode) .new-badge {
    color: #69db7c;
    background: rgba(105, 219, 124, 0.15);
  }

  :global(body.dark-mode) .tab-row {
    background: rgba(255, 255, 255, 0.04);
  }

  :global(body.dark-mode) .tab-row:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  :global(body.dark-mode) .tab-title {
    color: #e7e7e7;
  }

  :global(body.dark-mode) .tab-domain {
    color: #909296;
  }

  :global(body.dark-mode) .move-btn {
    color: #909296;
  }

  :global(body.dark-mode) .move-btn:hover {
    background: rgba(77, 171, 247, 0.15);
    color: #4dabf7;
  }

  :global(body.dark-mode) .move-btn.active {
    background: rgba(77, 171, 247, 0.2);
    color: #4dabf7;
  }

  :global(body.dark-mode) .move-panel {
    background: #25262b;
    border-color: rgba(255, 255, 255, 0.12);
  }

  :global(body.dark-mode) .search-input {
    border-bottom-color: rgba(255, 255, 255, 0.08);
    color: #e7e7e7;
  }

  :global(body.dark-mode) .search-result-item {
    color: #e7e7e7;
  }

  :global(body.dark-mode) .search-result-item:hover {
    background: rgba(77, 171, 247, 0.12);
  }

  :global(body.dark-mode) .no-results {
    color: #909296;
  }

  :global(body.dark-mode) .error {
    color: #ff6b6b;
  }

  :global(body.dark-mode) .setup-desc {
    color: #909296;
  }

  :global(body.dark-mode) .hint {
    color: #909296;
  }

  :global(body.dark-mode) .setup-input {
    border-color: rgba(255, 255, 255, 0.12);
    color: #e7e7e7;
  }

  :global(body.dark-mode) .setup-input:focus {
    border-color: #4dabf7;
  }

  :global(body.dark-mode) .candidate-row {
    background: rgba(255, 255, 255, 0.04);
  }

  :global(body.dark-mode) .candidate-title {
    color: #e7e7e7;
  }

  :global(body.dark-mode) .candidate-desc {
    color: #909296;
  }

  :global(body.dark-mode) .remove-btn:hover {
    background: rgba(255, 107, 107, 0.15);
    color: #ff6b6b;
  }

  :global(body.dark-mode) .add-rabbithole-btn {
    color: #c1c2c5;
    border-color: rgba(255, 255, 255, 0.2);
  }

  :global(body.dark-mode) .add-rabbithole-btn:hover {
    border-color: #4dabf7;
    color: #4dabf7;
    background: rgba(77, 171, 247, 0.08);
  }

  :global(body.dark-mode) .add-panel {
    background: #1f1f23;
    border-color: rgba(255, 255, 255, 0.12);
  }

  :global(body.dark-mode) .add-desc {
    background: transparent;
    border-color: rgba(255, 255, 255, 0.12);
    color: #e7e7e7;
  }

  :global(body.dark-mode) .add-input {
    border-color: rgba(255, 255, 255, 0.12);
    color: #e7e7e7;
  }

  :global(body.dark-mode) .add-input:focus {
    border-color: #4dabf7;
  }

  :global(body.dark-mode) .sidebar-title {
    color: #c1c2c5;
  }

  :global(body.dark-mode) .action-bar {
    border-top-color: rgba(255, 255, 255, 0.08);
  }

  :global(body.dark-mode) .sidebar-subtitle {
    color: #909296;
  }

  :global(body.dark-mode) .hint strong {
    color: #c1c2c5;
  }

  :global(body.dark-mode) .tab-favicon.fallback {
    background: rgba(77, 171, 247, 0.18);
    color: #4dabf7;
  }
</style>
