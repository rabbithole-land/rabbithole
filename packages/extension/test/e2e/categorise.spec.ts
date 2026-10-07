import { test, expect } from "./fixtures";
import { MessageRequest } from "../../src/utils/types";
import type { TestHarness } from "./fixtures";

// real LLM (joint GPT-5.4 via OpenRouter) by default; flip to false for
// deterministic route-mocked runs
const UseRealLlm = true;

async function mockJoint(bg: TestHarness, groups: unknown[]): Promise<void> {
  await bg.context.route("**/api/v1/chat/completions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ groups }),
            },
          },
        ],
      }),
    });
  });
}

async function mockDecisions(
  bg: TestHarness,
  answers: Record<string, unknown>,
): Promise<void> {
  await bg.context.route("**/api/alpha/decisions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ answers }),
    });
  });
}

async function openTabs(bg: TestHarness, urls: string[]): Promise<void> {
  for (const url of urls) {
    const p = await bg.context.newPage();
    await p.goto(url);
  }
}

async function runCategorise(
  bg: TestHarness,
): Promise<import("@playwright/test").Page> {
  const newtab = await bg.openNewtab();
  const btn = newtab.locator("button", { hasText: /clean up/i }).first();
  await btn.waitFor({ timeout: 10000 });
  await btn.click();
  return newtab;
}

async function setupLlm(bg: TestHarness): Promise<void> {
  if (UseRealLlm) {
    test.setTimeout(120000);
    await bg.skipOnboarding();
    await bg.seedCloudKey(process.env.OPENROUTER_API_KEY);
    return;
  }
  await bg.skipOnboarding();
  await bg.seedCloudKey();
}

test("categorise shows candidates and groups", async ({ bg }) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (UseRealLlm) {
    test.skip(!apiKey, "OPENROUTER_API_KEY not set");
  }
  await setupLlm(bg);

  if (UseRealLlm) {
    await openTabs(bg, [
      "https://en.wikipedia.org/wiki/Otter",
      "https://en.wikipedia.org/wiki/Sea_otter",
    ]);
  } else {
    await mockJoint(bg, [{ title: "Test", description: "test", tabs: [0, 1] }]);
    await openTabs(bg, [
      "https://example.com/alpha",
      "https://example.com/beta",
    ]);
  }

  const newtab = await runCategorise(bg);

  if (UseRealLlm) {
    await expect(newtab.locator(".candidate-list")).toBeVisible({
      timeout: 60000,
    });
    await expect(newtab.locator(".group-section").first()).toBeVisible({
      timeout: 60000,
    });
  } else {
    await expect(newtab.locator(".candidate-list")).toContainText("Test", {
      timeout: 10000,
    });
    await expect(newtab.locator(".group-section")).toHaveCount(1, {
      timeout: 10000,
    });
  }
});

// a single valid web tab produces a singleton assignment — the modal must
// still show the group (regression: singleton dissolve silently emptied it).
// always mocked: this guards UI rendering, so the LLM is irrelevant and
// real-mode assertions would be too weak to catch the regression
test("categorise with a single tab still shows its group", async ({ bg }) => {
  await bg.skipOnboarding();
  await bg.seedCloudKey();

  await mockJoint(bg, [{ title: "Test", description: "test", tabs: [0] }]);
  await openTabs(bg, ["https://example.com/alpha"]);

  const newtab = await runCategorise(bg);

  await expect(newtab.locator(".candidate-list")).toContainText("Test", {
    timeout: 10000,
  });
  await expect(newtab.locator(".group-section")).toHaveCount(1, {
    timeout: 10000,
  });
});

// apply path is LLM-independent — mocked only
test("categorise confirm applies changes", async ({ bg }) => {
  await bg.skipOnboarding();
  await bg.seedCloudKey();

  await mockJoint(bg, [{ title: "Test", description: "test", tabs: [0, 1] }]);
  await openTabs(bg, ["https://example.com/alpha", "https://example.com/beta"]);

  const newtab = await runCategorise(bg);

  await expect(newtab.locator(".candidate-list")).toContainText("Test", {
    timeout: 10000,
  });

  const confirmBtn = newtab.locator("button", { hasText: /confirm/i }).first();
  await confirmBtn.click();

  await expect(newtab.locator(".success")).toBeVisible({ timeout: 10000 });
  await expect(newtab.locator(".success")).toContainText(/saved|done/i);
});

// quality check: real pipeline should split otters from rabbits
test("categorise with real LLM (joint GPT-5.4)", async ({ bg }) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  test.skip(!apiKey, "OPENROUTER_API_KEY not set");
  test.setTimeout(120000);

  await bg.skipOnboarding();
  await bg.seedCloudKey(apiKey);

  for (const article of [
    "Otter",
    "Sea_otter",
    "Giant_otter",
    "Rabbit",
    "European_rabbit",
    "Cottontail_rabbit",
  ]) {
    const p = await bg.context.newPage();
    await p.goto(`https://en.wikipedia.org/wiki/${article}`);
  }

  const newtab = await runCategorise(bg);

  await expect(newtab.locator(".candidate-list")).toBeVisible({
    timeout: 60000,
  });
  await expect(newtab.locator(".candidate-list")).toContainText(/otter/i, {
    timeout: 60000,
  });
  await expect(newtab.locator(".candidate-list")).toContainText(/rabbit/i, {
    timeout: 60000,
  });
});

