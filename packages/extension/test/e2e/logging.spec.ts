import { test, expect } from "./fixtures";
import { MessageRequest } from "../../src/utils/types";

// Feature: "turn logs off by default"
// Interpretation: the persistent log buffer (rabbithole_logs in
// chrome.storage.local) is opt-in — with default settings nothing is
// persisted, enabling the setting resumes logging.

async function readStoredLogs(bg: {
  msgPage: import("@playwright/test").Page;
}): Promise<unknown[]> {
  return bg.msgPage.evaluate(
    () =>
      new Promise<unknown[]>((resolve) => {
        chrome.storage.local.get("rabbithole_logs", (v) => {
          resolve((v.rabbithole_logs as unknown[]) ?? []);
        });
      }),
  );
}

test("logs are not persisted with default settings", async ({ bg }) => {
  await bg.skipOnboarding();

  // generate activity that currently logs every message
  await bg.sendMessage({ type: MessageRequest.GET_ALL_RABBITHOLES });
  await bg.sendMessage({ type: MessageRequest.GET_SETTINGS });
  await bg.openNewtab();

  await expect
    .poll(async () => readStoredLogs(bg), { timeout: 3000 })
    .toHaveLength(0);
});
