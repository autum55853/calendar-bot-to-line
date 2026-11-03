// 本地測試：以 vm 載入 Code.gs 並 mock Apps Script 全域。
// 執行：node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const OWNER = "Uowner";
const CONTACT = "Ucontact";
const STRANGER = "Ustranger";

function formatDate(date, tz, pattern) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return pattern.replace("yyyy", parts.year).replace("MM", parts.month).replace("dd", parts.day).replace("HH", parts.hour).replace("mm", parts.minute);
}

// handler(url, options) → { code, text }；預設全部 200
function loadEnv({ props = {}, handler } = {}) {
  const store = {
    LINE_ACCESS_TOKEN: "tok",
    OWNER_USER_ID: OWNER,
    CONTACT_USER_ID: CONTACT,
    CALENDAR_IDS: "cal1",
    LIFF_APP_ID: "1234567890-abcdefgh",
    ...props,
  };
  const cacheStore = new Map();
  const fetchCalls = [];
  const inserted = [];
  const patched = [];
  const removed = [];
  const logs = [];
  const state = { events: [], byId: {} };

  const sandbox = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in store ? store[k] : null), setProperty: (k, v) => (store[k] = v) }) },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => cacheStore.get(k) || null,
        put: (k, v) => cacheStore.set(k, v),
        remove: (k) => cacheStore.delete(k),
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    UrlFetchApp: {
      fetch(url, options) {
        fetchCalls.push({ url, options });
        const r = handler ? handler(url, options) : { code: 200, text: "{}" };
        return { getResponseCode: () => r.code, getContentText: () => r.text };
      },
    },
    Utilities: { formatDate },
    Logger: { log: (m) => logs.push(m) },
    ContentService: {
      MimeType: { JSON: "json", TEXT: "text" },
      createTextOutput: (s) => ({ s, setMimeType() { return this; } }),
    },
    Calendar: {
      Events: {
        list: () => ({ items: state.events, nextSyncToken: "next" }),
        insert: (resource, calId) => {
          inserted.push({ resource, calId });
          return { id: "newid" };
        },
        get: (calId, id) => {
          if (!state.byId[id]) throw new Error("Not Found");
          return state.byId[id];
        },
        patch: (resource, calId, id) => {
          patched.push({ resource, calId, id });
          return { id };
        },
        remove: (calId, id) => {
          removed.push({ calId, id });
        },
      },
    },
    HtmlService: {},
    ScriptApp: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "Code.gs"), "utf8"), sandbox);

  const pushes = () =>
    fetchCalls
      .filter((c) => c.url.endsWith("/message/push"))
      .map((c) => {
        const body = JSON.parse(c.options.payload);
        return { to: body.to, text: body.messages[0].text };
      });
  const replies = () => fetchCalls.filter((c) => c.url.endsWith("/message/reply"));
  return { ctx: sandbox, store, fetchCalls, inserted, patched, removed, logs, state, pushes, replies };
}

const post = (env, body) => env.ctx.doPost({ postData: { contents: JSON.stringify(body) } });
const json = (out) => JSON.parse(out.s);

// ===== #4 日期解析與驗證 =====
test("_parseDateTime：合法日期通過", () => {
  const { ctx } = loadEnv();
  const d = ctx._parseDateTime("2026/06/10 14:00");
  assert.equal(d.toISOString(), "2026-06-10T06:00:00.000Z");
});

test("_parseDateTime：非法 / 會被自動進位的日期回 null", () => {
  const { ctx } = loadEnv();
  for (const s of ["2026/13/45 10:00", "2026/02/31 10:00", "2026/06/10 24:00", "2026/06/10 25:00", "2026-06-10 10:00"]) {
    assert.equal(ctx._parseDateTime(s), null, s);
  }
});

test("_createEventFromText：非法開始時間回覆錯誤、不寫日曆", () => {
  const env = loadEnv();
  const reply = env.ctx._createEventFromText("開會\n2026/13/45 10:00");
  assert.match(reply, /開始時間格式錯誤/);
  assert.equal(env.inserted.length, 0);
});

