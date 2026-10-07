import { test, expect } from "./fixtures";
import {
  mockJoint,
  openTabs,
  runCategorise,
  seedRabbithole,
} from "./categorise-helpers";

// Features: "search input doesn't work in transfer" and
// "bulk options? maybe with checkbox"

test("transfer search filters move targets as you type", async ({ bg }) => {
  await bg.skipOnboarding();
  await bg.seedCloudKey();
  await seedRabbithole(bg, "Otters");
  await seedRabbithole(bg, "Rockets");
  await mockJoint(bg, [{ title: "Test", description: "test", tabs: [0] }]);
  await openTabs(bg, ["https://example.com/alpha"]);

  const newtab = await runCategorise(bg);
  await expect(newtab.locator(".candidate-list")).toContainText("Test", {
    timeout: 10000,
  });

  // open the move panel on the tab and search
  await newtab.locator(".tab-row .move-btn").first().click();
  const panel = newtab.locator(".move-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".search-result-item")).toHaveCount(3); // Otters, Rockets, Test

  await panel.locator(".search-input").fill("ott");
  await expect(panel.locator(".search-result-item")).toHaveCount(1);
  await expect(panel.locator(".search-result-item")).toContainText("Otters");
});

test("tabs can be bulk-selected with checkboxes and moved together", async ({
  bg,
}) => {
  await bg.skipOnboarding();
  await bg.seedCloudKey();
  await mockJoint(bg, [
    { title: "Keep", description: "keep", tabs: [0, 1] },
    { title: "Other", description: "other", tabs: [2] },
  ]);
  await openTabs(bg, [
    "https://example.com/alpha",
    "https://example.com/beta",
    "https://example.com/gamma",
  ]);

  const newtab = await runCategorise(bg);
  await expect(newtab.locator(".candidate-list")).toContainText("Keep", {
    timeout: 10000,
  });

  // select the two tabs in Keep via their row checkboxes
  const keepSection = newtab.locator(".group-section", { hasText: "Keep" });
  await keepSection.locator(".tab-row input[type=checkbox]").nth(0).check();
  await keepSection.locator(".tab-row input[type=checkbox]").nth(1).check();

  // bulk action bar appears and offers Don't save
  const bulkBar = newtab.locator(".bulk-bar");
  await expect(bulkBar).toBeVisible();
  await expect(bulkBar).toContainText("2 selected");
  await bulkBar.locator("button", { hasText: /don't save/i }).click();

  // both tabs land in the misc group and Keep is emptied
  // (rows render title + domain only, so identity is proven by the count
  // draining out of Keep, not by url text)
  const misc = newtab.locator(".group-section.misc");
  await expect(misc).toContainText("2 tabs");
  // emptied groups are removed from the view entirely
  await expect(keepSection).toHaveCount(0);
});
