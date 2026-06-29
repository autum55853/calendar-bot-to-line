// ===== 設定區 =====
// 在 Script Properties 設定以下 key（勿直接寫在程式碼）：
//   LINE_ACCESS_TOKEN   — LINE Bot Channel Access Token
//   OWNER_USER_ID       — 你自己的 LINE userId（以 U 開頭）
//   CONTACT_USER_ID     — 對方的 LINE userId（以 U 開頭）
//   CALENDAR_IDS        — 逗號分隔的 Calendar ID 清單
//                         例：me@gmail.com,abc123@group.calendar.google.com
//   MUTE_KEYWORDS       — 逗號分隔的靜音關鍵字（含此關鍵字的行程不發通知）
//                         例：信用卡結帳日,每月扣款（選填，留空則不靜音任何行程）

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
  const MAX_PAGES = 20;
  let pageToken = null;
  let pageCount = 0;
  do {
    const params = { maxResults: 2500, showDeleted: false, singleEvents: true };
    if (pageToken) params.pageToken = pageToken;
    const result = Calendar.Events.list(calendarId, params);
    if (result.nextSyncToken) {
      PROPS.setProperty("SYNC_TOKEN_" + calendarId, result.nextSyncToken);
      Logger.log("已建立 syncToken：" + calendarId);
      return;
    }
    pageToken = result.nextPageToken || null;
    pageCount++;
  } while (pageToken && pageCount < MAX_PAGES);
  Logger.log("警告：" + calendarId + " 未取得 nextSyncToken，超過 " + MAX_PAGES + " 頁");
}

// ===== 行事曆變更通知（新增 / 修改 / 刪除）=====
function onCalendarChange(e) {
  const calendarId = e.calendarId;
  // 同一日曆同時有多個 trigger 排隊時，用 cache lock 避免 syncToken 競態
  // 不用 LockService.getScriptLock()，否則跨日曆會互相卡死
  const cache = CacheService.getScriptCache();
  const calLockKey = "lock_cal_" + calendarId;
  if (cache.get(calLockKey)) {
    Logger.log("該日曆處理中，跳過此次執行：" + calendarId);
    return;
  }
  cache.put(calLockKey, "1", 60);

  try {
    const syncToken = PROPS.getProperty("SYNC_TOKEN_" + calendarId);

    const baseParams = { showDeleted: true, singleEvents: true };
    if (syncToken) {
      baseParams.syncToken = syncToken;
    } else {
      baseParams.updatedMin = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    }

    const token = (PROPS.getProperty("LINE_ACCESS_TOKEN") || "").trim();
    const ownerUserId = (PROPS.getProperty("OWNER_USER_ID") || "").trim();
    const contactUserId = (PROPS.getProperty("CONTACT_USER_ID") || "").trim();
    if (!token || !ownerUserId || !contactUserId) {
      throw new Error("請設定 LINE_ACCESS_TOKEN、OWNER_USER_ID、CONTACT_USER_ID");
    }

    const MAX_PAGES = 20;
    let pageToken = null;
    let pageCount = 0;
    let finalSyncToken = null;
    let totalItems = 0;

    do {
      const params = Object.assign({}, baseParams);
      if (pageToken) params.pageToken = pageToken;

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

      const items = result.items || [];
      totalItems += items.length;

      items.forEach((item) => {
        // 便宜的過濾優先：避免 backlog 污染 dedup cache
        if (item.status !== "cancelled" && item.start) {
          const startStr = item.start.dateTime || item.start.date;
          if (startStr && new Date(startStr).getTime() < Date.now() - 24 * 60 * 60 * 1000) {
            return;
          }
        }
        if (item.status === "cancelled") {
          const updatedTime = item.updated ? new Date(item.updated).getTime() : 0;
          if (!updatedTime || Date.now() - updatedTime > 5 * 60 * 1000) {
            return;
          }
        }
        if (_isMutedEvent(item.summary || "")) {
          Logger.log("靜音關鍵字略過：" + (item.summary || item.id));
          return;
        }
        // 長效：同一 eventId + updated 時間戳，10 分鐘內不重複發送
        const changeKey = "change_" + item.id + "_" + (item.updated || "");
        if (cache.get(changeKey)) {
          Logger.log("同一變更已通知過：" + (item.summary || item.id));
          return;
        }
        // 短效：同一 eventId 30 秒內不重複（防止多日曆 trigger updated 略有差異仍重複）
        const dedupeKey = "notified_" + item.id;
        if (cache.get(dedupeKey)) {
          Logger.log("跨日曆重複通知已略過：" + (item.summary || item.id));
          return;
        }
        cache.put(changeKey, "1", 600);
        cache.put(dedupeKey, "1", 30);

        const createdByUs = !!cache.get("created_event_" + item.id);
        const text = _formatChangeMessage(item, createdByUs);
        if (!text) return;
        [ownerUserId, contactUserId].forEach((userId) => {
          try {
            _sendLineMessage(token, userId, text);
          } catch (sendErr) {
            Logger.log("發送失敗 userId=" + userId + " err=" + sendErr.message);
          }
        });
        Logger.log("已發送變更通知：" + (item.summary || item.id));
      });

      pageToken = result.nextPageToken || null;
      finalSyncToken = result.nextSyncToken || finalSyncToken;
      pageCount++;
    } while (pageToken && pageCount < MAX_PAGES);

    Logger.log("處理 " + calendarId + "：" + pageCount + " 頁，" + totalItems + " 筆");

    if (finalSyncToken) {
      PROPS.setProperty("SYNC_TOKEN_" + calendarId, finalSyncToken);
    } else if (pageToken) {
      Logger.log("分頁未完成，下次 trigger 再續：" + calendarId);
    }
  } finally {
    cache.remove(calLockKey);
  }
}