test("_createEventFromText：非法結束時間回覆錯誤", () => {
  const env = loadEnv();
  const reply = env.ctx._createEventFromText("開會\n2026/06/10 10:00\n2026/02/31 11:00");
  assert.match(reply, /結束時間格式錯誤/);
  assert.equal(env.inserted.length, 0);
});

test("_createEventFromText：結束 <= 開始 被拒", () => {
  const env = loadEnv();
  assert.match(env.ctx._createEventFromText("開會\n2026/06/10 10:00\n2026/06/10 10:00"), /結束時間需晚於開始時間/);
  assert.match(env.ctx._createEventFromText("開會\n2026/06/10 10:00\n2026/06/10 09:00"), /結束時間需晚於開始時間/);
  assert.equal(env.inserted.length, 0);
});

test("_createEventFromText：合法輸入建立成功", () => {
  const env = loadEnv();
  const reply = env.ctx._createEventFromText("開會\n2026/06/10 10:00\n2026/06/10 11:00\n備註");
  assert.match(reply, /行程已建立/);
  assert.equal(env.inserted.length, 1);
  assert.equal(env.inserted[0].calId, "cal1");
});

test("_createEventFromText：insert 例外仍回覆使用者", () => {
  const env = loadEnv();
  env.ctx.Calendar.Events.insert = () => {
    throw new Error("boom");
  };
  assert.match(env.ctx._createEventFromText("開會\n2026/06/10 10:00"), /建立失敗：boom/);
});

// ===== #1 身分驗證 =====
const textEvent = (userId, text = "本週行程") => ({ events: [{ type: "message", replyToken: "rt", source: userId ? { userId } : {}, message: { type: "text", text } }] });

test("webhook：非白名單 / 無 userId 被略過，不呼叫 LINE reply", () => {
  const env = loadEnv();
  post(env, textEvent(STRANGER));
  post(env, textEvent(null));
  assert.equal(env.replies().length, 0);
});

test("webhook：owner 與 contact 可正常觸發", () => {
  const env = loadEnv();
  post(env, textEvent(OWNER));
  post(env, textEvent(CONTACT));
  assert.equal(env.replies().length, 2);
});

test("webhook：白名單未設定 → fail closed", () => {
  const env = loadEnv({ props: { OWNER_USER_ID: "", CONTACT_USER_ID: "" } });
  post(env, textEvent(OWNER));
  assert.equal(env.replies().length, 0);
});

const liffBody = (extra = {}) => ({ action: "createEvent", idToken: "idt", title: "t", start: "2026-06-10T10:00", end: "2026-06-10T11:00", ...extra });
const verifyAs = (sub, code = 200) => (url) => (url.endsWith("/oauth2/v2.1/verify") ? { code, text: JSON.stringify({ sub }) } : { code: 200, text: "{}" });

test("createEvent：缺 idToken 被拒", () => {
  const env = loadEnv({ handler: verifyAs(OWNER) });
  const res = json(post(env, liffBody({ idToken: undefined })));
  assert.deepEqual(res, { ok: false, error: "未授權" });
  assert.equal(env.inserted.length, 0);
});

test("createEvent：驗證 API 失敗被拒", () => {
  const env = loadEnv({ handler: verifyAs(OWNER, 400) });
  assert.equal(json(post(env, liffBody())).error, "未授權");
  assert.equal(env.inserted.length, 0);
});

test("createEvent：token 屬於非白名單使用者被拒", () => {
  const env = loadEnv({ handler: verifyAs(STRANGER) });
  assert.equal(json(post(env, liffBody())).error, "未授權");
  assert.equal(env.inserted.length, 0);
});

