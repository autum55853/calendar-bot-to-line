// 真實推播煙霧測試：把 Code.gs 的各類通知「真的」推到 LINE，但只會送給 OWNER_USER_ID。
// 用法：node scripts/live-smoke.js   （讀專案根目錄 .env；需要 LINE_ACCESS_TOKEN、OWNER_USER_ID）
// 安全：CONTACT_USER_ID 在此被換成佔位值，且所有非 OWNER 的請求由 owner-only-fetch 攔截。
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { makeOwnerOnlyFetch } = require("./lib/owner-only-fetch");

const ROOT = path.join(__dirname, "..");
process.loadEnvFile(path.join(ROOT, ".env"));
const missing = ["LINE_ACCESS_TOKEN", "OWNER_USER_ID"].filter((k) => !(process.env[k] || "").trim());
if (missing.length) throw new Error("Missing env vars: " + missing.join(", "));
const TOKEN = process.env.LINE_ACCESS_TOKEN.trim();
const OWNER = process.env.OWNER_USER_ID.trim();

// UrlFetchApp 是同步 API；用 curl 同步送出。token 走 stdin 設定檔避免出現在 process 參數列，payload 寫暫存檔
function postWithPayload(url, options) {
  const tmp = path.join(process.env.TMPDIR || require("node:os").tmpdir(), `live-smoke-${process.pid}.json`);
  fs.writeFileSync(tmp, options.payload, { mode: 0o600 });
  try {
    const cfg = `header = "Authorization: Bearer ${TOKEN}"\nheader = "Content-Type: application/json"\n`;
    const out = execFileSync("curl", ["-sS", "-m", "20", "-w", "\n%{http_code}", "-X", "POST", "--config", "-", "--data-binary", "@" + tmp, url], {
      input: cfg,
      encoding: "utf8",
    });
    const i = out.lastIndexOf("\n");
    return { code: Number(out.slice(i + 1)), text: out.slice(0, i) };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const guard = makeOwnerOnlyFetch(OWNER, postWithPayload);

const store = {
  LINE_ACCESS_TOKEN: TOKEN,
  OWNER_USER_ID: OWNER,
  CONTACT_USER_ID: "U_SMOKE_PLACEHOLDER_NOT_REAL", // 走完整流程但會被 guard 攔截
  CALENDAR_IDS: "smoke-cal",
};
const cache = new Map();
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const events = [];

const sandbox = {
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => store[k] ?? null, setProperty: (k, v) => (store[k] = v) }) },
  CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) || null, put: (k, v) => cache.set(k, v), remove: (k) => cache.delete(k) }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  UrlFetchApp: {
    fetch(url, options) {
      const r = guard.fetch(url, options);
      return { getResponseCode: () => r.code, getContentText: () => r.text };
    },
  },
  Utilities: {
    formatDate: (d, tz, p) => {
      const f = Object.fromEntries(
        new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
          .formatToParts(d)
          .map((x) => [x.type, x.value]),
      );
      return p.replace("yyyy", f.year).replace("MM", f.month).replace("dd", f.day).replace("HH", f.hour).replace("mm", f.minute);
    },
  },
  Logger: { log: () => {} },
  ContentService: { MimeType: {}, createTextOutput: (s) => ({ s, setMimeType() { return this; } }) },
  Calendar: { Events: { list: () => ({ items: events, nextSyncToken: "n" }), insert: () => ({ id: "x" }) } },
  HtmlService: {},
  ScriptApp: {},
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "Code.gs"), "utf8"), sandbox);

const step = (name, fn) => {
  const before = guard.sent.length;
  try {
    fn();
    console.log(`✓ ${name}（送出 ${guard.sent.length - before} 則）`);
  } catch (e) {
    console.log(`✗ ${name}：${e.message}`);
    process.exitCode = 1;
  }
};

// 1. 新增 / 修改 / 刪除 通知（走 onCalendarChange 完整流程，contact 部分被攔截）
const base = { start: { dateTime: iso(3600e3) }, end: { dateTime: iso(7200e3) } };
step("新行程通知", () => {
  events.length = 0;
  events.push({ id: "smoke-new", summary: "煙霧測試-新增", status: "confirmed", created: iso(0), updated: iso(0), ...base });
  sandbox.onCalendarChange({ calendarId: "smoke-cal" });
});
step("修改行程通知", () => {
  events.length = 0;
  events.push({ id: "smoke-mod", summary: "煙霧測試-修改", status: "confirmed", created: iso(-3600e3), updated: iso(0), ...base });
  sandbox.onCalendarChange({ calendarId: "smoke-cal" });
});
step("刪除行程通知", () => {
  events.length = 0;
  events.push({ id: "smoke-del", summary: "煙霧測試-刪除", status: "cancelled", updated: iso(0), ...base });
  sandbox.onCalendarChange({ calendarId: "smoke-cal" });
});

// 2. 每日提醒（明天 10:00 的假行程）
step("每日提醒", () => {
  const { start } = sandbox._getTomorrowRange();
  const t = new Date(start.getTime() + 10 * 3600e3).toISOString();
  events.length = 0;
  events.push({ id: "smoke-daily", summary: "煙霧測試-明日行程", start: { dateTime: t }, end: { dateTime: t } });
  sandbox.sendDailyReminders();
});

// 3. 異常告警
step("異常告警 _alertOwner", () => sandbox._alertOwner("live-smoke", new Error("這是煙霧測試告警")));

console.log(`\n實際送出給 OWNER：${guard.sent.length} 則；被攔截（非 OWNER / 非 push）：${guard.blocked.length} 則`);
const leaked = guard.sent.filter((s) => s.to !== OWNER);
if (leaked.length) {
  console.log("✗ 偵測到送給非 OWNER 的訊息！");
  process.exitCode = 1;
}
const failed = guard.sent.filter((s) => s.code !== 200);
if (failed.length) {
  console.log(`✗ ${failed.length} 則 LINE 回應非 200`);
  process.exitCode = 1;
}
