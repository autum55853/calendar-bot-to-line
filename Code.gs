// ===== 設定區 =====
// 在 Script Properties 設定以下 key（勿直接寫在程式碼）：
//   LINE_ACCESS_TOKEN   — LINE Bot Channel Access Token
//   OWNER_USER_ID       — 你自己的 LINE userId（以 U 開頭）
//   CONTACT_USER_ID     — 對方的 LINE userId（以 U 開頭）
//   CALENDAR_IDS        — 逗號分隔的 Calendar ID 清單
//                         例：me@gmail.com,abc123@group.calendar.google.com

const PROPS = PropertiesService.getScriptProperties();
const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";
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

  (result.items || []).forEach((item) => {
    const text = _formatChangeMessage(item);
    if (!text) return;
    [ownerUserId, contactUserId].forEach((userId) => _sendLineMessage(token, userId, text));
    Logger.log("已發送變更通知：" + (item.summary || item.id));
  });
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
