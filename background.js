// ─── Constants ────────────────────────────────────────────────────────────────

const ALARM_CLEANUP = "cleanup";
const ALARM_WEEKLY = "weeklyCleanup";
const BOOKMARK_ROOT_NAME = "TabCleaner";

const DEFAULT_SETTINGS = {
  enabled: true,
  inactivityThresholdMs: 3_600_000, // 1 hour
  checkIntervalMinutes: 15,
};

// ─── Settings ─────────────────────────────────────────────────────────────────

/**
 * Loads settings from sync storage, merging with defaults.
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
async function getSettings() {
  const { settings } = await chrome.storage.sync.get({ settings: {} });
  return { ...DEFAULT_SETTINGS, ...settings };
}

// ─── Alarm management ─────────────────────────────────────────────────────────

/**
 * Creates or updates alarms based on current settings.
 * Idempotent: safe to call multiple times.
 * @param {typeof DEFAULT_SETTINGS} settings
 */
async function ensureAlarmsExist(settings) {
  const [cleanupAlarm, weeklyAlarm] = await Promise.all([
    chrome.alarms.get(ALARM_CLEANUP),
    chrome.alarms.get(ALARM_WEEKLY),
  ]);

  if (!cleanupAlarm || cleanupAlarm.periodInMinutes !== settings.checkIntervalMinutes) {
    await chrome.alarms.create(ALARM_CLEANUP, {
      delayInMinutes: settings.checkIntervalMinutes,
      periodInMinutes: settings.checkIntervalMinutes,
    });
  }

  if (!weeklyAlarm) {
    await chrome.alarms.create(ALARM_WEEKLY, {
      delayInMinutes: 10_080,
      periodInMinutes: 10_080,
    });
  }
}

// ─── Tab access tracking ──────────────────────────────────────────────────────

/**
 * Records the current timestamp for a tab as its last access time.
 * @param {number} tabId
 */
async function trackTabAccess(tabId) {
  const { tabAccessTimes } = await chrome.storage.local.get({ tabAccessTimes: {} });
  tabAccessTimes[tabId] = Date.now();
  await chrome.storage.local.set({ tabAccessTimes });
}

// ─── Bookmark folder management ───────────────────────────────────────────────

/**
 * Finds an existing bookmark folder by name under a given parent,
 * or creates it if it doesn't exist.
 * @param {string} parentId
 * @param {string} name
 * @returns {Promise<string>} The folder's bookmark ID
 */
async function findOrCreateFolder(parentId, name) {
  const children = await chrome.bookmarks.getChildren(parentId);
  const existing = children.find((node) => node.title === name && !node.url);
  if (existing) return existing.id;

  const created = await chrome.bookmarks.create({ parentId, title: name });
  return created.id;
}

/**
 * Returns the ID of the TabCleaner root bookmark folder, creating it if needed.
 * Caches the ID in local storage to avoid repeated searches.
 * @returns {Promise<string>}
 */
async function getOrCreateRootFolder() {
  const { tabCleanerFolderId } = await chrome.storage.local.get({ tabCleanerFolderId: null });

  // Verify cached ID still points to a valid folder
  if (tabCleanerFolderId) {
    try {
      const nodes = await chrome.bookmarks.get(tabCleanerFolderId);
      if (nodes.length > 0 && !nodes[0].url) return tabCleanerFolderId;
    } catch {
      // Folder was deleted; fall through to recreate
    }
  }

  // Search for an existing TabCleaner folder anywhere in the tree
  const results = await chrome.bookmarks.search({ title: BOOKMARK_ROOT_NAME });
  const existing = results.find((node) => !node.url);
  if (existing) {
    await chrome.storage.local.set({ tabCleanerFolderId: existing.id });
    return existing.id;
  }

  // Resolve the parent ID dynamically — never hardcode "2" (varies per profile)
  const [tree] = await chrome.bookmarks.getTree();
  const rootChildren = tree.children ?? [];
  // rootChildren[1] is traditionally "Other Bookmarks"; fall back to first available
  const parent = rootChildren[1] ?? rootChildren[0];
  if (!parent) throw new Error("No bookmark root folder found");

  const created = await chrome.bookmarks.create({ parentId: parent.id, title: BOOKMARK_ROOT_NAME });
  const folderId = created.id;

  await chrome.storage.local.set({ tabCleanerFolderId: folderId });
  return folderId;
}

