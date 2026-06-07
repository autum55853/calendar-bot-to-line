// ===== 設定區 =====
// 在 Script Properties 設定以下 key（勿直接寫在程式碼）：
//   LINE_ACCESS_TOKEN   — LINE Bot Channel Access Token
//   OWNER_USER_ID       — 你自己的 LINE userId（以 U 開頭）
//   CONTACT_USER_ID     — 對方的 LINE userId（以 U 開頭）
//   CALENDAR_IDS        — 逗號分隔的 Calendar ID 清單
//                         例：me@gmail.com,abc123@group.calendar.google.com

const PROPS = PropertiesService.getScriptProperties();
const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";
const LINE_REPLY_URL = "https://api.line.me/v2/bot/message/reply";
const TZ = "Asia/Taipei";

// ===== 初始化（只需執行一次）=====
function setup() {
  const calendarIds = _getCalendarIds();
  if (calendarIds.length === 0) throw new Error("請先在 Script Properties 設定 CALENDAR_IDS");

  // 移除全部舊 trigger
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));

  // 每個 Calendar 各建一個 onEventUpdated trigger
  calendarIds.forEach((id) => {
    ScriptApp.newTrigger("onCalendarChange").forUserCalendar(id).onEventUpdated().create();
    _initSyncToken(id);
  });

  // 每天 09:00 前一天提醒 trigger（依 appsscript.json timeZone = Asia/Taipei）
  ScriptApp.newTrigger("sendDailyReminders").timeBased().atHour(9).everyDays(1).create();

  Logger.log("Setup 完成。已建立 " + (calendarIds.length + 1) + " 個 trigger。監控日曆：" + calendarIds.join(", "));
}

