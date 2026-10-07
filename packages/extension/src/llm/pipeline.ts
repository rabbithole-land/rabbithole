import { runSkill } from "./provider";
import type { CloudProviderConfig } from "./cloud";
import { groupSkill } from "./skills/group";
import type { TabInfo, RabbitholeContext } from "../utils/types";

// a proposed or pre-seeded grouping of tabs — a rabbithole-to-be
export interface Candidate {
  key: string;
  title: string;
  description: string;
  existingId?: string | null;
}

export interface PipelineInput {
  tabs: TabInfo[];
  existingRabbitholes: RabbitholeContext[];
  // pre-seeded candidates (tab groups, user-added), offered to the model as
  // reusable groupings
  fixedCandidates: Candidate[];
  cloudConfig?: CloudProviderConfig;
}

export interface PipelineOutput {
  candidates: Candidate[];
  assignments: Record<string, number[]>;
}

// joint grouping scored best on the 168-tab benchmark (f1 0.64 vs 0.55 for
// the staged propose→assign pipeline); gpt-5.4 was the winning model
const CategoriseModel = "openai/gpt-5.4";

// One model call groups every tab with the whole list and the user's
// rabbitholes in view. Output is sanitized so the caller gets: unique
// candidate keys, each tab in at most one group, existingId only when it
// names a real rabbithole.
export async function runCategorisePipeline(
  input: PipelineInput,
): Promise<PipelineOutput> {
  const { tabs, existingRabbitholes, fixedCandidates, cloudConfig } = input;
  const config = { ...cloudConfig, model: CategoriseModel };
  const existingIds = new Set(existingRabbitholes.map((rh) => rh.id));

  // user-made tab groups (no existingId) are offered as reusable pseudo-
  // rabbitholes so the model can fold tabs into them; candidates that merely
  // mirror an existing rabbithole are already covered by that rabbithole
  const hintGroups = fixedCandidates.filter(
    (c) => !c.existingId || !existingIds.has(c.existingId),
  );
  const contextRabbitholes = [
    ...existingRabbitholes,
    ...hintGroups.map((c) => ({
      id: c.key,
      title: c.title,
      content: c.description,
    })),
  ];
  const hintByKey = new Map(hintGroups.map((c) => [c.key, c]));

  // The same page open in several tabs is one thing. Collapse duplicates
  // before the call (fewer tokens, nothing to get wrong) and expand after, so
  // duplicates always land in the same group.
  const uniqueIndexByKey = new Map<string, number>();
  const uniqueTabs: TabInfo[] = [];
  const copies: number[][] = []; // unique index -> original tab indices
  tabs.forEach((t, i) => {
    const key = normalizeUrl(t.url);
    const existing = uniqueIndexByKey.get(key);
    if (existing === undefined) {
      uniqueIndexByKey.set(key, uniqueTabs.length);
      uniqueTabs.push(t);
      copies.push([i]);
    } else {
      copies[existing].push(i);
    }
  });

  const grouped = await runSkill(
    groupSkill,
    { tabs: uniqueTabs, existingRabbitholes: contextRabbitholes },
    { cloudConfig: config },
  );

  const candidates: Candidate[] = [];
  const assignments: Record<string, number[]> = {};
  const placed = new Set<number>();
  const byExistingId = new Map<string, string>();

  for (const g of grouped.data.groups) {
    const uniqueMembers = [...new Set(g.tabs)].filter(
      (u) =>
        Number.isInteger(u) &&
        u >= 0 &&
        u < uniqueTabs.length &&
        !placed.has(u),
    );
    if (uniqueMembers.length === 0) continue;
    for (const u of uniqueMembers) placed.add(u);
    const members = uniqueMembers.flatMap((u) => copies[u]);

    const reusedId =
      g.existingId &&
      (existingIds.has(g.existingId) || hintByKey.has(g.existingId))
        ? g.existingId
        : undefined;
    // two groups naming the same rabbithole are one group
    if (reusedId && byExistingId.has(reusedId)) {
      assignments[byExistingId.get(reusedId)!].push(...members);
      continue;
    }

    const hint = reusedId ? hintByKey.get(reusedId) : undefined;
    const key = hint ? hint.key : `g${candidates.length + 1}`;
    candidates.push(
      hint
        ? { ...hint }
        : {
            key,
            title:
              g.title.trim() ||
              g.description.trim().slice(0, 60) ||
              "Untitled group",
            description: g.description,
            existingId: reusedId,
          },
    );
    assignments[key] = members;
    if (reusedId) byExistingId.set(reusedId, key);
  }

  // A page open more than once is a thread of its own even with no other
  // partner: give each such unplaced page a group of its copies.
  copies.forEach((idxs, u) => {
    if (placed.has(u) || idxs.length < 2) return;
    const key = `g${candidates.length + 1}`;
    candidates.push({
      key,
      title: uniqueTabs[u].title.slice(0, 80) || "Repeated page",
      description: "The same page open in several tabs.",
    });
    assignments[key] = idxs;
  });

  return { candidates, assignments };
}

// Same page = same URL once the fragment, tracking params and trailing slash
// are dropped.
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|ref$|fbclid$|gclid$)/i.test(k)) u.searchParams.delete(k);
    }
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}