// X button moves a tab to misc — misc tabs stay open in their own window
// after confirm, saved tabs get closed
test("categorise misc tabs stay open after confirm", async ({ bg }) => {
  await bg.skipOnboarding();
  await bg.seedCloudKey();

  await mockJoint(bg, [{ title: "Test", description: "test", tabs: [0, 1] }]);
  await openTabs(bg, ["https://example.com/alpha", "https://example.com/beta"]);

  const newtab = await runCategorise(bg);

  await expect(newtab.locator(".candidate-list")).toContainText("Test", {
    timeout: 10000,
  });

  // X the first tab row into misc
  await newtab.locator(".tab-row .misc-btn").first().click();
  await expect(newtab.locator(".group-section")).toHaveCount(2, {
    timeout: 10000,
  });
  await expect(newtab.locator(".group-section").first()).toContainText(
    "Don't Save",
  );

  const confirmBtn = newtab.locator("button", { hasText: /confirm/i }).first();
  await confirmBtn.click();
  await expect(newtab.locator(".success")).toBeVisible({ timeout: 10000 });

  // misc tab gathered into a separate window and still open; saved tab closed
  const pages = bg.context.pages();
  const remaining = pages
    .map((p) => p.url())
    .filter((u) => u.startsWith("https://example.com"));
  expect(remaining).toEqual(["https://example.com/alpha"]);
});

// saveWebsiteStubs must not overwrite existing records
test("categorise does not degrade existing website metadata", async ({
  bg,
}) => {
  await bg.skipOnboarding();
  await bg.seedCloudKey();

  // Seed an existing website with rich metadata
  await bg.sendMessage({
    type: MessageRequest.IMPORT_DATA,
    rabbitholes: [],
    burrows: [],
    websites: [
      {
        url: "https://example.com/alpha",
        name: "Alpha Site",
        description: "A rich description",
        faviconUrl: "https://example.com/favicon.png",
        savedAt: Date.now(),
      },
    ],
  });

  await mockJoint(bg, [{ title: "Test", description: "test", tabs: [0] }]);
  await openTabs(bg, ["https://example.com/alpha"]);

  const newtab = await runCategorise(bg);
  await expect(newtab.locator(".candidate-list")).toContainText("Test", {
    timeout: 10000,
  });

  const confirmBtn = newtab.locator("button", { hasText: /confirm/i }).first();
  await confirmBtn.click();
  await expect(newtab.locator(".success")).toBeVisible({ timeout: 10000 });

  // Verify the existing website metadata was NOT overwritten
  const all = (await bg.sendMessage({
    type: MessageRequest.GET_ALL_ITEMS,
  })) as {
    url: string;
    name: string;
    description: string;
    faviconUrl: string;
  }[];
  const ws = all.find((w) => w.url === "https://example.com/alpha");
  expect(ws?.name).toBe("Alpha Site");
  expect(ws?.description).toBe("A rich description");
  expect(ws?.faviconUrl).toBe("https://example.com/favicon.png");
});

// applyChanges must not close tabs when save fails.
// Delete the target rabbithole between proposal and confirm so the apply
// handler rejects ("Rabbithole not found") — the tab must stay open and
// the error must surface instead of the success screen.
test("categorise keeps tabs open on apply error", async ({ bg }) => {
  await bg.skipOnboarding();
  await bg.seedCloudKey();

  const rh = (await bg.sendMessage({
    type: MessageRequest.CREATE_NEW_RABBITHOLE,
    title: "Doomed RH",
    description: "test",
  })) as { id: string };

  await mockJoint(bg, [
    { title: "Test", description: "test", existingId: rh.id, tabs: [0] },
  ]);
  await openTabs(bg, ["https://example.com/alpha"]);

  const newtab = await runCategorise(bg);
  await expect(newtab.locator(".candidate-list")).toContainText("Test", {
    timeout: 10000,
  });

  // Kill the target out from under the pending apply
  await bg.sendMessage({
    type: MessageRequest.DELETE_RABBITHOLE,
    rabbitholeId: rh.id,
  });

  const confirmBtn = newtab.locator("button", { hasText: /confirm/i }).first();
  await confirmBtn.click();

  // Error must surface, not the success screen
  await expect(newtab.locator(".error").first()).toBeVisible({
    timeout: 10000,
  });

  // Tab must still be open
  const pages = bg.context.pages();
  const remaining = pages
    .map((p) => p.url())
    .filter((u) => u.startsWith("https://example.com"));
  expect(remaining).toContain("https://example.com/alpha");
});