function _getCalendarIds() {
  const raw = PROPS.getProperty("CALENDAR_IDS") || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function _initSyncToken(calendarId) {
  const result = Calendar.Events.list(calendarId, {
    maxResults: 1,
    showDeleted: false,
    singleEvents: true,
  });
  if (result.nextSyncToken) {
    PROPS.setProperty("SYNC_TOKEN_" + calendarId, result.nextSyncToken);
  }
}

// ===== 行事曆變更通知（新增 / 修改 / 刪除）=====
function onCalendarChange(e) {
  // 用 ScriptLock 避免多次 trigger 同時讀到相同 syncToken 導致重複通知
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (_) {
    Logger.log("無法取得鎖，跳過此次執行");
    return;
  }

  try {
    const calendarId = e.calendarId;
    const syncToken = PROPS.getProperty("SYNC_TOKEN_" + calendarId);

    const params = { showDeleted: true, singleEvents: true };
    if (syncToken) {
      params.syncToken = syncToken;
    } else {
      params.updatedMin = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    }

    let result;
    try {
      result = Calendar.Events.list(calendarId, params);
    } catch (err) {
      if (err.message && err.message.includes("410")) {
        _initSyncToken(calendarId);
        return;
      }
      throw err;
    }

    if (result.nextSyncToken) {
      PROPS.setProperty("SYNC_TOKEN_" + calendarId, result.nextSyncToken);
    }

    const token = PROPS.getProperty("LINE_ACCESS_TOKEN");
    const ownerUserId = PROPS.getProperty("OWNER_USER_ID");
    const contactUserId = PROPS.getProperty("CONTACT_USER_ID");
    if (!token || !ownerUserId || !contactUserId) {
      throw new Error("請設定 LINE_ACCESS_TOKEN、OWNER_USER_ID、CONTACT_USER_ID");
    }

    const cache = CacheService.getScriptCache();
    (result.items || []).forEach((item) => {
      // 以 eventId + updated 時間戳為 key，5 分鐘內不重複發送
      const dedupeKey = "notified_" + item.id + "_" + (item.updated || "");
      if (cache.get(dedupeKey)) {
        Logger.log("重複通知已略過：" + (item.summary || item.id));
        return;
      }
      cache.put(dedupeKey, "1", 300);

      const text = _formatChangeMessage(item);
      if (!text) return;
      [ownerUserId, contactUserId].forEach((userId) => _sendLineMessage(token, userId, text));
      Logger.log("已發送變更通知：" + (item.summary || item.id));
    });
  } finally {
    lock.releaseLock();
  }
}

function _formatChangeMessage(item) {
  const created = item.created ? new Date(item.created) : null;
  const updated = item.updated ? new Date(item.updated) : null;
  const title = item.summary || "（無標題）";

  if (item.status === "cancelled") {
    const lines = ["🗑️ 行程已刪除", "──────────", "標題：" + title];
    if (item.start) lines.push("時間：" + _formatDateTime(item.start));
    return lines.join("\n");
  }

  const isNew = created && updated && Math.abs(updated - created) < 5000;
  const header = isNew ? "📅 新行程建立" : "✏️ 行程已修改";
  const location = item.location ? "\n📍 地點：" + item.location : "";
  const description = item.description ? "\n📝 說明：" + item.description.substring(0, 100) : "";

  return [header, "──────────", "標題：" + title, "開始：" + _formatDateTime(item.start), "結束：" + _formatDateTime(item.end), location, description].filter(Boolean).join("\n");
}

// ===== 明日行程提醒（每天 09:00 執行）=====
function sendDailyReminders() {
  const calendarIds = _getCalendarIds();
  const token = PROPS.getProperty("LINE_ACCESS_TOKEN");
  const ownerUserId = PROPS.getProperty("OWNER_USER_ID");
  const contactUserId = PROPS.getProperty("CONTACT_USER_ID");
  if (calendarIds.length === 0 || !token || !ownerUserId || !contactUserId) return;

  const { start, end } = _getTomorrowRange();

  // 查詢所有日曆，以 event id 或「標題+開始時間」去重
  const seen = Object.create(null);
  const allEvents = [];

  calendarIds.forEach((calendarId) => {
    const result = Calendar.Events.list(calendarId, {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      showDeleted: false,
      singleEvents: true,
      orderBy: "startTime",
    });
    (result.items || []).forEach((event) => {
      const titleKey = (event.summary || "") + "|" + (event.start.dateTime || event.start.date || "");
      if (!seen[event.id] && !seen[titleKey]) {
        seen[event.id] = true;
        seen[titleKey] = true;
        allEvents.push(event);
      }
    });
  });

  if (allEvents.length === 0) {
    Logger.log("明日無行程，不發通知");
    return;
  }

  // 跨日曆合併後重新排序
  allEvents.sort((a, b) => {
    const at = a.start.dateTime || a.start.date;
    const bt = b.start.dateTime || b.start.date;
    return at < bt ? -1 : at > bt ? 1 : 0;
  });

  const lines = ["⏰ 明日行程提醒", "──────────"];
  allEvents.forEach((event, i) => {
    lines.push(i + 1 + ". " + (event.summary || "（無標題）") + "　" + _formatDateTime(event.start));
    if (event.location) lines.push("   📍 " + event.location);
  });

  const text = lines.join("\n");
  [ownerUserId, contactUserId].forEach((userId) => _sendLineMessage(token, userId, text));
  Logger.log("已發送明日行程提醒，共 " + allEvents.length + " 筆");
}

function _getTomorrowRange() {
  const todayStr = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
  const tomorrowStart = new Date(todayStr + "T00:00:00+08:00");
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);
  const tomorrowEnd = new Date(tomorrowStart.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { start: tomorrowStart, end: tomorrowEnd };
}

// ===== Webhook 入口（LINE 按鈕觸發）=====
function doGet(e) {
  return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    (body.events || []).forEach((event) => {
      if (event.type === "message" && event.message.type === "text") {
        _handleLineMessage(event.replyToken, event.message.text.trim());
      }
    });
  } catch (err) {
    Logger.log("doPost 錯誤：" + err.message);
  }
  return ContentService.createTextOutput(JSON.stringify({ status: "ok" })).setMimeType(ContentService.MimeType.JSON);
}

function _handleLineMessage(replyToken, text) {
  const token = PROPS.getProperty("LINE_ACCESS_TOKEN");
  let replyText;

  if (text === "本週行程") {
    replyText = _getWeekEventText(0);
  } else if (text === "下週行程") {
    replyText = _getWeekEventText(1);
  } else if (text === "新增行程") {
    replyText = "請依以下格式傳送行程資訊：\n\n行程名稱\n開始時間（格式：2026/06/10 14:00）\n結束時間（格式：2026/06/10 15:00）\n備註（選填）\n\n範例：\n團隊會議\n2026/06/10 14:00\n2026/06/10 15:00\n記得帶文件";
  } else if (_looksLikeEventData(text)) {
    replyText = _createEventFromText(text);
  } else {
    return;
  }

  _replyLineMessage(token, replyToken, replyText);
}