test("createEvent：白名單使用者成功；verify 以 LIFF ID 前段為 client_id", () => {
  const env = loadEnv({ handler: verifyAs(CONTACT) });
  assert.deepEqual(json(post(env, liffBody())), { ok: true });
  assert.equal(env.inserted.length, 1);
  const verifyCall = env.fetchCalls.find((c) => c.url.endsWith("/oauth2/v2.1/verify"));
  assert.deepEqual({ ...verifyCall.options.payload }, { id_token: "idt", client_id: "1234567890" });
});

test("createEvent：結束 <= 開始 被拒", () => {
  const env = loadEnv({ handler: verifyAs(OWNER) });
  const res = json(post(env, liffBody({ end: "2026-06-10T10:00" })));
  assert.equal(res.ok, false);
  assert.match(res.error, /結束時間需晚於開始時間/);
  assert.equal(env.inserted.length, 0);
});

test("LIFF 表單 HTML 會送出 idToken", () => {
  const html = loadEnv().ctx._getFormHtml();
  assert.match(html, /liff\.getIDToken\(\)/);
  assert.match(html, /idToken: idToken/);
});

test("LIFF 表單 HTML 限制開始/結束時間不可選過去日期", () => {
  const html = loadEnv().ctx._getFormHtml();
  assert.match(html, /getElementById\("start"\)\.min = /);
  assert.match(html, /getElementById\("end"\)\.min = /);
  assert.match(html, /不可選擇過去的日期/);
});

// ===== #2 額度、#3 告警：每日提醒 =====
const tomorrowEvent = { id: "e1", summary: "牙醫", start: { dateTime: "2026-06-11T10:00:00+08:00" }, end: { dateTime: "2026-06-11T11:00:00+08:00" } };

test("sendDailyReminders：成功時只發 2 則（無確認訊息）", () => {
  const env = loadEnv();
  env.state.events = [tomorrowEvent];
  env.ctx.sendDailyReminders();
  const p = env.pushes();
  assert.deepEqual(p.map((x) => x.to), [OWNER, CONTACT]);
  assert.ok(p.every((x) => x.text.includes("明日行程提醒")));
});

test("sendDailyReminders：contact 失敗 → 告警 owner，不拋錯", () => {
  const env = loadEnv({
    handler: (url, opts) => (url.endsWith("/message/push") && JSON.parse(opts.payload).to === CONTACT ? { code: 500, text: "err" } : { code: 200, text: "{}" }),
  });
  env.state.events = [tomorrowEvent];
  env.ctx.sendDailyReminders();
  const p = env.pushes();
  const last = p[p.length - 1];
  assert.equal(last.to, OWNER);
  assert.match(last.text, /🚨/);
  assert.match(last.text, new RegExp(CONTACT));
});

test("sendDailyReminders：設定不完整 → 拋錯（不再靜默 return）", () => {
  const env = loadEnv({ props: { CONTACT_USER_ID: "" } });
  assert.throws(() => env.ctx.sendDailyReminders(), /設定不完整/);
});

test("sendDailyReminders：Calendar API 例外 → 告警後 rethrow", () => {
  const env = loadEnv();
  env.ctx.Calendar.Events.list = () => {
    throw new Error("calendar down");
  };
  assert.throws(() => env.ctx.sendDailyReminders(), /calendar down/);
  const p = env.pushes();
  assert.equal(p.length, 1);
  assert.match(p[0].text, /calendar down/);
});

test("_alertOwner：同一 context 10 分鐘內只發一次", () => {
  const env = loadEnv();
  env.ctx._alertOwner("ctx", new Error("a"));
  env.ctx._alertOwner("ctx", new Error("b"));
  env.ctx._alertOwner("other", new Error("c"));
  assert.equal(env.pushes().length, 2);
});

test("_alertOwner：推播失敗不拋錯", () => {
  const env = loadEnv({ handler: () => ({ code: 500, text: "x" }) });
  assert.doesNotThrow(() => env.ctx._alertOwner("ctx", new Error("a")));
});

