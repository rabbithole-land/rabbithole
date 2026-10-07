import { test, expect } from "./fixtures";
import {
  mockJoint,
  openTabs,
  runCategorise,
  saveOpenTab,
  seedRabbithole,
} from "./categorise-helpers";

// Features: collapse rabbitholes, rename a proposed rabbithole without
// rerun, "add another" with a selector for existing rabbitholes, canonical
// rabbithole descriptions, and marking already-saved tabs.

test("groups can be collapsed and expanded", async ({ bg }) => {
  await bg.skipOnboarding();
  await bg.seedCloudKey();
  await mockJoint(bg, [{ title: "Test", description: "test", tabs: [0, 1] }]);
  await openTabs(bg, ["https://example.com/alpha", "https://example.com/beta"]);

  const newtab = await runCategorise(bg);
  const section = newtab.locator(".group-section").first();
  await expect(section.locator(".tab-row")).toHaveCount(2, { timeout: 10000 });

  await section.locator(".group-header").click();
  await expect(section.locator(".tab-row")).toHaveCount(0);

  await section.locator(".group-header").click();
  await expect(section.locator(".tab-row")).toHaveCount(2);
});

test("a proposed rabbithole can be renamed without rerunning", async ({
  bg,
}) => {
  await bg.skipOnboarding();
  await bg.seedCloudKey();
  await mockJoint(bg, [{ title: "Test", description: "test", tabs: [0, 1] }]);
  await openTabs(bg, ["https://example.com/alpha", "https://example.com/beta"]);

  const newtab = await runCategorise(bg);
  const section = newtab.locator(".group-section").first();
  await expect(section).toContainText("Test", { timeout: 10000 });

  // rename inline via the group title
  await section.locator(".group-title").click();
  await section.locator(".rename-input").fill("Renamed group");
  await section.locator(".rename-input").press("Enter");

  // title updates in place, tabs stay put, no rerun happens
  await expect(section.locator(".group-title")).toContainText("Renamed group");
  await expect(section).toContainText("2 tabs");
  await expect(newtab.locator("button", { hasText: /rerunning/i })).toHaveCount(
    0,
  );
});

test("add another offers picking an existing rabbithole", async ({ bg }) => {
  await bg.skipOnboarding();
  await bg.seedCloudKey();
  await seedRabbithole(bg, "Otters");
  await mockJoint(bg, [{ title: "Test", description: "test", tabs: [0] }]);
  await openTabs(bg, ["https://example.com/alpha"]);

  const newtab = await runCategorise(bg);
  await expect(newtab.locator(".candidate-list")).toContainText("Test", {
    timeout: 10000,
  });

  await newtab.locator(".add-rabbithole-btn").click();
  const panel = newtab.locator(".add-panel");
  // the panel offers existing rabbitholes, not just a blank new-candidate form
  await expect(
    panel.locator(".existing-rabbithole-option", { hasText: "Otters" }),
  ).toBeVisible();

  // picking it adds a group bound to that rabbithole
  await panel
    .locator(".existing-rabbithole-option", { hasText: "Otters" })
    .click();
  await expect(newtab.locator(".candidate-list")).toContainText("Otters");
});

test("an existing rabbithole's own description is canonical", async ({
  bg,
}) => {
  // Interpretation: when a proposed group maps to an existing rabbithole, the
  // group shows/uses the rabbithole's stored description — not whatever the
  // model generated for the candidate.
  await bg.skipOnboarding();
  await bg.seedCloudKey();
  const rhId = await seedRabbithole(
    bg,
    "Otters",
    "semi-aquatic mammals of the North Pacific",
  );
  await mockJoint(bg, [
    {
      title: "Otter stuff",
      description: "model made this up",
      existingId: rhId,
      tabs: [0, 1],
    },
  ]);
  await openTabs(bg, ["https://example.com/alpha", "https://example.com/beta"]);

  const newtab = await runCategorise(bg);
  const section = newtab.locator(".group-section").first();
  await expect(section).toContainText("Otter", { timeout: 10000 });
  // (whether the title should also be canonical is an open question — this
  // test only pins the description)
  await expect(section.locator(".group-desc")).toContainText(
    "semi-aquatic mammals of the North Pacific",
  );
  await expect(section).not.toContainText("model made this up");
});

test("tabs already saved to a rabbithole are marked as saved", async ({
  bg,
}) => {
  await bg.skipOnboarding();
  await bg.seedCloudKey();
  await seedRabbithole(bg, "Otters");
  // distinct domains so the two rows are distinguishable in the UI
  await openTabs(bg, ["https://example.com/alpha", "https://example.org/beta"]);
  await saveOpenTab(bg, "alpha");
  await mockJoint(bg, [{ title: "Test", description: "test", tabs: [0, 1] }]);

  const newtab = await runCategorise(bg);
  await expect(newtab.locator(".candidate-list")).toContainText("Test", {
    timeout: 10000,
  });

  const alphaRow = newtab.locator(".tab-row", { hasText: "example.com" });
  await expect(alphaRow.locator(".saved-badge")).toBeVisible();

  const betaRow = newtab.locator(".tab-row", { hasText: "example.org" });
  await expect(betaRow.locator(".saved-badge")).toHaveCount(0);
});

// the model sometimes omits tabs from its grouping — dropped tabs must still
// show up (in Don't Save) instead of disappearing from the review
test("tabs the model leaves unassigned land in Don't Save", async ({ bg }) => {
  await bg.skipOnboarding();
  await bg.seedCloudKey();
  // only tab 0 is grouped — tab 1 is dropped by the model
  await mockJoint(bg, [{ title: "Test", description: "test", tabs: [0] }]);
  await openTabs(bg, ["https://example.com/alpha", "https://example.org/beta"]);

  const newtab = await runCategorise(bg);
  await expect(newtab.locator(".candidate-list")).toContainText("Test", {
    timeout: 10000,
  });

  const misc = newtab.locator(".group-section.misc");
  await expect(misc).toContainText("1 tabs");
  await expect(misc).toContainText("example.org");
});
