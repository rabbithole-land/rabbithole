export enum LogLevel {
  DEBUG = "DEBUG",
  INFO = "INFO",
  WARN = "WARN",
  ERROR = "ERROR",
}

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
  data?: any;
  context: string;
}

const MAX_LOGS = 1000;
const LOG_STORAGE_KEY = "rabbithole_logs";

function getContext(): string {
  if (typeof chrome === "undefined" || !chrome.runtime) return "unknown";
  if (typeof window === "undefined") return "background";
  const url = window.location.href;
  if (url.includes("popup")) return "popup";
  if (url.includes("options")) return "options";
  if (url.includes("newtab")) return "newtab";
  return "content";
}

async function saveLog(level: LogLevel, message: string, data?: any) {
  // Uncomment for dev
  const consoleMsg = `[${level}] ${message}`;
  if (level === LogLevel.ERROR) {
    console.error(consoleMsg, data ?? "");
  } else if (level === LogLevel.WARN) {
    console.warn(consoleMsg, data ?? "");
  } else {
    console.log(consoleMsg, data ?? "");
  }

  try {
    // persistent logging is opt-in — console output above always happens
    const { loggingEnabled } = await chrome.storage.local.get("loggingEnabled");
    if (loggingEnabled !== true) {
      return;
    }

    const result = await chrome.storage.local.get(LOG_STORAGE_KEY);
    let logs: LogEntry[] = result[LOG_STORAGE_KEY] || [];

    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      message,
      data,
      context: getContext(),
    };

    logs.push(entry);

    // Rolling buffer to prevent storage quota issues
    if (logs.length > MAX_LOGS) {
      logs = logs.slice(logs.length - MAX_LOGS);
    }

    await chrome.storage.local.set({ [LOG_STORAGE_KEY]: logs });
  } catch (e) {
    console.error("Logger failed to save to storage", e);
  }
}

export const debug = (message: string, data?: any) =>
  saveLog(LogLevel.DEBUG, message, data);
export const info = (message: string, data?: any) =>
  saveLog(LogLevel.INFO, message, data);
export const warn = (message: string, data?: any) =>
  saveLog(LogLevel.WARN, message, data);
export const error = (message: string, data?: any) =>
  saveLog(LogLevel.ERROR, message, data);

export const getLogs = async (): Promise<LogEntry[]> => {
  const result = await chrome.storage.local.get(LOG_STORAGE_KEY);
  return result[LOG_STORAGE_KEY] || [];
};

export const clearLogs = async (): Promise<void> => {
  await chrome.storage.local.remove(LOG_STORAGE_KEY);
};

export const downloadLogs = async (): Promise<void> => {
  if (typeof document === "undefined") {
    console.error("Cannot download logs from background context");
    return;
  }
  const logs = await getLogs();
  const blob = new Blob([JSON.stringify(logs, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `rabbithole-logs-${new Date().toISOString()}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};