// ===== #3 告警：行事曆變更 =====
const changeEvent = () => {
  const now = new Date().toISOString();
  return { id: "ev1", summary: "新行程", status: "confirmed", created: now, updated: now, start: { dateTime: new Date(Date.now() + 3600e3).toISOString() }, end: { dateTime: new Date(Date.now() + 7200e3).toISOString() } };
};

test("onCalendarChange：單一收件者發送失敗 → 彙整告警 owner", () => {
  const env = loadEnv({
    handler: (url, opts) => (url.endsWith("/message/push") && JSON.parse(opts.payload).to === CONTACT ? { code: 500, text: "err" } : { code: 200, text: "{}" }),
  });
  env.state.events = [changeEvent()];
  env.ctx.onCalendarChange({ calendarId: "cal1" });
  const alert = env.pushes().find((x) => x.text.includes("🚨"));
  assert.ok(alert);
  assert.equal(alert.to, OWNER);
  assert.match(alert.text, /新行程/);
});

test("onCalendarChange：全部成功 → 無告警", () => {
  const env = loadEnv();
  env.state.events = [changeEvent()];
  env.ctx.onCalendarChange({ calendarId: "cal1" });
  assert.equal(env.pushes().filter((x) => x.text.includes("🚨")).length, 0);
  assert.equal(env.pushes().length, 2);
});

test("onCalendarChange：Calendar API 例外 → 告警後 rethrow，並釋放鎖", () => {
  const env = loadEnv();
  env.ctx.Calendar.Events.list = () => {
    throw new Error("api down");
  };
  assert.throws(() => env.ctx.onCalendarChange({ calendarId: "cal1" }), /api down/);
  assert.match(env.pushes()[0].text, /api down/);
  // 鎖已釋放：再次執行不會被「處理中」跳過
  env.ctx.Calendar.Events.list = () => ({ items: [], nextSyncToken: "n" });
  env.ctx.onCalendarChange({ calendarId: "cal1" });
  assert.ok(!env.logs.some((l) => l.includes("處理中")));
});

// ===== A. 訊息分段 =====
test("_toLineMessages：短訊息維持 1 則", () => {
  const { ctx } = loadEnv();
  assert.deepEqual(JSON.parse(JSON.stringify(ctx._toLineMessages("hi"))), [{ type: "text", text: "hi" }]);
});

test("_toLineMessages：超長訊息依換行切段，每段 <= 4800 且內容不遺失", () => {
  const { ctx } = loadEnv();
  const lines = Array.from({ length: 300 }, (_, i) => i + "-" + "行".repeat(40));
  const text = lines.join("\n");
  const msgs = ctx._toLineMessages(text);
  assert.ok(msgs.length > 1 && msgs.length <= 5);
  assert.ok(msgs.every((m) => m.text.length <= 4800));
  assert.equal(msgs.map((m) => m.text).join("\n"), text);
});

test("_toLineMessages：單行超長會硬切", () => {
  const { ctx } = loadEnv();
  const msgs = ctx._toLineMessages("a".repeat(10000));
  assert.deepEqual(Array.from(msgs, (m) => m.text.length), [4800, 4800, 400]);
});

test("_toLineMessages：超過 5 則時截斷並加標記", () => {
  const { ctx } = loadEnv();
  const msgs = ctx._toLineMessages("a".repeat(4800 * 7));
  assert.equal(msgs.length, 5);
  assert.match(msgs[4].text, /…（已截斷）$/);
  assert.ok(msgs[4].text.length <= 4800);
});

test("push：超長內容實際以多則 message 送出", () => {
  const env = loadEnv();
  env.ctx._sendLineMessage("tok", OWNER, "a\n".repeat(4000));
  const body = JSON.parse(env.fetchCalls[0].options.payload);
  assert.ok(body.messages.length >= 2);
  assert.ok(body.messages.every((m) => m.text.length <= 4800));
});

// ===== B/C. 去重、靜音 =====
const ev = (id, summary, start) => ({ id, summary, start: { dateTime: start }, end: { dateTime: start } });