// rerun must work after candidate edits (regression: stale response shape threw)
test("categorise rerun works after editing candidates", async ({ bg }) => {
  await bg.skipOnboarding();
  await bg.seedCloudKey();

  await mockJoint(bg, [{ title: "Test", description: "test", tabs: [0] }]);
  await mockDecisions(bg, { tab_0: { choice: "g1" } });
  await openTabs(bg, ["https://example.com/alpha"]);

  const newtab = await runCategorise(bg);
  await expect(newtab.locator(".candidate-list")).toContainText("Test", {
    timeout: 10000,
  });

  // Edit a candidate to mark dirty
  await newtab.locator(".candidate-row button[title='Edit']").first().click();
  const titleInput = newtab.locator(".add-panel input[placeholder='Title']");
  await titleInput.fill("Edited");
  await newtab.locator(".add-panel button", { hasText: "Save" }).click();

  // Rerun button should appear
  const rerunBtn = newtab.locator("button", { hasText: /rerun/i });
  await expect(rerunBtn).toBeVisible({ timeout: 5000 });

  // Click rerun — should NOT throw
  await rerunBtn.click();
  await expect(newtab.locator(".error")).not.toBeVisible({ timeout: 10000 });
});

// duplicate existingId must merge into one group, not duplicate keyed rows
test("categorise handles duplicate existingId without crashing", async ({
  bg,
}) => {
  await bg.skipOnboarding();
  await bg.seedCloudKey();

  // Create a real rabbithole for the candidates to reference
  const rh = (await bg.sendMessage({
    type: MessageRequest.CREATE_NEW_RABBITHOLE,
    title: "Existing RH",
    description: "test",
  })) as { id: string; title: string };

  await mockJoint(bg, [
    { title: "Alpha", description: "a", existingId: rh.id, tabs: [0] },
    { title: "Beta", description: "b", existingId: rh.id, tabs: [1] },
  ]);
  await openTabs(bg, ["https://example.com/alpha", "https://example.com/beta"]);

  const newtab = await runCategorise(bg);
  // Modal must render without throwing "duplicate key"; both candidates
  // map to the same rabbithole so their tabs merge into one group
  await expect(newtab.locator(".candidate-list")).toBeVisible({
    timeout: 10000,
  });
  await expect(newtab.locator(".group-section")).toHaveCount(1, {
    timeout: 10000,
  });
  // both tabs merged into the one group
  await expect(newtab.locator(".group-section").first()).toContainText(
    "2 tabs",
  );
});

// the API key must never land in the persistent log buffer
test("categorise does not log the API key", async ({ bg }) => {
  await bg.skipOnboarding();
  await bg.seedCloudKey("sk-test-secret-key-123");

  await mockJoint(bg, [{ title: "Test", description: "test", tabs: [0] }]);
  await openTabs(bg, ["https://example.com/alpha"]);

  const newtab = await runCategorise(bg);
  await expect(newtab.locator(".candidate-list")).toContainText("Test", {
    timeout: 10000,
  });

  const logs = await bg.msgPage.evaluate(async () => {
    const result = await chrome.storage.local.get("rabbithole_logs");
    const v = result["rabbithole_logs"] as { message: string; data: unknown }[];
    return JSON.stringify(v ?? []);
  });
  expect(logs).not.toContain("sk-test-secret-key-123");
});

// only OpenRouter is offered — the Jev stage only exists
// there, so other providers would silently misroute tab data
test("categorise setup only offers OpenRouter", async ({ bg }) => {
  await bg.skipOnboarding();
  // no cloud key seeded — setup screen must show
  await bg.msgPage.evaluate(() => {
    chrome.storage.local.remove(["cloudProvider", "cloudApiKey"]);
  });

  const newtab = await bg.openNewtab();
  const btn = newtab.locator("button", { hasText: /clean up/i }).first();
  await btn.waitFor({ timeout: 10000 });
  await btn.click();

  const options = newtab.locator(".setup select option");
  await expect(options).toHaveCount(2, { timeout: 10000 });
  await expect(options.nth(1)).toHaveText("OpenRouter");
});

// categorised tabs must land with real metadata (title, favicon), not
// bare URL stubs — same as a normal save
test("categorise saves tabs with real metadata", async ({ bg }) => {
  await bg.skipOnboarding();
  await bg.seedCloudKey();

  await mockJoint(bg, [{ title: "Test", description: "test", tabs: [0] }]);
  await openTabs(bg, ["https://example.com/alpha"]);

  const newtab = await runCategorise(bg);
  await expect(newtab.locator(".candidate-list")).toContainText("Test", {
    timeout: 10000,
  });
  await newtab
    .locator("button", { hasText: /confirm/i })
    .first()
    .click();
  await expect(newtab.locator(".success")).toBeVisible({ timeout: 10000 });

  const all = (await bg.sendMessage({
    type: MessageRequest.GET_ALL_ITEMS,
  })) as { url: string; name: string; faviconUrl?: string }[];
  const ws = all.find((w) => w.url === "https://example.com/alpha");
  // real page title, not the bare-URL stub (example.com has no favicon,
  // so faviconUrl is not asserted)
  expect(ws?.name).toBe("Example Domain");
});