function _isMutedEvent(title) {
  const raw = PROPS.getProperty("MUTE_KEYWORDS") || "";
  if (!raw.trim()) return false;
  const keywords = raw
    .split(",")
    .map(function (s) {
      return s.trim();
    })
    .filter(Boolean);
  return keywords.some(function (kw) {
    return title.indexOf(kw) !== -1;
  });
}

function _formatChangeMessage(item, overrideIsNew) {
  const created = item.created ? new Date(item.created) : null;
  const updated = item.updated ? new Date(item.updated) : null;
  const title = item.summary || "（無標題）";

  if (item.status === "cancelled") {
    const lines = ["🗑️ 行程已刪除", "──────────", "標題：" + title];
    if (item.start) lines.push("時間：" + _formatDateTime(item.start));
    return lines.join("\n");
  }

  const isNew = overrideIsNew || (created && updated && Math.abs(updated - created) < 30000);
  const header = isNew ? "📅 新行程建立" : "✏️ 行程已修改";
  const location = item.location ? "\n📍 地點：" + item.location : "";
  const description = item.description ? "\n📝 說明：" + item.description.substring(0, 100) : "";

  return [header, "──────────", "標題：" + title, "開始：" + _formatDateTime(item.start), "結束：" + _formatDateTime(item.end), location, description].filter(Boolean).join("\n");
}

// ===== 明日行程提醒（每天 09:00 執行）=====
function sendDailyReminders() {
  const calendarIds = _getCalendarIds();
  const token = (PROPS.getProperty("LINE_ACCESS_TOKEN") || "").trim();
  const ownerUserId = (PROPS.getProperty("OWNER_USER_ID") || "").trim();
  const contactUserId = (PROPS.getProperty("CONTACT_USER_ID") || "").trim();
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
        if (!_isMutedEvent(event.summary || "")) {
          allEvents.push(event);
        }
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

  // 先發給 owner
  _sendLineMessage(token, ownerUserId, text);

  // 發給 contact，並把結果回報給 owner 確認（contact 失敗不影響 owner）
  let contactStatus;
  try {
    _sendLineMessage(token, contactUserId, text);
    contactStatus = "✅ 每日提醒已傳送給 contact\nuserId=" + contactUserId;
  } catch (sendErr) {
    contactStatus = "❌ 傳送 contact 失敗\nuserId=" + contactUserId + "\n錯誤：" + sendErr.message;
  }
  _sendLineMessage(token, ownerUserId, contactStatus);

  Logger.log("已發送明日行程提醒，共 " + allEvents.length + " 筆；" + contactStatus.replace(/\n/g, " "));
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
  const liffId = PROPS.getProperty("LIFF_APP_ID");
  if (!liffId) {
    return ContentService.createTextOutput("請先在 Script Properties 設定 LIFF_APP_ID").setMimeType(ContentService.MimeType.TEXT);
  }
  const scriptUrl = ScriptApp.getService().getUrl();
  const html = _getFormHtml()
    .replace(/\{\{SCRIPT_URL\}\}/g, scriptUrl)
    .replace(/\{\{LIFF_ID\}\}/g, liffId);
  return HtmlService.createHtmlOutput(html).setTitle("新增行程").setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    // const token = PROPS.getProperty("LINE_ACCESS_TOKEN");
    // const ownerUserId = PROPS.getProperty("OWNER_USER_ID");

    // // 暫時：把收到的 source userId 轉傳給自己
    // if (body.events && body.events[0]) {
    //   const sourceId = body.events[0].source.userId || "no userId";
    //   _sendLineMessage(token, ownerUserId, "來源 userId: " + sourceId);
    // }
    // ... 原有程式碼繼續
    if (body.action === "createEvent") {
      return _handleLiffCreateEvent(body);
    }
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

function _handleLiffCreateEvent(data) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    Logger.log("LIFF 建立行程失敗：無法取得鎖");
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "系統忙碌，請稍後再試" })).setMimeType(ContentService.MimeType.JSON);
  }
  try {
    const { title, start, end, location, note } = data;
    if (!title || !start || !end) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "缺少必填欄位" })).setMimeType(ContentService.MimeType.JSON);
    }
    const startDate = new Date(start + ":00+08:00");
    const endDate = new Date(end + ":00+08:00");
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "時間格式錯誤" })).setMimeType(ContentService.MimeType.JSON);
    }
    const calendarIds = _getCalendarIds();
    if (calendarIds.length === 0) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "未設定 CALENDAR_IDS" })).setMimeType(ContentService.MimeType.JSON);
    }
    const eventResource = {
      summary: title,
      start: { dateTime: startDate.toISOString(), timeZone: TZ },
      end: { dateTime: endDate.toISOString(), timeZone: TZ },
    };
    if (location) eventResource.location = location;
    if (note) eventResource.description = note;
    const eventDateStr = Utilities.formatDate(startDate, TZ, "yyyy-MM-dd");
    const nineAM = new Date(eventDateStr + "T09:00:00+08:00");
    const minutesBeforeStart = Math.round((startDate - nineAM) / 60000);
    eventResource.reminders = minutesBeforeStart > 0 ? { useDefault: false, overrides: [{ method: "popup", minutes: minutesBeforeStart }] } : { useDefault: false, overrides: [] };
    const insertedEvent = Calendar.Events.insert(eventResource, calendarIds[0]);
    CacheService.getScriptCache().put("created_event_" + insertedEvent.id, "1", 300);
    Logger.log("LIFF 建立行程成功：" + title);
    return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    Logger.log("LIFF 建立行程失敗：" + err.message);
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.message })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