function _getWeekEventText(weekOffset) {
  const calendarIds = _getCalendarIds();
  const { start, end } = _getWeekRange(weekOffset);

  const seen = Object.create(null);
  const allEvents = [];

  calendarIds.forEach((calendarId) => {
    const result = Calendar.Events.list(calendarId, {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      showDeleted: false,
      singleEvents: true,
      orderBy: "startTime",
    });
    (result.items || []).forEach((event) => {
      const titleKey = (event.summary || "") + "|" + (event.start.dateTime || event.start.date || "");
      if (!seen[event.id] && !seen[titleKey]) {
        seen[event.id] = true;
        seen[titleKey] = true;
        allEvents.push(event);
      }
    });
  });

  allEvents.sort((a, b) => {
    const at = a.start.dateTime || a.start.date;
    const bt = b.start.dateTime || b.start.date;
    return at < bt ? -1 : at > bt ? 1 : 0;
  });

  const label = weekOffset === 0 ? "本週" : "下週";
  const startStr = Utilities.formatDate(start, TZ, "MM/dd");
  const endStr = Utilities.formatDate(end, TZ, "MM/dd");

  if (allEvents.length === 0) {
    return label + "（" + startStr + "～" + endStr + "）無行程";
  }

  const lines = ["📅 " + label + "行程（" + startStr + "～" + endStr + "）", "──────────"];
  allEvents.forEach((event, i) => {
    lines.push((i + 1) + ". " + (event.summary || "（無標題）") + "　" + _formatDateTime(event.start));
    if (event.location) lines.push("   📍 " + event.location);
  });

  return lines.join("\n");
}

function _looksLikeEventData(text) {
  const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  return /^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}$/.test(lines[1]);
}

function _createEventFromText(text) {
  const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
  const title = lines[0];
  const startDate = _parseDateTime(lines[1]);
  if (!startDate) return "❌ 開始時間格式錯誤，請用：2026/06/10 14:00";

  let endDate;
  let descLines;

  if (lines.length >= 3 && /^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}$/.test(lines[2])) {
    endDate = _parseDateTime(lines[2]);
    descLines = lines.slice(3);
  } else {
    endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
    descLines = lines.slice(2);
  }

  const calendarIds = _getCalendarIds();
  if (calendarIds.length === 0) return "❌ 未設定 CALENDAR_IDS";

  const eventResource = {
    summary: title,
    start: { dateTime: startDate.toISOString(), timeZone: TZ },
    end: { dateTime: endDate.toISOString(), timeZone: TZ },
  };
  if (descLines.length > 0) eventResource.description = descLines.join("\n");

  try {
    Calendar.Events.insert(eventResource, calendarIds[0]);
    const startStr = Utilities.formatDate(startDate, TZ, "yyyy/MM/dd HH:mm");
    const endStr = Utilities.formatDate(endDate, TZ, "HH:mm");
    const desc = descLines.length > 0 ? "\n📝 " + descLines.join(" ") : "";
    return "✅ 行程已建立\n──────────\n" + title + "\n" + startStr + "～" + endStr + desc;
  } catch (err) {
    Logger.log("建立行程失敗：" + err.message);
    return "❌ 建立失敗：" + err.message;
  }
}

function _parseDateTime(str) {
  const m = str.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  return new Date(m[1] + "-" + m[2] + "-" + m[3] + "T" + m[4] + ":" + m[5] + ":00+08:00");
}

function _getWeekRange(weekOffset) {
  const todayStr = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
  const today = new Date(todayStr + "T00:00:00+08:00");
  const dayOfWeek = today.getDay(); // 0=Sun
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const monday = new Date(today.getTime());
  monday.setDate(monday.getDate() - daysSinceMonday + weekOffset * 7);

  const sunday = new Date(monday.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
  return { start: monday, end: sunday };
}

function _replyLineMessage(token, replyToken, text) {
  const payload = JSON.stringify({
    replyToken: replyToken,
    messages: [{ type: "text", text: text }],
  });

  const response = UrlFetchApp.fetch(LINE_REPLY_URL, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: payload,
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  if (code !== 200) {
    Logger.log("LINE Reply API 錯誤 " + code + ": " + response.getContentText());
  }
}

// ===== LINE 訊息發送 =====
function _sendLineMessage(token, userId, text) {
  const payload = JSON.stringify({
    to: userId,
    messages: [{ type: "text", text: text }],
  });

  const response = UrlFetchApp.fetch(LINE_PUSH_URL, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: payload,
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  if (code !== 200) {
    Logger.log("LINE API 錯誤 " + code + ": " + response.getContentText());
    throw new Error("LINE push 失敗，HTTP " + code);
  }
}

// ===== 時間格式 =====
function _formatDateTime(dateObj) {
  if (!dateObj) return "—";
  if (dateObj.date) return dateObj.date + "（全天）";
  return Utilities.formatDate(new Date(dateObj.dateTime), TZ, "yyyy/MM/dd HH:mm");
}