test("_fetchMergedEvents：跨日曆以 id 與 標題|開始時間 去重並排序", () => {
  const env = loadEnv({ props: { CALENDAR_IDS: "cal1,cal2" } });
  const byCal = {
    cal1: [ev("a", "B 行程", "2026-06-11T12:00:00+08:00"), ev("b", "A 行程", "2026-06-11T09:00:00+08:00")],
    cal2: [ev("a", "B 行程", "2026-06-11T12:00:00+08:00"), ev("c", "A 行程", "2026-06-11T09:00:00+08:00"), ev("d", "C 行程", "2026-06-11T10:00:00+08:00")],
  };
  env.ctx.Calendar.Events.list = (calId) => ({ items: byCal[calId] });
  const out = env.ctx._fetchMergedEvents(new Date(), new Date(), false);
  assert.deepEqual(Array.from(out, (e) => e.id), ["b", "d", "a"]);
});

test("靜音：每日提醒排除、週報不排除", () => {
  const env = loadEnv({ props: { MUTE_KEYWORDS: "結帳日, 扣款" } });
  env.state.events = [ev("1", "信用卡結帳日", "2026-06-11T09:00:00+08:00"), ev("2", "牙醫", "2026-06-11T10:00:00+08:00")];
  env.ctx.sendDailyReminders();
  const daily = env.pushes()[0].text;
  assert.match(daily, /牙醫/);
  assert.doesNotMatch(daily, /結帳日/);
  const weekly = env.ctx._getWeekEventText(0);
  assert.match(weekly, /結帳日/);
});

test("_isMutedEvent：單次執行內只讀一次 MUTE_KEYWORDS", () => {
  const env = loadEnv({ props: { MUTE_KEYWORDS: "x" } });
  let reads = 0;
  Object.defineProperty(env.store, "MUTE_KEYWORDS", {
    get() {
      reads++;
      return "x";
    },
  });
  assert.equal(env.ctx._isMutedEvent("axb"), true);
  assert.equal(env.ctx._isMutedEvent("abc"), false);
  assert.equal(env.ctx._isMutedEvent("x"), true);
  assert.equal(reads, 1);
});

// ===== CONTACT 修改／刪除自己建立的行程 =====
const ownedBy = (uid) => ({ id: "ev1", summary: "x", extendedProperties: { private: { createdBy: uid } } });
const editBody = (extra = {}) => ({ action: "updateEvent", idToken: "idt", eventId: "ev1", title: "新標題", start: "2026-06-10T10:00", end: "2026-06-10T11:00", ...extra });
const delBody = (extra = {}) => ({ action: "deleteEvent", idToken: "idt", eventId: "ev1", ...extra });

test("新增（LIFF）：寫入 createdBy", () => {
  const env = loadEnv({ handler: verifyAs(CONTACT) });
  post(env, liffBody());
  assert.equal(env.inserted[0].resource.extendedProperties.private.createdBy, CONTACT);
});

test("新增（文字）：寫入 createdBy", () => {
  const env = loadEnv();
  env.ctx._createEventFromText("開會\n2026/06/10 10:00", CONTACT);
  assert.equal(env.inserted[0].resource.extendedProperties.private.createdBy, CONTACT);
});

test("webhook 文字新增：createdBy 為 source.userId", () => {
  const env = loadEnv();
  post(env, textEvent(CONTACT, "開會\n2026/06/10 10:00"));
  assert.equal(env.inserted[0].resource.extendedProperties.private.createdBy, CONTACT);
});

test("updateEvent：CONTACT 改自己建立的 → patch", () => {
  const env = loadEnv({ handler: verifyAs(CONTACT) });
  env.state.byId.ev1 = ownedBy(CONTACT);
  const out = json(post(env, editBody()));
  assert.equal(out.ok, true);
  assert.equal(env.patched.length, 1);
  assert.equal(env.patched[0].id, "ev1");
  assert.equal(env.patched[0].calId, "cal1");
  assert.equal(env.patched[0].resource.summary, "新標題");
});

