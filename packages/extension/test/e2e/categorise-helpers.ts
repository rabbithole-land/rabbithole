import type { Page } from "@playwright/test";
import { MessageRequest } from "../../src/utils/types";
import type { TestHarness } from "./fixtures";

export async function mockJoint(
  bg: TestHarness,
  groups: unknown[],
): Promise<void> {
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

// same as mockJoint but the response only arrives after delayMs — lets a test
// inspect the UI while a categorise run is in flight
export async function mockJointDelayed(
  bg: TestHarness,
  groups: unknown[],
  delayMs: number,
): Promise<void> {
  await bg.context.route("**/api/v1/chat/completions", async (route) => {
    await new Promise((r) => setTimeout(r, delayMs));
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

export async function mockDecisions(
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

export async function openTabs(bg: TestHarness, urls: string[]): Promise<void> {
  for (const url of urls) {
    const p = await bg.context.newPage();
    await p.goto(url);
  }
}

export async function runCategorise(bg: TestHarness): Promise<Page> {
  const newtab = await bg.openNewtab();
  // click() auto-waits for the button to be actionable
  await newtab
    .locator("button", { hasText: /clean up/i })
    .first()
    .click({ timeout: 10000 });
  return newtab;
}

// creates a rabbithole (becomes the active one); returns its id
export async function seedRabbithole(
  bg: TestHarness,
  title: string,
  description?: string,
): Promise<string> {
  const rh = (await bg.sendMessage({
    type: MessageRequest.CREATE_NEW_RABBITHOLE,
    title,
    description,
  })) as { id: string };
  return rh.id;
}

// saves an already-open tab (matched by url substring) into the active
// rabbithole via the real SAVE_TAB path — this stores the website record AND
// the rabbithole meta entry, which a bare meta write does not
export async function saveOpenTab(
  bg: TestHarness,
  urlSubstring: string,
): Promise<void> {
  const page = bg.context.pages().find((p) => p.url().includes(urlSubstring));
  if (!page) {
    throw new Error(`no open tab matching ${urlSubstring}`);
  }
  await page.bringToFront();
  await bg.sendMessage({ type: MessageRequest.SAVE_TAB });
}
