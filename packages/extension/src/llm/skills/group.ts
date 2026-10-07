import { z } from "zod";
import type { Skill, SkillContext, JSONSchema } from "../provider";
import type { TabInfo, RabbitholeContext } from "../../utils/types";

// Joint grouping: one call sees every open tab AND the user's existing
// rabbitholes together and writes the groups directly. Deciding all tabs in
// one context lets the model use sibling tabs as evidence (three operator
// dashboards belong together; a lone mention of the same product elsewhere
// does not) — something per-tab assignment against a fixed label list cannot do.

export interface GroupInput {
  tabs: TabInfo[];
  existingRabbitholes: RabbitholeContext[];
}

export interface GroupedCandidate {
  title: string;
  description: string;
  existingId?: string | null;
  tabs: number[];
}

export interface GroupOutput {
  groups: GroupedCandidate[];
  unsorted: number[];
}

const schema: JSONSchema = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          existingId: { type: "string" },
          tabs: { type: "array", items: { type: "number" } },
        },
        required: ["title", "tabs"],
      },
    },
    unsorted: { type: "array", items: { type: "number" } },
  },
  required: ["groups"],
};

const validator = z.object({
  groups: z.array(
    z.object({
      // models occasionally drop a field on one group; tolerate it here and
      // let the pipeline fill a fallback rather than failing the whole run
      title: z.string().default(""),
      description: z.string().default(""),
      existingId: z.string().nullish(),
      tabs: z.array(z.number()).default([]),
    }),
  ),
  unsorted: z.array(z.number()).default([]),
});

export function formatTabLine(t: TabInfo, i: number): string {
  let where = t.url;
  try {
    const u = new URL(t.url);
    where = `${u.hostname}${u.pathname.slice(0, 80)}`;
  } catch {}
  const desc = t.ogDescription ? ` — ${t.ogDescription.slice(0, 140)}` : "";
  return `${i}. ${where} - ${t.title.slice(0, 120)}${desc}`;
}

export const groupSkill: Skill<GroupInput, GroupOutput> = {
  name: "group",

  buildContext(input: GroupInput): SkillContext<GroupOutput> {
    const tabList = input.tabs.map((t, i) => formatTabLine(t, i)).join("\n");

    let existingSection = "";
    if (input.existingRabbitholes.length > 0) {
      existingSection =
        "\n\nThe user's existing rabbitholes (their own taxonomy):\n\n" +
        input.existingRabbitholes
          .map(
            (rh) =>
              `## ${rh.id}\nTitle: ${rh.title}${rh.content.trim() ? `\n${rh.content}` : ""}`,
          )
          .join("\n\n");
    }

    const systemPrompt =
      "You sort a user's open browser tabs into rabbitholes: named groups of tabs that belong to the same " +
      "thread of activity. Output ONLY a JSON object: " +
      '{ "groups": [{ "title": "...", "description": "...", "existingId": "<id, only if reusing an existing rabbithole>", "tabs": [0, 5, 9] }], ' +
      '"unsorted": [3, 41] }. ' +
      "Every tab index must appear in exactly one group or in `unsorted`. " +
      "\n\nWhat a group is: one specific thread the user was researching, building, operating, following, or doing — " +
      "a single project, product, person, event, place, question, or subject. Ask: would the user reopen these tabs " +
      "together to continue the same thread? Sharing a broad field (AI, science, politics) is NOT enough; " +
      "sharing a website or medium (Wikipedia, GitHub, YouTube, social feeds, login pages) is NOT enough. " +
      "Classify each tab by what it is about, using the page description after ' — ' when the title is vague. " +
      "\n\nUse the whole list as evidence: a tab whose own title is ambiguous should go where its closest siblings are. " +
      "Duplicate or near-duplicate tabs (same page open twice) always go in the same group. " +
      "Pages about different projects stay apart even when they use the same tools or sit on the same site; " +
      "building or operating something, reading about its wider ecosystem, and the tooling around it are " +
      "separate threads unless the tabs clearly belong to one effort. Personal admin, work, and hobbies are separate. " +
      "\n\nExisting rabbitholes are the user's own taxonomy: when a tab continues the specific thread an existing " +
      "rabbithole's title names, reuse it — set `existingId` and keep its exact title. Existing titles are often " +
      "broad, so never use one as a catch-all: a tab that is merely adjacent (same field, platform, protocol, or " +
      "community) does not belong, and when several adjacent tabs form their own thread, make a new group for it " +
      "instead of stretching the existing one. " +
      "\n\nSize: groups of 2-3 tabs are normal and good; split a group that grows past ~10 tabs unless it is truly one thread. " +
      "Put a tab in `unsorted` only if it has no real partner — do not invent a group for a lone tab and do not " +
      "make catch-all groups (Misc, Reading, Tools, Research). " +
      "Titles are short and specific; descriptions are one sentence saying what belongs. No markdown, no commentary.";

    const userPrompt =
      `Here are ${input.tabs.length} open tabs:\n\n${tabList}` +
      existingSection +
      "\n\nSort every tab.";

    return {
      systemPrompt,
      userPrompt,
      schema,
      validator,
      maxTokens: 8192,
    };
  },
};
