import type { Candidate } from "./pipeline";

export interface JevAssignmentInput {
  tabs: {
    title: string;
    url: string;
    windowId?: number;
    ogDescription?: string;
  }[];
  candidates: Candidate[];
  /** if omitted, falls back to the chrome.storage key */
  apiKey?: string;
}

export interface JevAnswer {
  choice?: string;
}

export interface JevAssignmentOutput {
  assignments: Map<string, number[]>; // candidate key → tab indices
}

export async function runJevAssignment(
  input: JevAssignmentInput,
): Promise<JevAssignmentOutput> {
  const apiKey =
    input.apiKey ??
    (await chrome.storage.local.get(["cloudApiKey"])).cloudApiKey ??
    "";
  if (!apiKey) {
    throw new Error("No OpenRouter API key configured");
  }

  const { tabs, candidates } = input;

  const hasWindows = tabs.some((t) => t.windowId !== undefined);
  const windowTags = new Map<number, string>();
  if (hasWindows) {
    let nextWindow = 1;
    for (const t of tabs) {
      if (t.windowId !== undefined && !windowTags.has(t.windowId)) {
        windowTags.set(t.windowId, `w${nextWindow}`);
        nextWindow++;
      }
    }
  }

  const tabList = tabs
    .map((t, i) => {
      let host = t.url;
      try {
        const u = new URL(t.url);
        host = `${u.hostname}${u.pathname.slice(0, 60)}`;
      } catch {}
      const tag =
        hasWindows && t.windowId !== undefined
          ? ` [${windowTags.get(t.windowId)}]`
          : "";
      return `${i}. ${host} - ${t.title}${tag}`;
    })
    .join("\n");

  const criteria: Record<string, string> = {};
  for (const c of candidates) {
    criteria[c.key] = c.description ? `${c.title} — ${c.description}` : c.title;
  }

  const state =
    "Open browser tabs to be sorted into rabbitholes:\n\n" +
    tabList +
    (hasWindows
      ? "\n\nTabs with the same [wN] tag were open in the same browser window and often belong to the same activity — treat that as a hint, not a rule."
      : "") +
    "\n\nCandidate rabbitholes:\n" +
    candidates
      .map((c) => `- ${c.key}: ${c.title} — ${c.description}`)
      .join("\n");

  const questions: Record<
    string,
    { type: string; instructions: string; criteria: Record<string, string> }
  > = {};
  for (let i = 0; i < tabs.length; i++) {
    const tag =
      hasWindows && tabs[i].windowId !== undefined
        ? ` [${windowTags.get(tabs[i].windowId!)}]`
        : "";
    questions[`tab_${i}`] = {
      type: "choice",
      instructions: `Tab ${i}${tag} "${tabs[i].title.slice(0, 80)}"${tabs[i].ogDescription ? ` — ${tabs[i].ogDescription.slice(0, 150)}` : ""} — which rabbithole? Judge by what this specific page is ABOUT, not by its website: different posts, profiles, or articles on the same site are usually different topics. Pick the candidate whose description matches the page's subject; if none match, pick the closest broad one rather than inventing a fit.`,
      criteria,
    };
  }

  // Jev's 32k context can't hold criteria (duplicated per question) for a
  // large tab set in one request — batch the questions and merge answers.
  // Enriched criteria (title + description) are heavier than bare titles, so
  // the batch size scales with total criteria size to stay under ~24k tokens.
  const criteriaChars = candidates.reduce(
    (sum, c) =>
      sum + c.key.length + c.title.length + (c.description?.length ?? 0) + 4,
    0,
  );
  const criteriaTokensPerQuestion = Math.ceil(criteriaChars / 4);
  const batchSize = Math.max(
    5,
    Math.floor(24000 / Math.max(1, criteriaTokensPerQuestion)),
  );
  const indices = Object.keys(questions);
  const answers: Record<string, JevAnswer> = {};
  // parallel batches: Jev batches are independent, and sequential round-trips
  // dominate categorisation latency on 150+ tab sets
  const batchPromises: Promise<void>[] = [];
  for (let b = 0; b < indices.length; b += batchSize) {
    const batchQuestions: typeof questions = {};
    for (const key of indices.slice(b, b + batchSize)) {
      batchQuestions[key] = questions[key];
    }
    batchPromises.push(
      (async () => {
        const res = await fetch("https://openrouter.ai/api/alpha/decisions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "typesafe/jev-1.13",
            state,
            questions: batchQuestions,
          }),
        });
        if (!res.ok) {
          throw new Error(`Jev API error ${res.status}: ${await res.text()}`);
        }
        const data = await res.json();
        Object.assign(answers, data.answers ?? {});
      })(),
    );
  }
  await Promise.all(batchPromises);

  const assignments = new Map<string, number[]>();

  for (const [key, answer] of Object.entries(answers)) {
    const i = Number(key.split("_")[1]);
    if (!Number.isInteger(i) || i < 0 || i >= tabs.length) {
      continue;
    }
    const choice = answer?.choice;
    if (choice && criteria[choice]) {
      if (!assignments.has(choice)) {
        assignments.set(choice, []);
      }
      assignments.get(choice)!.push(i);
    }
  }

  return { assignments };
}