/**
 * Returns today's date string as "YYYY-MM-DD".
 * @returns {string}
 */
function todayString() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Core cleanup ─────────────────────────────────────────────────────────────

/**
 * Saves a tab to bookmarks then closes it.
 * If the bookmark fails, the tab is NOT closed (safety first).
 * @param {chrome.tabs.Tab} tab
 * @param {string} folderId  Bookmark folder ID for today's date
 */
async function bookmarkAndClose(tab, folderId) {
  try {
    await chrome.bookmarks.create({
      parentId: folderId,
      title: tab.title || tab.url,
      url: tab.url,
    });
  } catch (err) {
    console.error(`[TabCleaner] Failed to bookmark tab ${tab.id} (${tab.url}):`, err);
    return; // Do not close the tab if bookmarking failed
  }

  try {
    await chrome.tabs.remove(tab.id);
  } catch (err) {
    // Tab may have been closed by the user between our query and now
    console.warn(`[TabCleaner] Could not close tab ${tab.id}:`, err);
  }
}

/**
 * Main cleanup cycle: finds inactive tabs, bookmarks and closes them.
 */
async function runCleanup() {
  const [settings, { tabAccessTimes: storedTimes }, allTabs, activeTabs] = await Promise.all([
    getSettings(),
    chrome.storage.local.get({ tabAccessTimes: {} }),
    chrome.tabs.query({}),
    chrome.tabs.query({ active: true }),
  ]);

  if (!settings.enabled) return;

  const activeTabIds = new Set(activeTabs.map((t) => t.id));
  const now = Date.now();
  const tabAccessTimes = storedTimes ?? {};
  let didUpdate = false;

  // Lazily get the bookmark folder only when we actually need to close a tab
  let todayFolderId = null;
  async function getTodayFolder() {
    if (todayFolderId) return todayFolderId;
    const rootId = await getOrCreateRootFolder();
    todayFolderId = await findOrCreateFolder(rootId, todayString());
    return todayFolderId;
  }

  for (const tab of allTabs) {
    // Skip pinned, active, and internal Chrome pages
    if (
      tab.pinned ||
      activeTabIds.has(tab.id) ||
      tab.url?.startsWith("chrome://") ||
      tab.url?.startsWith("chrome-extension://") ||
      tab.url?.startsWith("about:")
    ) {
      continue;
    }

    const lastAccess = tabAccessTimes[tab.id] ?? null;

    if (lastAccess === null) {
      // First time we see this tab — record it now and skip this cycle.
      // Closing a tab we've never seen is too aggressive.
      tabAccessTimes[tab.id] = now;
      didUpdate = true;
      continue;
    }

    if (now - lastAccess >= settings.inactivityThresholdMs) {
      const folderId = await getTodayFolder();
      await bookmarkAndClose(tab, folderId);
      delete tabAccessTimes[tab.id];
      didUpdate = true;
    }
  }

  // Purge entries for tabs that no longer exist (closed manually)
  const liveTabIds = new Set(allTabs.map((t) => String(t.id)));
  for (const key of Object.keys(tabAccessTimes)) {
    if (!liveTabIds.has(key)) {
      delete tabAccessTimes[key];
      didUpdate = true;
    }
  }

  await chrome.storage.local.set({
    tabAccessTimes,
    lastRunTimestamp: now,
  });
}

// ─── Weekly bookmark cleanup ──────────────────────────────────────────────────

/**
 * Removes date sub-folders in the TabCleaner folder that are older than 7 days.
 */
