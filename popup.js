// ─── i18n ─────────────────────────────────────────────────────────────────────

function initI18n() {
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const key = el.dataset.i18n;
    const attr = el.dataset.i18nAttr;
    const msg = chrome.i18n.getMessage(key);
    if (!msg) continue;
    if (attr) el.setAttribute(attr, msg);
    else el.textContent = msg;
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  enabled: true,
  inactivityThresholdMs: 3_600_000,
  checkIntervalMinutes: 15,
};

// Preset threshold values in ms
const THRESHOLD_PRESETS = new Set([1_800_000, 3_600_000, 7_200_000, 14_400_000]);
// Preset interval values in minutes
const INTERVAL_PRESETS = new Set([5, 15, 30, 60]);

// ─── DOM references (resolved once on load) ───────────────────────────────────

const elToggle = /** @type {HTMLInputElement} */ (document.getElementById("toggle-enabled"));
const elStatTotal = document.getElementById("stat-total");
const elStatToClose = document.getElementById("stat-to-close");
const elPillsThreshold = document.getElementById("pills-threshold");
const elPillsInterval = document.getElementById("pills-interval");
const elBtnRun = document.getElementById("btn-run");
const elLastRun = document.getElementById("last-run");
const elToast = document.getElementById("toast");
const elThresholdCustomWrapper = document.getElementById("threshold-custom-wrapper");
const elThresholdCustomTrigger = document.getElementById("threshold-custom-trigger");
const elThresholdCustomInput = /** @type {HTMLInputElement} */ (document.getElementById("threshold-custom-input"));

// ─── Settings state ───────────────────────────────────────────────────────────

let currentSettings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
  const { settings } = await chrome.storage.sync.get({ settings: {} });
  currentSettings = { ...DEFAULT_SETTINGS, ...settings };
}

async function saveSettings() {
  await chrome.storage.sync.set({ settings: currentSettings });
}

// ─── Stats display ────────────────────────────────────────────────────────────

function updateStats(stats) {
  elStatTotal.textContent = stats.totalTabs;
  elStatToClose.textContent = stats.tabsToClose;
  elStatToClose.className = `stat-value ${stats.tabsToClose > 0 ? "warning" : "neutral"}`;
  elLastRun.textContent = formatLastRun(stats.lastRunTimestamp);
}

function formatLastRun(timestamp) {
  if (!timestamp) return chrome.i18n.getMessage("last_run_never");
  const diffMs = Date.now() - timestamp;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return chrome.i18n.getMessage("last_run_just_now");
  if (diffMin === 1) return chrome.i18n.getMessage("last_run_one_minute");
  if (diffMin < 60) return chrome.i18n.getMessage("last_run_n_minutes", [String(diffMin)]);
  const diffH = Math.floor(diffMin / 60);
  if (diffH === 1) return chrome.i18n.getMessage("last_run_one_hour");
  return chrome.i18n.getMessage("last_run_n_hours", [String(diffH)]);
}

// ─── Pills renderer ───────────────────────────────────────────────────────────

function highlightThresholdPill(currentValue) {
  const isCustom = !THRESHOLD_PRESETS.has(currentValue);
  for (const pill of elPillsThreshold.querySelectorAll(".pill[data-value]")) {
    pill.classList.toggle("active", Number(pill.dataset.value) === currentValue);
  }
  elThresholdCustomWrapper.classList.toggle("active", isCustom);
  if (isCustom) {
    elThresholdCustomWrapper.classList.add("expanded");
    elThresholdCustomInput.value = String(Math.round(currentValue / 60_000));
  }
}

function collapseCustomThreshold() {
  elThresholdCustomWrapper.classList.remove("active", "expanded");
  elThresholdCustomInput.value = "";
}

function highlightIntervalPill(currentValue) {
  for (const pill of elPillsInterval.querySelectorAll(".pill[data-value]")) {
    pill.classList.toggle("active", Number(pill.dataset.value) === currentValue);
  }
}

// ─── Toggle ───────────────────────────────────────────────────────────────────

elToggle.addEventListener("change", () => {
  currentSettings.enabled = elToggle.checked;
  saveSettings();
});

// ─── Custom threshold pill ────────────────────────────────────────────────────

elThresholdCustomTrigger.addEventListener("click", () => {
  // Deactivate preset pills
  for (const pill of elPillsThreshold.querySelectorAll(".pill[data-value]")) {
    pill.classList.remove("active");
  }
  elThresholdCustomWrapper.classList.add("active", "expanded");
  elThresholdCustomInput.focus();
});

elThresholdCustomInput.addEventListener("change", () => {
  const minutes = parseInt(elThresholdCustomInput.value, 10);
  if (isNaN(minutes) || minutes < 1) return;
  currentSettings.inactivityThresholdMs = minutes * 60_000;
  saveSettings();
});

// ─── Run now button ───────────────────────────────────────────────────────────

elBtnRun.addEventListener("click", async () => {
  elBtnRun.disabled = true;
  elBtnRun.textContent = chrome.i18n.getMessage("toast_running");

  try {
    const response = await chrome.runtime.sendMessage({ type: "runNow" });
    if (!response?.ok) throw new Error(response?.error ?? "Erreur inconnue");
    showToast(chrome.i18n.getMessage("toast_done"), "success");

    // Refresh stats after cleanup
    const stats = await chrome.runtime.sendMessage({ type: "getStats" });
    updateStats(stats);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    showToast(detail || chrome.i18n.getMessage("toast_error"), "");
  } finally {
    elBtnRun.disabled = false;
    elBtnRun.textContent = chrome.i18n.getMessage("btn_run_now");
  }
});

// ─── Toast ────────────────────────────────────────────────────────────────────

let toastTimer = null;

function showToast(message, type) {
  elToast.textContent = message;
  elToast.className = `toast${type ? ` ${type}` : ""}`;

  // Force reflow to restart transition
  void elToast.offsetWidth;
  elToast.classList.add("show");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    elToast.classList.remove("show");
  }, 2500);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  initI18n();
  await loadSettings();

  // Apply toggle state
  elToggle.checked = currentSettings.enabled;

  // Register pill listeners once
  for (const pill of elPillsThreshold.querySelectorAll(".pill[data-value]")) {
    pill.addEventListener("click", () => {
      currentSettings.inactivityThresholdMs = Number(pill.dataset.value);
      saveSettings();
      collapseCustomThreshold();
      highlightThresholdPill(currentSettings.inactivityThresholdMs);
    });
  }
  for (const pill of elPillsInterval.querySelectorAll(".pill[data-value]")) {
    pill.addEventListener("click", () => {
      currentSettings.checkIntervalMinutes = Number(pill.dataset.value);
      saveSettings();
      highlightIntervalPill(currentSettings.checkIntervalMinutes);
    });
  }

  // Set initial active state
  highlightThresholdPill(currentSettings.inactivityThresholdMs);
  highlightIntervalPill(currentSettings.checkIntervalMinutes);

  // Load stats from background
  try {
    const stats = await chrome.runtime.sendMessage({ type: "getStats" });
    updateStats(stats);
  } catch {
    elStatTotal.textContent = "—";
    elStatToClose.textContent = "—";
  }
}

init();