function _handleLineMessage(replyToken, text) {
  const token = (PROPS.getProperty("LINE_ACCESS_TOKEN") || "").trim();
  let replyText;

  if (text === "本週行程") {
    replyText = _getWeekEventText(0);
  } else if (text === "下週行程") {
    replyText = _getWeekEventText(1);
  } else if (text === "新增行程") {
    const liffId = PROPS.getProperty("LIFF_APP_ID");
    replyText = liffId ? "📅 點選連結開啟新增行程表單：\nhttps://liff.line.me/" + liffId : "❌ 尚未設定 LIFF_APP_ID，請聯繫管理員";
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
    lines.push(i + 1 + ". " + (event.summary || "（無標題）") + "　" + _formatDateTime(event.start));
    if (event.location) lines.push("   📍 " + event.location);
  });

  return lines.join("\n");
}

function _looksLikeEventData(text) {
  const lines = text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length < 2) return false;
  return /^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}$/.test(lines[1]);
}

function _createEventFromText(text) {
  const lines = text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
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
    const insertedEvent = Calendar.Events.insert(eventResource, calendarIds[0]);
    CacheService.getScriptCache().put("created_event_" + insertedEvent.id, "1", 300);
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

// ===== LIFF 新增行程表單 HTML =====
function _getFormHtml() {
  return (
    "<!DOCTYPE html>\n" +
    '<html lang="zh-TW">\n' +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">\n' +
    "<title>新增行程</title>\n" +
    '<script charset="utf-8" src="https://static.line-scdn.net/liff/edge/versions/2.22.3/sdk.js"><\/script>\n' +
    "<style>\n" +
    "* { box-sizing: border-box; margin: 0; padding: 0; }\n" +
    'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f7f7; min-height: 100vh; }\n' +
    ".container { max-width: 480px; margin: 0 auto; padding: 20px 16px 40px; }\n" +
    "h1 { font-size: 20px; font-weight: 600; color: #1a1a1a; margin-bottom: 20px; padding-bottom: 12px; border-bottom: 2px solid #06C755; }\n" +
    ".field { margin-bottom: 16px; }\n" +
    "label { display: block; font-size: 13px; font-weight: 500; color: #555; margin-bottom: 6px; }\n" +
    '.required::after { content: " *"; color: #e74c3c; }\n' +
    'input[type="text"], input[type="datetime-local"], textarea {\n' +
    "  width: 100%; padding: 12px; border: 1.5px solid #ddd; border-radius: 10px;\n" +
    "  font-size: 15px; color: #333; background: #fff; outline: none;\n" +
    "}\n" +
    "input:focus, textarea:focus { border-color: #06C755; }\n" +
    "textarea { height: 80px; resize: vertical; }\n" +
    ".btn {\n" +
    "  width: 100%; padding: 15px; background: #06C755; color: #fff;\n" +
    "  border: none; border-radius: 10px; font-size: 16px; font-weight: 600;\n" +
    "  cursor: pointer; margin-top: 8px;\n" +
    "}\n" +
    ".btn:disabled { background: #aaa; cursor: not-allowed; }\n" +
    ".msg { margin-top: 14px; text-align: center; font-size: 14px; padding: 10px; border-radius: 8px; display: none; }\n" +
    ".msg.err { background: #ffeaea; color: #c0392b; display: block; }\n" +
    ".msg.ok { background: #eafaf1; color: #1e8449; display: block; }\n" +
    ".msg.loading { background: #f0f0f0; color: #555; display: block; }\n" +
    "<\/style>\n" +
    "<\/head>\n" +
    "<body>\n" +
    '<div class="container">\n' +
    "<h1>📅 新增行程<\/h1>\n" +
    '<div class="field"><label class="required">行程名稱<\/label><input type="text" id="title" placeholder="輸入行程名稱"><\/div>\n' +
    '<div class="field"><label class="required">開始時間<\/label><input type="datetime-local" id="start"><\/div>\n' +
    '<div class="field"><label class="required">結束時間<\/label><input type="datetime-local" id="end"><\/div>\n' +
    '<div class="field"><label>地點<\/label><input type="text" id="location" placeholder="輸入地點（選填）"><\/div>\n' +
    '<div class="field"><label>備註<\/label><textarea id="note" placeholder="輸入備註（選填）"><\/textarea><\/div>\n' +
    '<button class="btn" id="submitBtn">建立行程<\/button>\n' +
    '<div class="msg" id="msg"><\/div>\n' +
    "<\/div>\n" +
    "<script>\n" +
    'var SCRIPT_URL = "{{SCRIPT_URL}}";\n' +
    'var LIFF_ID = "{{LIFF_ID}}";\n' +
    "(function() {\n" +
    "  var defaultStart = new Date();\n" +
    "  defaultStart.setHours(9, 0, 0, 0);\n" +
    "  function toLocalStr(d) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }\n" +
    '  document.getElementById("start").value = toLocalStr(defaultStart);\n' +
    '  document.getElementById("end").value = toLocalStr(new Date(defaultStart.getTime() + 3600000));\n' +
    "})();\n" +
    'liff.init({ liffId: LIFF_ID }).catch(function(e) { console.warn("LIFF init:", e); });\n' +
    "function showMsg(text, type) {\n" +
    '  var el = document.getElementById("msg");\n' +
    "  el.textContent = text;\n" +
    '  el.className = "msg " + type;\n' +
    "}\n" +
    'document.getElementById("submitBtn").addEventListener("click", function() {\n' +
    "  var self = this;\n" +
    '  var title = document.getElementById("title").value.trim();\n' +
    '  var start = document.getElementById("start").value;\n' +
    '  var end = document.getElementById("end").value;\n' +
    '  var location = document.getElementById("location").value.trim();\n' +
    '  var note = document.getElementById("note").value.trim();\n' +
    '  if (!title) { showMsg("請輸入行程名稱", "err"); return; }\n' +
    '  if (!start) { showMsg("請選擇開始時間", "err"); return; }\n' +
    '  if (!end) { showMsg("請選擇結束時間", "err"); return; }\n' +
    '  if (end <= start) { showMsg("結束時間需晚於開始時間", "err"); return; }\n' +
    "  self.disabled = true;\n" +
    '  showMsg("建立中...", "loading");\n' +
    "  fetch(SCRIPT_URL, {\n" +
    '    method: "POST",\n' +
    '    mode: "no-cors",\n' +
    '    headers: { "Content-Type": "text/plain" },\n' +
    '    body: JSON.stringify({ action: "createEvent", title: title, start: start, end: end, location: location, note: note })\n' +
    "  }).then(function() {\n" +
    '    showMsg("✅ 行程已建立！", "ok");\n' +
    "    setTimeout(function() { try { liff.closeWindow(); } catch(e) {} }, 1500);\n" +
    "  }).catch(function() {\n" +
    '    showMsg("❌ 送出失敗，請重試", "err");\n' +
    "    self.disabled = false;\n" +
    "  });\n" +
    "});\n" +
    "<\/script>\n" +
    "<\/body>\n" +
    "<\/html>"
  );
}

// ===== 測試發送訊息 =====
function testSend() {
  const token = (PROPS.getProperty("LINE_ACCESS_TOKEN") || "").trim();
  const userId = (PROPS.getProperty("OWNER_USER_ID") || "").trim();
  _sendLineMessage(token, userId, "測試訊息 " + new Date());
}
