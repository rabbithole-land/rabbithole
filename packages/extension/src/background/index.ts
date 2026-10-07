import { MessageRequest, Logger } from "../utils";
import { WebsiteStore } from "../storage/db";
import type { Burrow, Website } from "../utils/types";
import { getSession } from "../atproto/client";
import { syncBurrowToCollection } from "../atproto/cosmik";
import {
  publishTrail as publishSidetrailTrail,
  startSidetrailWalk,
  advanceSidetrailWalk,
  completeSidetrailWalk,
  abandonSidetrailWalk,
} from "../atproto/sidetrail";
import { syncFromAtproto } from "../atproto/sync";
import { storeWebsites, isValidWebUrl } from "../utils/browser";
import {
  importBookmarksFromBrowser,
  importTabGroupsFromBrowser,
} from "../utils/import";
import {
  getTrailWalkTabId,
  setTrailWalkTabId,
  clearTrailWalkTab,
  broadcastTrailWalkUpdated,
  focusOrOpenTrailTab,
} from "../utils/trails";
import { initPostHog, capture, getPostHog } from "../utils/posthog";
import { runJevAssignment } from "../llm/jev";
import { runCategorisePipeline } from "../llm/pipeline";
import type { RabbitholeContext, TabInfo } from "../utils/types";
import type { Candidate } from "../llm/pipeline";

type Handler = (
  request: any,
  sender: chrome.runtime.MessageSender,
) => Promise<any>;

// Read-only message types — skip analytics for these
const AnalyticsDisabledRequests = new Set([
  MessageRequest.GET_SETTINGS,
  MessageRequest.GET_ALL_ITEMS,
  MessageRequest.GET_ALL_BURROWS,
  MessageRequest.GET_BURROW_WEBSITES,
  MessageRequest.GET_ACTIVE_BURROW,
  MessageRequest.GET_BURROW,
  MessageRequest.GET_ACTIVE_RABBITHOLE,
  MessageRequest.GET_ALL_RABBITHOLES,
  MessageRequest.FETCH_RABBITHOLE_FOR_BURROW,
  MessageRequest.GET_RABBITHOLE_WEBSITES,
  MessageRequest.GET_ALL_TRAILS,
  MessageRequest.GET_TRAIL,
  MessageRequest.GET_ACTIVE_TRAIL,
  MessageRequest.GET_TRAIL_WALK_STATE,
  MessageRequest.GET_TRAIL_WALK_TAB,
  MessageRequest.GET_CURRENT_TAB_ID,
  MessageRequest.REGISTER_TRAIL_WALK_TAB,
]);

function handle(
  sendResponse: (response?: any) => void,
  fn: Handler,
  request: any,
  sender: chrome.runtime.MessageSender,
) {
  fn(request, sender)
    .then((res) => {
      sendResponse(res);
      // Capture every write action by its MessageRequest name
      if (!AnalyticsDisabledRequests.has(request.type)) {
        capture(MessageRequest[request.type] || "unknown");
      }
    })
    .catch((err) => {
      Logger.error("Handler failed", err);
      sendResponse({ error: err?.message || "Unknown error" });
    });
}

// Debounced sync flush — batches ops and pushes after 5s of inactivity
// enrich categorise tab context with og metadata from live pages —
// on by default while we measure how much it actually helps
const EnrichTabsWithOgMetadata = true;

const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleFlush(burrowId: string) {
  if (flushTimers.has(burrowId)) {
    clearTimeout(flushTimers.get(burrowId));
  }
  flushTimers.set(
    burrowId,
    setTimeout(async () => {
      flushTimers.delete(burrowId);
      try {
        const db = new WebsiteStore(indexedDB);
        const burrow = await db.getBurrow(burrowId);
        if (!burrow?.syncEnabled || !burrow.sembleCollectionUri) return;

        const session = await getSession();
        if (!session) return;

        const ops = await db.getPendingSyncOps(burrowId);
        if (!ops.length) return;

        const websites = await db.getAllWebsitesForBurrow(burrowId);
        await syncBurrowToCollection(
          session.did,
          burrow.sembleCollectionUri,
          websites,
        );
        await db.markSyncOpsSynced(ops.map((op) => op.id));
        await db.updateBurrowSembleInfo(
          burrowId,
          burrow.sembleCollectionUri,
          Date.now(),
        );
      } catch {
        // Next startup/alarm will pick up
      }
    }, 5000),
  );
}

// Periodic pull sync — hourly
const SYNC_ALARM_NAME = "sembleSync";
const SYNC_INTERVAL_MINUTES = 10;

async function pullSync() {
  const session = await getSession();
  if (!session) return;

  const db = new WebsiteStore(indexedDB);
  try {
    await syncFromAtproto(session.did, db);
    await db.purgeSyncedOps(24 * 60 * 60 * 1000);
  } catch (err) {
    Logger.error("Periodic sync failed", err);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM_NAME) {
    pullSync();
  }
});

// Ensure PostHog is initialized when the service worker wakes up
// (onStartup only fires on browser start, not on service worker restart)
async function ensureAnalyticsInit() {
  if (getPostHog() !== null) {
    return;
  }
  try {
    WebsiteStore.init(indexedDB);
    const db = new WebsiteStore(indexedDB);
    const settings = await db.getSettings();
    if (settings?.analyticsEnabled) {
      await initPostHog({ persistence: "memory" });
    }
  } catch (err) {
    Logger.warn(
      "Analytics init failed, events will be lost until next restart",
      err,
    );
  }
}

chrome.runtime.onStartup.addListener(async () => {
  WebsiteStore.init(indexedDB);
  ensureAnalyticsInit();
  pullSync();
});