test("updateEvent：CONTACT 改 OWNER 建立的 / 無標記舊行程 → 無權限", () => {
  for (const ev of [ownedBy(OWNER), { id: "ev1", summary: "舊" }]) {
    const env = loadEnv({ handler: verifyAs(CONTACT) });
    env.state.byId.ev1 = ev;
    const out = json(post(env, editBody()));
    assert.equal(out.ok, false);
    assert.equal(out.error, "無權限");
    assert.equal(env.patched.length, 0);
  }
});

test("updateEvent：OWNER 可改任意行程", () => {
  const env = loadEnv({ handler: verifyAs(OWNER) });
  env.state.byId.ev1 = ownedBy(CONTACT);
  assert.equal(json(post(env, editBody())).ok, true);
  env.state.byId.ev1 = { id: "ev1" };
  assert.equal(json(post(env, editBody())).ok, true);
  assert.equal(env.patched.length, 2);
});

test("updateEvent：非白名單 / token 驗證失敗 → 未授權", () => {
  for (const h of [verifyAs(STRANGER), verifyAs(OWNER, 400)]) {
    const env = loadEnv({ handler: h });
    env.state.byId.ev1 = ownedBy(CONTACT);
    assert.equal(json(post(env, editBody())).error, "未授權");
    assert.equal(env.patched.length, 0);
  }
});

test("updateEvent：缺欄位 / 時間錯誤 / eventId 不存在", () => {
  const env = loadEnv({ handler: verifyAs(OWNER) });
  env.state.byId.ev1 = ownedBy(OWNER);
  assert.equal(json(post(env, editBody({ title: "" }))).error, "缺少必填欄位");
  assert.equal(json(post(env, editBody({ end: "2026-06-10T09:00" }))).error, "結束時間需晚於開始時間");
  assert.equal(json(post(env, editBody({ start: "bad" }))).error, "時間格式錯誤");
  assert.equal(json(post(env, editBody({ eventId: "nope" }))).ok, false);
  assert.equal(env.patched.length, 0);
});

test("updateEvent：時間改變時重算提醒", () => {
  const env = loadEnv({ handler: verifyAs(OWNER) });
  env.state.byId.ev1 = ownedBy(OWNER);
  post(env, editBody({ start: "2026-06-10T14:00", end: "2026-06-10T15:00" }));
  assert.equal(JSON.stringify(env.patched[0].resource.reminders.overrides), JSON.stringify([{ method: "popup", minutes: 300 }]));
});

test("deleteEvent：CONTACT 刪自己建立的 → remove", () => {
  const env = loadEnv({ handler: verifyAs(CONTACT) });
  env.state.byId.ev1 = ownedBy(CONTACT);
  assert.equal(json(post(env, delBody())).ok, true);
  assert.deepEqual(env.removed, [{ calId: "cal1", id: "ev1" }]);
});

test("deleteEvent：CONTACT 刪他人 / 舊行程 → 無權限，不 remove", () => {
  for (const ev of [ownedBy(OWNER), { id: "ev1" }]) {
    const env = loadEnv({ handler: verifyAs(CONTACT) });
    env.state.byId.ev1 = ev;
    assert.equal(json(post(env, delBody())).error, "無權限");
    assert.equal(env.removed.length, 0);
  }
});

test("deleteEvent：OWNER 可刪任意；未授權被拒", () => {
  const env = loadEnv({ handler: verifyAs(OWNER) });
  env.state.byId.ev1 = ownedBy(CONTACT);
  assert.equal(json(post(env, delBody())).ok, true);
  const env2 = loadEnv({ handler: verifyAs(STRANGER) });
  env2.state.byId.ev1 = ownedBy(CONTACT);
  assert.equal(json(post(env2, delBody())).error, "未授權");
  assert.equal(env2.removed.length, 0);
});
