import { test, expect } from "./fixtures";
import {
  mockJoint,
  mockJointDelayed,
  mockDecisions,
  openTabs,
  runCategorise,
} from "./categorise-helpers";

// Feature: "if i start categorising i can't rerun mid way"
// Interpretation: rerunning must not be gated on having edited candidates
// (the current Rerun button only renders once candidatesDirty is true), and
// must be reachable while a run is still in flight.

test("rerun is available after results without editing candidates", async ({
  bg,
}) => {
  await bg.skipOnboarding();
  await bg.seedCloudKey();
  await mockJoint(bg, [{ title: "Test", description: "test", tabs: [0, 1] }]);
  await openTabs(bg, ["https://example.com/alpha", "https://example.com/beta"]);

  const newtab = await runCategorise(bg);
  await expect(newtab.locator(".candidate-list")).toContainText("Test", {
    timeout: 10000,
  });

  // no edits made — rerun should still be offered
  // (getByRole with exact name: matches "Rerun", not "Rerunning...")
  await expect(
    newtab.getByRole("button", { name: "Rerun", exact: true }),
  ).toBeVisible();
});

test("rerun is available while a categorise run is in flight", async ({
  bg,
}) => {
  await bg.skipOnboarding();
  await bg.seedCloudKey();
  // response arrives 5s late so the run is still in progress when we assert
  await mockJointDelayed(
    bg,
    [{ title: "Test", description: "test", tabs: [0] }],
    5000,
  );
  await openTabs(bg, ["https://example.com/alpha"]);

  const newtab = await runCategorise(bg);

  await expect(
    newtab.locator("button", { hasText: /rerun|start over/i }),
  ).toBeVisible({ timeout: 3000 });
});

test("rerun re-requests assignments with the current candidates", async ({
  bg,
}) => {
  await bg.skipOnboarding();
  await bg.seedCloudKey();
  await mockJoint(bg, [{ title: "Test", description: "test", tabs: [0, 1] }]);
  await openTabs(bg, ["https://example.com/alpha", "https://example.com/beta"]);

  const newtab = await runCategorise(bg);
  await expect(newtab.locator(".candidate-list")).toContainText("Test", {
    timeout: 10000,
  });

  // rerun without edits: jev re-assigns both tabs into the group
  await mockDecisions(bg, {
    tab_0: { choice: "g1" },
    tab_1: { choice: "g1" },
  });
  await newtab.getByRole("button", { name: "Rerun", exact: true }).click();
  await expect(newtab.locator(".group-section").first()).toContainText(
    "2 tabs",
    { timeout: 10000 },
  );
});