chrome.runtime.onInstalled.addListener(async () => {
  WebsiteStore.init(indexedDB);
  chrome.alarms.create(SYNC_ALARM_NAME, {
    periodInMinutes: SYNC_INTERVAL_MINUTES,
  });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!("type" in request)) {
    // arcane incantation required for async `sendResponse`s to work
    // https://developer.chrome.com/docs/extensions/mv3/messaging/#simple
    sendResponse({ error: "request type required" });
    return true;
  }

  const requestName = MessageRequest[request.type] || "UNKNOWN_REQUEST";

  Logger.info(`Background received: ${requestName}`, {
    request,
    sender: sender.tab ? `Tab ${sender.tab.id}` : "Extension",
  });

  const db = new WebsiteStore(indexedDB);

  const handlers: Partial<Record<MessageRequest, Handler>> = {
    [MessageRequest.GET_CURRENT_TAB_ID]: async (_req, sender) => {
      return { tabId: sender.tab?.id ?? null };
    },

    [MessageRequest.REGISTER_TRAIL_WALK_TAB]: async (req, sender) => {
      const tabId = req.tabId ?? sender.tab?.id ?? null;
      if (tabId !== null) {
        await setTrailWalkTabId(tabId);
        return { success: true };
      }
      return { success: false };
    },

    [MessageRequest.SAVE_TAB]: async (_req, _sender) => {
      const tabs = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });

      const sites = await storeWebsites(tabs, db);
      if (sites.length > 0) {
        const activeBurrow = await db.getActiveBurrow();
        if (activeBurrow) {
          await db.saveWebsitesToBurrow(sites);
        }

        // Also add to active rabbithole meta
        const activeRabbithole = await db.getActiveRabbithole();
        if (activeRabbithole) {
          const urls = sites.map((s) => s.url);
          await db.addWebsitesToRabbitholeMeta(activeRabbithole.id, urls);
        }
      }

      return { success: true };
    },

    [MessageRequest.GET_ALL_ITEMS]: async () => db.getAllWebsites(),

    [MessageRequest.GET_SETTINGS]: async () => db.getSettings(),

    [MessageRequest.UPDATE_SETTINGS]: async (req) => {
      if (!("settings" in req)) {
        throw new Error("settings required");
      }
      return db.updateSettings(req.settings);
    },

    [MessageRequest.GET_ALL_BURROWS]: async () => db.getAllBurrows(),

    [MessageRequest.GET_BURROW_WEBSITES]: async (req) => {
      if (!("burrowId" in req)) {
        throw new Error("burrowId required");
      }
      return db.getAllWebsitesForBurrow(req.burrowId);
    },

    [MessageRequest.GET_RABBITHOLE_WEBSITES]: async (req) => {
      if (!("rabbitholeId" in req)) {
        throw new Error("rabbitholeId required");
      }
      return db.getAllWebsitesForRabbithole(req.rabbitholeId);
    },

    [MessageRequest.CREATE_NEW_BURROW]: async (req) => {
      if (!("newBurrowName" in req)) {
        throw new Error("newBurrowName required");
      }
      return db.createNewActiveBurrow(req.newBurrowName);
    },

    // Fix: guard against null burrowId before trying to fetch the parent rabbithole
    [MessageRequest.CHANGE_ACTIVE_BURROW]: async (req) => {
      if (!("burrowId" in req)) {
        throw new Error("burrowId required");
      }
      if (req.burrowId === null) {
        await db.changeActiveBurrow(null);
        await db.changeActiveTrail(null);
        return { success: true };
      }
      const parentRabbithole = await db.fetchRabbitholeForBurrow(req.burrowId);
      await db.changeActiveRabbithole(parentRabbithole.id);
      await db.changeActiveBurrow(req.burrowId);
      await db.changeActiveTrail(null);
      return { success: true };
    },

    [MessageRequest.GET_ACTIVE_BURROW]: async () => db.getActiveBurrow(),

    [MessageRequest.GET_BURROW]: async (req) => {
      if (!("burrowId" in req)) {
        throw new Error("burrowId required");
      }
      return db.getBurrow(req.burrowId);
    },

    [MessageRequest.SAVE_WINDOW_TO_NEW_BURROW]: async (req, sender) => {
      if (!sender.tab?.windowId) {
        throw new Error("sender tab windowId required");
      }
      if (!("newBurrowName" in req)) {
        throw new Error("burrowName required");
      }

      const tabs = await chrome.tabs.query({ windowId: sender.tab.windowId });
      const sites = await storeWebsites(tabs, db);
      const urls = sites.map((s) => s.url);

      const burrow = await db.createNewActiveBurrow(req.newBurrowName, urls);

      const activeRabbithole = await db.getActiveRabbithole();
      if (activeRabbithole) {
        await db.addWebsitesToRabbitholeMeta(activeRabbithole.id, urls);
      }

      return burrow;
    },

    // Fix: use lastFocusedWindow to get the actual browser window the user is in,
    // not the extension's own window context. Fall back gracefully if none found.
    [MessageRequest.SAVE_WINDOW_TO_ACTIVE_BURROW]: async () => {
      const windows = await chrome.windows.getAll({ populate: false });
      // Find the last focused normal browser window (not the extension popup)
      const lastFocused = await chrome.windows.getLastFocused({
        populate: false,
        windowTypes: ["normal"],
      });

      if (!lastFocused?.id) {
        Logger.warn("SAVE_WINDOW_TO_ACTIVE_BURROW: no focused window found");
        return { success: false };
      }

      const tabs = await chrome.tabs.query({ windowId: lastFocused.id });
      const sites = await storeWebsites(tabs, db);

      if (sites.length > 0) {
        await db.saveWebsitesToBurrow(sites);

        // make sure to sync with rabbithole meta
        const activeBurrow = await db.getActiveBurrow();
        if (activeBurrow) {
          const rabbithole = await db.fetchRabbitholeForBurrow(activeBurrow.id);
          const urls = sites.map((s) => s.url);
          await db.addWebsitesToRabbitholeMeta(rabbithole.id, urls);
        }
      }

      return { success: true };
    },

    [MessageRequest.SAVE_WINDOW_TO_RABBITHOLE]: async (req) => {
      if (!("rabbitholeId" in req)) {
        throw new Error("rabbitholeId required");
      }

      const lastFocused = await chrome.windows.getLastFocused({
        populate: false,
        windowTypes: ["normal"],
      });

      if (!lastFocused?.id) {
        Logger.warn("SAVE_WINDOW_TO_RABBITHOLE: no focused window found");
        return { success: false };
      }

      const tabs = await chrome.tabs.query({ windowId: lastFocused.id });
      const sites = await storeWebsites(tabs, db);
      const urls = sites.map((s) => s.url);

      await db.addWebsitesToRabbitholeMeta(req.rabbitholeId, urls);
      return { success: true };
    },

    [MessageRequest.UPDATE_RABBITHOLE_PINNED_WEBSITES]: async (
      _req,
      sender,
    ) => {
      if (!sender.tab?.windowId) {
        throw new Error("sender tab windowId required");
      }

      const tabs = await chrome.tabs.query({ windowId: sender.tab.windowId });
      const sites = await storeWebsites(tabs, db);
      const urls = sites.map((s) => s.url);

      const activeRabbithole = await db.getActiveRabbithole();
      if (activeRabbithole) {
        await db.updateRabbitholeActiveTabs(activeRabbithole.id, urls);
        await db.addWebsitesToRabbitholeMeta(activeRabbithole.id, urls);
      }

      return { success: true };
    },

    [MessageRequest.RENAME_BURROW]: async (req) => {
      if (!("newName" in req) || !("burrowId" in req)) {
        throw new Error("burrowId and newName required");
      }
      return db.renameBurrow(req.burrowId, req.newName);
    },

    [MessageRequest.DELETE_BURROW]: async (req) => {
      if (!("rabbitholeId" in req) || !("burrowId" in req)) {
        throw new Error("rabbitholeId and burrowId required");
      }
      await db.deleteBurrowFromRabbithole(req.rabbitholeId, req.burrowId);
      await db.deleteBurrow(req.burrowId);
      // Always clear the active burrow and trail when a burrow is deleted,
      // regardless of which burrow was active, to avoid a stuck UI state.
      await db.changeActiveBurrow(null);
      await db.changeActiveTrail(null);
    },

    [MessageRequest.DELETE_WEBSITE]: async (req) => {
      if (!("url" in req) || !("burrowId" in req)) {
        throw new Error("burrowId and url required");
      }
      await db.deleteWebsiteFromBurrow(req.burrowId, req.url);

      // Queue sync op if burrow is synced
      const burrow = await db.getBurrow(req.burrowId);
      if (burrow.syncEnabled && burrow.sembleCollectionUri) {
        await db.queueSyncOp(req.burrowId, "REMOVE_URL", { url: req.url });
        scheduleFlush(req.burrowId);
      }
    },

    [MessageRequest.PUBLISH_BURROW]: async (req) => {
      if (!("burrowId" in req) || !("uri" in req) || !("timestamp" in req)) {
        throw new Error("burrowId, uri, and timestamp required");
      }
      await db.updateBurrowSembleInfo(req.burrowId, req.uri, req.timestamp);
      return { success: true };
    },

    [MessageRequest.GET_ACTIVE_RABBITHOLE]: async () =>
      db.getActiveRabbithole(),

    [MessageRequest.GET_ALL_RABBITHOLES]: async () => db.getAllRabbitholes(),

    [MessageRequest.GET_ALL_TRAILS]: async () => db.getAllTrails(),

    [MessageRequest.FETCH_RABBITHOLE_FOR_BURROW]: async (req) => {
      if (!("burrowId" in req)) {
        throw new Error("burrowId required");
      }
      return db.fetchRabbitholeForBurrow(req.burrowId);
    },

    [MessageRequest.CHANGE_ACTIVE_RABBITHOLE]: async (req) => {
      const rabbitholeId = "rabbitholeId" in req ? req.rabbitholeId : null;
      // TODO: does perf here ever measurably affect UX?
      await db.changeActiveRabbithole(rabbitholeId);
      await db.changeActiveBurrow(null);
      await db.changeActiveTrail(null);
      return { success: true };
    },

    [MessageRequest.CREATE_NEW_RABBITHOLE]: async (req) => {
      if (!("title" in req)) {
        throw new Error("title required");
      }
      return db.createNewActiveRabbithole(req.title, req.description);
    },

    [MessageRequest.UPDATE_RABBITHOLE]: async (req) => {
      if (!("rabbitholeId" in req)) {
        throw new Error("rabbitholeId required");
      }
      return db.updateRabbithole(req.rabbitholeId, req.title, req.description);
    },

    [MessageRequest.DELETE_RABBITHOLE]: async (req) => {
      if (!("rabbitholeId" in req)) {
        throw new Error("rabbitholeId required");
      }
      const rabbithole = await db.getRabbithole(req.rabbitholeId);
      await Promise.all([
        ...(rabbithole?.burrows || []).map((b) => db.deleteBurrow(b)),
        ...(rabbithole?.trails || []).map((t) => db.deleteTrail(t)),
      ]);
      await db.deleteRabbithole(req.rabbitholeId);

      const activeRabbithole = await db.getActiveRabbithole();
      if (activeRabbithole?.id === req.rabbitholeId) {
        await db.changeActiveRabbithole(null);
        await db.changeActiveBurrow(null);
        await db.changeActiveTrail(null);
      }
    },

    [MessageRequest.ADD_BURROWS_TO_RABBITHOLE]: async (req) => {
      if (!("rabbitholeId" in req) || !("burrowIds" in req)) {
        throw new Error("rabbitholeId and burrowIds required");
      }
      return db.addBurrowsToRabbithole(req.rabbitholeId, req.burrowIds);
    },

    [MessageRequest.CREATE_NEW_BURROW_IN_RABBITHOLE]: async (req) => {
      if (!("burrowName" in req)) {
        throw new Error("burrowName required");
      }
      return db.createNewBurrowInActiveRabbithole(
        req.burrowName,
        req.websites ?? [],
      );
    },

    [MessageRequest.ADD_WEBSITES_TO_RABBITHOLE_META]: async (req) => {
      if (!("rabbitholeId" in req) || !("urls" in req)) {
        throw new Error("rabbitholeId and urls required");
      }
      return db.addWebsitesToRabbitholeMeta(req.rabbitholeId, req.urls);
    },

    [MessageRequest.ADD_WEBSITES_TO_BURROW]: async (req) => {
      if (!("burrowId" in req) || !("urls" in req)) {
        throw new Error("burrowId and urls required");
      }
      await db.addWebsitesToBurrow(req.burrowId, req.urls);

      // Queue sync ops if burrow is synced
      const burrow = await db.getBurrow(req.burrowId);
      if (burrow.syncEnabled && burrow.sembleCollectionUri) {
        for (const url of req.urls) {
          await db.queueSyncOp(req.burrowId, "ADD_URL", { url });
        }
        // Debounced flush
        scheduleFlush(req.burrowId);
      }
    },

    [MessageRequest.DELETE_WEBSITE_FROM_RABBITHOLE_META]: async (req) => {
      if (!("rabbitholeId" in req) || !("url" in req)) {
        throw new Error("rabbitholeId and url required");
      }
      return db.deleteWebsiteFromRabbitholeMeta(req.rabbitholeId, req.url);
    },

    [MessageRequest.UPDATE_WEBSITE]: async (req) => {
      if (!("url" in req)) {
        throw new Error("url required");
      }
      await db.updateWebsite(req.url, req.name, req.description);

      // Queue sync op for any synced burrows containing this URL
      const allBurrows = await db.getAllBurrows();
      const syncedBurrowsWithUrl = allBurrows.filter(
        (b) =>
          b.syncEnabled &&
          b.sembleCollectionUri &&
          b.websites.includes(req.url),
      );
      for (const b of syncedBurrowsWithUrl) {
        await db.queueSyncOp(b.id, "UPDATE_URL", {
          url: req.url,
          name: req.name,
          description: req.description,
        });
        scheduleFlush(b.id);
      }
    },

    [MessageRequest.REMOVE_FROM_ACTIVE_TABS]: async (req) => {
      if (!("url" in req)) {
        throw new Error("url required");
      }

      const activeRabbithole = await db.getActiveRabbithole();
      if (!activeRabbithole) {
        throw new Error("No active rabbithole found");
      }

      await db.removeWebsiteFromRabbitholeActiveTabs(
        activeRabbithole.id,
        req.url,
      );
      return { success: true };
    },

    [MessageRequest.GET_TRAIL]: async (req) => {
      if (!("trailId" in req)) {
        throw new Error("trailId required");
      }
      return db.getTrail(req.trailId);
    },

    [MessageRequest.GET_ACTIVE_TRAIL]: async () => db.getActiveTrail(),

    [MessageRequest.CHANGE_ACTIVE_TRAIL]: async (req) => {
      const trail = await db.getTrail(req.trailId);
      if (trail?.rabbitholeId) {
        await db.changeActiveRabbithole(trail.rabbitholeId);
      }
      if (!("trailId" in req)) {
        throw new Error("trailId required");
      }
      await db.changeActiveBurrow(null);
      await db.changeActiveTrail(req.trailId);
    },

    [MessageRequest.CREATE_TRAIL]: async (req) => {
      if (
        !("rabbitholeId" in req) ||
        !("name" in req) ||
        !("websites" in req)
      ) {
        throw new Error("rabbitholeId, name, and websites required");
      }
      await db.changeActiveBurrow(null);
      return db.createNewActiveTrail(req.rabbitholeId, req.name, req.websites);
    },

    [MessageRequest.UPDATE_TRAIL]: async (req) => {
      if (!("trailId" in req) || !("updates" in req)) {
        throw new Error("trailId and updates required");
      }
      return db.updateTrail(req.trailId, req.updates);
    },

    [MessageRequest.DELETE_TRAIL]: async (req) => {
      if (!("rabbitholeId" in req) || !("trailId" in req)) {
        throw new Error("rabbitholeId and trailId required");
      }
      await db.deleteTrailFromRabbithole(req.rabbitholeId, req.trailId);
      await db.deleteTrail(req.trailId);
      await db.changeActiveTrail(null);
      await clearTrailWalkTab();
      await broadcastTrailWalkUpdated();
    },

    [MessageRequest.SYNC_ATPROTO]: async () => {
      const session = await getSession();
      if (!session) return { success: false };
      const imported = await syncFromAtproto(session.did, db);
      return { success: true, imported };
    },

    [MessageRequest.IMPORT_TRAIL_FROM_EXPLORE]: async (req) => {
      if (!("trail" in req)) {
        throw new Error("trail required");
      }
      const actorTrail = req.trail as any;

      // Get or create Sidetrails rabbithole for imported trails
      const SIDETRAILS_RH_TITLE = "Sidetrails";
      const allRh = await db.getAllRabbitholes();
      let rabbithole = allRh.find((r) => r.title === SIDETRAILS_RH_TITLE);
      if (!rabbithole) {
        rabbithole = await db.createRabbithole(SIDETRAILS_RH_TITLE);
      }

      // Build TrailStops from ActorTrail
      const stops = (actorTrail.stops || []).map((s: any, i: number) => ({
        tid: s.tid || `stop-${i}`,
        title: s.title || "",
        websiteUrl: s.url || "",
        note: s.note || "",
        buttonText: s.buttonText || "Next",
      }));

      // Check if a trail with the same name and stops already exists
      const existingTrails = await db.getAllTrails();
      const existingTrail = existingTrails.find((t: any) => {
        if (t.name !== actorTrail.title) return false;
        if (t.stops?.length !== stops.length) return false;
        return t.stops.every(
          (s: any, i: number) => s.websiteUrl === stops[i].websiteUrl,
        );
      });

      if (existingTrail) {
        // Reuse existing trail - just set as active
        await db.changeActiveTrail(existingTrail.id);
        await db.startTrailWalk(existingTrail.id);
        await clearTrailWalkTab(); // Clear any previous tab registration
        const firstStop = existingTrail.stops?.[0];
        return {
          trailId: existingTrail.id,
          firstStopUrl: firstStop?.websiteUrl,
        };
      }

      const trail = await db.createTrail(
        rabbithole.id,
        actorTrail.title || "Imported Trail",
        stops,
      );
      await db.updateTrail(trail.id, {
        description: actorTrail.description || "",
        startNote: actorTrail.description || "",
      });

      // Set as active trail (critical for overlay detection)
      await db.changeActiveTrail(trail.id);
      await db.startTrailWalk(trail.id); // Start the walk so overlay can detect it
      await clearTrailWalkTab(); // Clear any previous tab registration

      // Save website stubs for the trail URLs (needed for trail walk state)
      const urls = stops.map((s: any) => s.websiteUrl).filter(Boolean);
      if (urls.length > 0) {
        const stubs = urls.map((url) => ({
          url,
          name: url,
          savedAt: Date.now(),
          faviconUrl: "",
        }));
        await db.saveWebsiteStubs(stubs);
        await db.addWebsitesToRabbitholeMeta(rabbithole.id, urls);
      }

      const firstStop = trail.stops?.[0];
      return { trailId: trail.id, firstStopUrl: firstStop?.websiteUrl };
    },

    [MessageRequest.IMPORT_BURROW_FROM_EXPLORE]: async (req) => {
      if (!("burrow" in req)) {
        throw new Error("burrow required");
      }
      const actorBurrow = req.burrow as any;

      // Get or create Imported Burrows rabbithole
      const IMPORTED_RH_TITLE = "Imported Burrows";
      const allRh = await db.getAllRabbitholes();
      let rabbithole = allRh.find((r) => r.title === IMPORTED_RH_TITLE);
      if (!rabbithole) {
        rabbithole = await db.createRabbithole(IMPORTED_RH_TITLE);
      }

      // Get URLs from cards (which have metadata)
      const cards = actorBurrow.cards || [];
      const urls = cards.map((c: any) => c.url).filter(Boolean);

      const burrow = await db.createBurrow(
        rabbithole.id,
        actorBurrow.name || "Imported Burrow",
        undefined,
        urls,
      );

      // Save website stubs with card metadata
      if (cards.length > 0) {
        const stubs = cards.map((card: any) => ({
          url: card.url,
          name: card.title || card.url,
          savedAt: Date.now(),
          faviconUrl: "",
          openGraphImageUrl: card.image || undefined,
          description: card.description || undefined,
        }));
        await db.saveWebsiteStubs(stubs);
      }

      return { burrowId: burrow.id, rabbitholeId: rabbithole.id };
    },

    [MessageRequest.PUBLISH_TRAIL]: async (req) => {
      if (!("trailId" in req)) {
        throw new Error("trailId required");
      }
      const session = await getSession();
      if (!session) throw new Error("Not logged in");

      const trail = await db.getTrail(req.trailId);
      if (!trail) throw new Error("Trail not found");

      const existingRkey = trail.sidetrailUri
        ? trail.sidetrailUri.split("/").pop()
        : undefined;

      const ref = await publishSidetrailTrail(
        session.did,
        trail,
        existingRkey,
        trail.sidetrailCid,
      );

      await db.updateTrail(req.trailId, {
        sidetrailUri: ref.uri,
        sidetrailCid: ref.cid,
      });

      return { uri: ref.uri, cid: ref.cid };
    },

    [MessageRequest.START_TRAIL_WALK]: async (req, sender) => {
      if (!("trailId" in req)) {
        throw new Error("trailId required");
      }
      const walk = await db.startTrailWalk(req.trailId);
      if (sender.tab?.id) {
        await setTrailWalkTabId(sender.tab.id);
      }

      // Optionally push walk to sidetrail if trail is published
      const session = await getSession();
      if (session) {
        const trail = await db.getTrail(req.trailId);
        if (trail?.sidetrailUri && trail.sidetrailCid) {
          try {
            const walkRef = await startSidetrailWalk(
              session.did,
              trail.sidetrailUri,
              trail.sidetrailCid,
              "stop-0",
            );
            walk.sidetrailWalkUri = walkRef.uri;
            await db.patchTrailWalkById(walk.id, {
              sidetrailWalkUri: walkRef.uri,
            });
          } catch (err) {
            Logger.warn("Failed to start sidetrail walk:", err);
          }
        }
      }

      await broadcastTrailWalkUpdated();
      return walk;
    },

    [MessageRequest.ADVANCE_TRAIL_WALK]: async (req) => {
      if (!("trailId" in req) || !("websiteUrl" in req)) {
        throw new Error("trailId and websiteUrl required");
      }
      const walk = await db.advanceTrailWalk(req.trailId, req.websiteUrl);

      if (walk.sidetrailWalkUri) {
        (async () => {
          const session = await getSession();
          if (!session) return;
          const trail = await db.getTrail(req.trailId);
          if (!trail?.sidetrailUri) return;
          const walkRkey = walk.sidetrailWalkUri.split("/").pop()!;
          const stopIdx = trail.stops.findIndex(
            (s) => s.websiteUrl === req.websiteUrl,
          );
          const visitedTids = Array.from(
            { length: stopIdx + 1 },
            (_, i) => `stop-${i}`,
          );
          await advanceSidetrailWalk(
            session.did,
            walkRkey,
            undefined,
            trail.sidetrailUri,
            trail.sidetrailCid ?? "",
            visitedTids,
          );
        })().catch((err) =>
          Logger.warn("Failed to advance sidetrail walk:", err),
        );
      }

      return walk;
    },

    [MessageRequest.REWIND_TRAIL_WALK]: async (req, sender) => {
      if (!("trailId" in req)) {
        throw new Error("trailId required");
      }
      const walk = await db.rewindTrailWalk(req.trailId);
      if (sender.tab?.id) {
        await setTrailWalkTabId(sender.tab.id);
      }
      await broadcastTrailWalkUpdated();
      return walk;
    },

    [MessageRequest.COMPLETE_TRAIL_WALK]: async (req) => {
      if (!("trailId" in req)) {
        throw new Error("trailId required");
      }
      // Get walk and trail before completing (getTrailWalk filters out completed)
      const [walkBeforeComplete, trail] = await Promise.all([
        db.getTrailWalk(req.trailId),
        db.getTrail(req.trailId),
      ]);

      await db.completeTrailWalk(req.trailId);
      await clearTrailWalkTab();
      await broadcastTrailWalkUpdated();

      // Fire-and-forget sidetrail completion
      if (walkBeforeComplete?.sidetrailWalkUri && trail?.sidetrailUri) {
        (async () => {
          const session = await getSession();
          if (!session) return;
          const walkRkey = walkBeforeComplete.sidetrailWalkUri
            .split("/")
            .pop()!;
          await completeSidetrailWalk(
            session.did,
            walkRkey,
            trail.sidetrailUri,
            trail.sidetrailCid ?? "",
          );
        })().catch((err) =>
          Logger.warn("Failed to complete sidetrail walk:", err),
        );
      }
    },

    [MessageRequest.ABANDON_TRAIL_WALK]: async (req) => {
      if (!("trailId" in req)) {
        throw new Error("trailId required");
      }
      // Get walk before abandoning (abandonTrailWalk deletes the record)
      const walkBeforeAbandon = await db.getTrailWalk(req.trailId);

      await db.abandonTrailWalk(req.trailId);
      await clearTrailWalkTab();
      await broadcastTrailWalkUpdated();

      // Fire-and-forget sidetrail abandon
      if (walkBeforeAbandon?.sidetrailWalkUri) {
        (async () => {
          const session = await getSession();
          if (!session) return;
          const walkRkey = walkBeforeAbandon.sidetrailWalkUri.split("/").pop()!;
          await abandonSidetrailWalk(session.did, walkRkey);
        })().catch((err) =>
          Logger.warn("Failed to abandon sidetrail walk:", err),
        );
      }
    },

    [MessageRequest.GET_TRAIL_WALK_STATE]: async (req) => {
      if (!("trailId" in req)) {
        throw new Error("trailId required");
      }
      const trail = await db.getTrail(req.trailId);
      const walk = await db.getTrailWalk(req.trailId);
      const websites = trail
        ? await db.getAllWebsitesForRabbithole(trail.rabbitholeId)
        : [];
      return { trail, walk, websites };
    },

    [MessageRequest.GET_TRAIL_WALK_TAB]: async () => {
      return { tabId: await getTrailWalkTabId() };
    },

    [MessageRequest.FOCUS_TRAIL_TAB]: async (req) => {
      return focusOrOpenTrailTab("url" in req ? req.url : undefined);
    },

    [MessageRequest.OPEN_TABS]: async (req) => {
      if (!("urls" in req)) {
        throw new Error("urls required");
      }
      req.urls.forEach((url: string) => {
        chrome.tabs.create({ url });
      });
      return { success: true };
    },

    [MessageRequest.IMPORT_DATA]: async (req) => {
      if (!("rabbitholes" in req && "websites" in req)) {
        throw new Error("projects required");
      }

      const burrowsToImport = (req as any).burrows as (Burrow & {
        savedWebsites?: string[];
      })[];
      const websitesToImport = (req as any).websites || [];
      const rabbitholesToImport = ((req as any).rabbitholes || []) as any[];

      if (websitesToImport.length > 0) {
        await db.saveWebsites(websitesToImport);
      }

      const existingBurrows = await db.getAllBurrows();
      const allWebsites = await db.getAllWebsites();

      const existingUrls = new Set(allWebsites.map((w) => w.url));
      const existingBurrowMap = new Map<string, Burrow>(
        existingBurrows.map((b) => [b.name, b]),
      );
      const oldIdToNewId = new Map<string, string>();

      for (const burrow of burrowsToImport) {
        const missingWebsites: any[] = [];
        const websites = burrow.websites ?? burrow.savedWebsites ?? [];
        if (websites) {
          for (const url of websites) {
            if (!existingUrls.has(url)) {
              missingWebsites.push({
                url,
                name: url,
                savedAt: Date.now(),
                faviconUrl: "",
                description: "Imported",
              });
              existingUrls.add(url);
            }
          }
        }

        if (missingWebsites.length > 0) {
          await db.saveWebsites(missingWebsites);
        }

        let burrowName = burrow.name;
        const existingBurrow = existingBurrowMap.get(burrowName);

        if (existingBurrow) {
          const existingWebsites = new Set(existingBurrow.websites);
          const newWebsites = new Set(websites);

          let isConsistent = existingWebsites.size === newWebsites.size;
          if (isConsistent) {
            for (const w of newWebsites) {
              if (!existingWebsites.has(w)) {
                isConsistent = false;
                break;
              }
            }
          }

          if (isConsistent) {
            oldIdToNewId.set(burrow.id, existingBurrow.id);
            continue;
          } else {
            let counter = 1;
            while (existingBurrowMap.has(burrowName)) {
              burrowName = `${burrow.name} (${counter})`;
              counter++;
            }
          }
        }

        const newBurrow = await db.createNewActiveBurrow(burrowName, websites);
        oldIdToNewId.set(burrow.id, newBurrow.id);

        existingBurrowMap.set(burrowName, {
          id: newBurrow.id,
          createdAt: Date.now(),
          name: burrowName,
          websites: websites,
        } as any);
      }

      // Import Rabbitholes
      const existingRabbitholes = await db.getAllRabbitholes();
      const existingRabbitholeMap = new Map(
        existingRabbitholes.map((r) => [r.title, r]),
      );

      for (const rh of rabbitholesToImport) {
        const metaUrls: string[] = rh.meta || [];
        const existing = existingRabbitholeMap.get(rh.title);

        let rhId: string;
        if (existing) {
          rhId = existing.id;
          if ((existing.meta || []).length > 0) continue;
        } else {
          const newRh = await db.createNewActiveRabbithole(
            rh.title,
            rh.description,
          );
          rhId = newRh.id;

          const newBurrowIds = (rh.burrows || [])
            .map((oldId: string) => oldIdToNewId.get(oldId))
            .filter((id: string | undefined) => id !== undefined);
          if (newBurrowIds.length > 0) {
            await db.addBurrowsToRabbithole(rhId, newBurrowIds);
          }
        }

        if (metaUrls.length > 0) {
          await db.addWebsitesToRabbitholeMeta(rhId, metaUrls);
        }

        const activeTabUrls: string[] = rh.activeTabs || [];
        if (activeTabUrls.length > 0) {
          await db.updateRabbitholeActiveTabs(rhId, activeTabUrls);
        }
      }

      return { success: true };
    },

    [MessageRequest.IMPORT_BROWSER_DATA]: async (req) => {
      const { importBookmarks, importTabGroups } = req as any;
      if (importBookmarks) {
        await importBookmarksFromBrowser(db);
      }
      if (importTabGroups) {
        await importTabGroupsFromBrowser(db);
      }
      return { success: true };
    },

    [MessageRequest.TOGGLE_BURROW_SYNC]: async (req) => {
      if (!("burrowId" in req) || !("enabled" in req)) {
        throw new Error("burrowId and enabled required");
      }

      const burrow = await db.getBurrow(req.burrowId);

      if (req.enabled) {
        if (burrow.sembleCollectionUri) {
          // Already published — just do a full push to catch up
          const session = await getSession();
          if (!session) {
            throw new Error("Not logged in");
          }
          const websites = await db.getAllWebsitesForBurrow(req.burrowId);
          await syncBurrowToCollection(
            session.did,
            burrow.sembleCollectionUri,
            websites,
          );
          await db.updateBurrowSembleInfo(
            req.burrowId,
            burrow.sembleCollectionUri,
            Date.now(),
          );
        }
        // If no sembleCollectionUri, the UI will handle the publish flow
      }

      await db.setBurrowSyncEnabled(req.burrowId, req.enabled);
      return { success: true };
    },

    [MessageRequest.PROPOSE_CATEGORISE]: async (req) => {
      const cloudConfig = (req as any).cloudConfig;
      const allTabs = await chrome.tabs.query({});
      const tabs: TabInfo[] = allTabs
        .filter((t) => isValidWebUrl(t.url))
        .map((t) => ({
          title: t.title ?? "",
          url: t.url ?? "",
          tabId: t.id,
          favIconUrl: t.favIconUrl,
          windowId: t.windowId,
          groupId: t.groupId,
        }));

      if (tabs.length === 0) {
        return { error: "No tabs to categorise" };
      }

      const rholes = await db.getAllRabbitholes();
      const existingRabbitholes: RabbitholeContext[] = [];

      for (const rh of rholes) {
        const websites: Website[] = [];
        for (const url of (rh.meta ?? []).slice(0, 10)) {
          const w = await db.getWebsite(url);
          if (w) websites.push(w);
        }
        const content = websites.map((w) => `  - ${w.name}`).join("\n");
        existingRabbitholes.push({
          id: rh.id,
          title: rh.title,
          content,
        });
      }

      // Tab groups the user already made are explicit rabbitholes — seed
      // candidates from them before the LLM proposes more
      const groupCandidates: Candidate[] = [];
      const groupIds = new Set(
        tabs
          .map((t) => t.groupId)
          .filter((id): id is number => id != null && id !== -1),
      );
      if (groupIds.size > 0) {
        const groups = await chrome.tabGroups.query({});
        const groupTitleById = new Map(
          groups.map((g) => [g.id, g.title?.trim() || "Untitled group"]),
        );
        for (const gid of groupIds) {
          const indices: number[] = [];
          tabs.forEach((t, i) => {
            if (t.groupId === gid) {
              indices.push(i);
            }
          });
          if (indices.length === 0) continue;
          const title = groupTitleById.get(gid) ?? "Untitled group";
          groupCandidates.push({
            key: `group-${gid}`,
            title,
            description: `Browser tab group "${title}"`,
            userAdded: true,
          });
        }
      }

      // collect og descriptions from live pages — thin titles like "Blog"
      // or "Sign in" get a real description for the Jev questions.
      // frozen/discarded tabs never answer, so race each tab against a
      // 2s timeout instead of waiting on chrome's internal one
      if (EnrichTabsWithOgMetadata) {
        const ogTimeoutMs = 2000;
        const withTimeout = (p: Promise<unknown>): Promise<unknown> =>
          Promise.race([
            p,
            new Promise((resolve) =>
              setTimeout(() => resolve(null), ogTimeoutMs),
            ),
          ]);
        const ogResults = await Promise.allSettled(
          tabs.map((t) =>
            t.tabId != null
              ? withTimeout(
                  chrome.tabs.sendMessage(t.tabId, {
                    type: MessageRequest.GET_OG_METADATA,
                  }),
                )
              : Promise.resolve(null),
          ),
        );
        tabs.forEach((t, i) => {
          const og = ogResults[i];
          if (og.status === "fulfilled" && og.value?.description) {
            t.ogDescription = og.value.description;
          }
        });
      }

      const result = await runCategorisePipeline({
        tabs,
        existingRabbitholes,
        fixedCandidates: groupCandidates,
        cloudConfig,
      });
      return {
        tabs,
        candidates: result.candidates,
        assignments: result.assignments,
      };
    },

    [MessageRequest.RUN_ASSIGNMENT]: async (req) => {
      const { tabs, candidates } = req as {
        tabs: TabInfo[];
        candidates: Candidate[];
      };
      const result = await runJevAssignment({ tabs, candidates });
      const assignments: Record<string, number[]> = {};
      for (const [key, indices] of result.assignments) {
        assignments[key] = indices;
      }
      return { tabs, candidates, assignments };
    },

    [MessageRequest.APPLY_CATEGORISE]: async (req) => {
      const { assignments, newRabbitholes, tabs } = req as {
        assignments: { rabbitholeId: string; tabIndices: number[] }[];
        newRabbitholes: {
          topic: string;
          description: string;
          tabIndices: number[];
        }[];
        tabs: TabInfo[];
      };
      // one table read for the whole apply — records that already have
      // real metadata are preserved; bare stubs left by older categorise
      // runs get re-fetched so they heal
      const existingWebsites = await db.getAllWebsites();
      const rich = new Set(
        existingWebsites
          .filter((w) => w.name && w.name !== w.url)
          .map((w) => w.url),
      );

      // same OG-fetching save flow as a normal tab save — bare stubs
      // would leave cards with no title/image/description
      const saveStubs = async (indices: number[]): Promise<string[]> => {
        const assignedTabs = (tabs ?? [])
          .filter((_, i) => indices.includes(i))
          .filter((t) => isValidWebUrl(t.url))
          .map(
            (t) =>
              ({
                url: t.url,
                title: t.title,
                favIconUrl: t.favIconUrl,
              }) as chrome.tabs.Tab,
          );
        if (assignedTabs.length === 0) {
          return [];
        }
        const fresh = assignedTabs.filter((t) => !rich.has(t.url ?? ""));
        if (fresh.length > 0) {
          await storeWebsites(fresh, db);
          // mark saved URLs so a URL appearing in two groups isn't
          // fetched twice
          fresh.forEach((t) => rich.add(t.url ?? ""));
        }
        return assignedTabs.map((t) => t.url ?? "");
      };

      for (const nr of newRabbitholes ?? []) {
        const urls = await saveStubs(nr.tabIndices);
        if (urls.length === 0) {
          continue;
        }
        const created = await db.createRabbithole(nr.topic, nr.description);
        await db.addWebsitesToRabbitholeMeta(created.id, urls);
      }

      for (const a of assignments ?? []) {
        const urls = await saveStubs(a.tabIndices);
        if (urls.length === 0) {
          continue;
        }
        await db.addWebsitesToRabbitholeMeta(a.rabbitholeId, urls);
      }

      return { success: true };
    },

    [MessageRequest.FLUSH_SYNC_OPS]: async (req) => {
      if (!("burrowId" in req)) {
        throw new Error("burrowId required");
      }

      const burrow = await db.getBurrow(req.burrowId);
      if (!burrow.syncEnabled || !burrow.sembleCollectionUri) {
        return { success: true, opsProcessed: 0 };
      }

      const session = await getSession();
      if (!session) {
        throw new Error("Not logged in");
      }

      const ops = await db.getPendingSyncOps(req.burrowId);
      if (!ops.length) {
        return { success: true, opsProcessed: 0 };
      }

      // Fallback to full sync — incremental is a future optimization
      const websites = await db.getAllWebsitesForBurrow(req.burrowId);
      await syncBurrowToCollection(
        session.did,
        burrow.sembleCollectionUri,
        websites,
      );

      await db.markSyncOpsSynced(ops.map((op) => op.id));
      await db.updateBurrowSembleInfo(
        req.burrowId,
        burrow.sembleCollectionUri,
        Date.now(),
      );

      return { success: true, opsProcessed: ops.length };
    },
  };

  const handler = handlers[request.type as MessageRequest];
  if (handler) {
    // Ensure PostHog is initialized (service worker may have restarted)
    ensureAnalyticsInit().then(() => {
      handle(sendResponse, handler, request, sender);
    });
  } else {
    Logger.warn(`Unknown message type: ${request.type}`);
  }

  // arcane incantation required for async `sendResponse`s to work
  // https://developer.chrome.com/docs/extensions/mv3/messaging/#simple
  return true;
});