async function runBookmarkCleanup() {
  let rootId;
  try {
    rootId = await getOrCreateRootFolder();
  } catch (err) {
    console.error("[TabCleaner] Weekly cleanup: could not find root folder:", err);
    return;
  }

  const children = await chrome.bookmarks.getChildren(rootId);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (const child of children) {
    if (child.url) continue; // Skip any accidentally created bookmarks

    // Folder titles are expected to be "YYYY-MM-DD"
    const folderDate = new Date(child.title).getTime();
    if (!isNaN(folderDate) && folderDate < cutoff) {
      try {
        await chrome.bookmarks.removeTree(child.id);
      } catch (err) {
        console.warn(`[TabCleaner] Could not remove old folder "${child.title}":`, err);
      }
    }
  }
}

// ─── Stats ────────────────────────────────────────────────────────────────────

/**
 * Computes stats for display in the popup.
 * @param {typeof DEFAULT_SETTINGS} settings
 * @returns {Promise<{ totalTabs: number, tabsToClose: number, lastRunTimestamp: number|null }>}
 */
async function getStats(settings) {
  const [allTabs, activeTabs, { tabAccessTimes, lastRunTimestamp }] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabs.query({ active: true }),
    chrome.storage.local.get({ tabAccessTimes: {}, lastRunTimestamp: null }),
  ]);

  const activeTabIds = new Set(activeTabs.map((t) => t.id));
  const now = Date.now();
  let tabsToClose = 0;

  for (const tab of allTabs) {
    if (
      tab.pinned ||
      activeTabIds.has(tab.id) ||
      tab.url?.startsWith("chrome://") ||
      tab.url?.startsWith("chrome-extension://") ||
      tab.url?.startsWith("about:")
    ) {
      continue;
    }

    const lastAccess = tabAccessTimes[tab.id] ?? null;
    if (lastAccess !== null && now - lastAccess >= settings.inactivityThresholdMs) {
      tabsToClose++;
    }
  }

  return {
    totalTabs: allTabs.length,
    tabsToClose,
    lastRunTimestamp: lastRunTimestamp ?? null,
  };
}

// ─── Top-level listeners (must be synchronous, MV3 requirement) ───────────────

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const settings = await getSettings();
    await chrome.storage.sync.set({ settings });
    await ensureAlarmsExist(settings);
  } catch (err) {
    console.error("[TabCleaner] onInstalled failed:", err);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    const settings = await getSettings();
    await ensureAlarmsExist(settings);
  } catch (err) {
    console.error("[TabCleaner] onStartup failed:", err);
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  trackTabAccess(tabId).catch((err) => console.error("[TabCleaner] trackTabAccess failed:", err));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") {
    trackTabAccess(tabId).catch((err) => console.error("[TabCleaner] trackTabAccess failed:", err));
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_CLEANUP) {
    runCleanup().catch((err) => console.error("[TabCleaner] runCleanup failed:", err));
  } else if (alarm.name === ALARM_WEEKLY) {
    runBookmarkCleanup().catch((err) => console.error("[TabCleaner] runBookmarkCleanup failed:", err));
  }
});

// Recreate cleanup alarm if interval setting changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.settings) return;
  const newSettings = changes.settings.newValue;
  if (!newSettings) return;

  const merged = { ...DEFAULT_SETTINGS, ...newSettings };
  const old = changes.settings.oldValue ?? {};
  if (merged.checkIntervalMinutes !== (old.checkIntervalMinutes ?? DEFAULT_SETTINGS.checkIntervalMinutes)) {
    chrome.alarms.create(ALARM_CLEANUP, {
      delayInMinutes: merged.checkIntervalMinutes,
      periodInMinutes: merged.checkIntervalMinutes,
    }).catch((err) => console.error("[TabCleaner] onChanged alarm creation failed:", err));
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "getStats") {
    getSettings()
      .then((settings) => getStats(settings))
      .then((stats) => sendResponse(stats))
      .catch((err) => {
        console.error("[TabCleaner] getStats failed:", err);
        sendResponse({ totalTabs: 0, tabsToClose: 0, lastRunTimestamp: null });
      });
    return true;
  }

  if (message.type === "runNow") {
    runCleanup()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error("[TabCleaner] runCleanup failed:", err);
        sendResponse({ ok: false, error: String(err) });
      });
    return true;
  }
});
