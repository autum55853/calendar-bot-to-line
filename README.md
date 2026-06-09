# Google Calendar → LINE 行程通知

## 架構

```
【Google Calendar 變更流程】
Google Calendar 新增 / 修改 / 刪除事件
  → Apps Script Calendar Trigger (onEventUpdated)
  → 判斷事件類型（新增 / 修改 / 刪除）
  → LINE Messaging API push message → 兩位使用者各自對話視窗

【每日提醒流程】
每天 09:00（Asia/Taipei）
  → Time-based Trigger (sendDailyReminders)
  → 查詢隔天所有行程
  → LINE 發送明日提醒

【新增行程流程】
使用者點擊 LINE 富選單「新增行程」
  → LIFF App 開啟 HTML 表單 (doGet)
  → 使用者填入日期、時間、標題、地點、說明
  → 表單 POST 至 doPost (action: createEvent)
  → 驗證資料、建立 Google Calendar 事件
```

## 部署步驟

### 1. 建立 Google Apps Script 專案

1. 前往 [script.google.com](https://script.google.com)
2. 新增專案，命名如 `GCal LINE Notifier`
3. 將 `Code.gs` 內容貼入編輯器
4. 點選 **專案設定 (齒輪)** → 勾選「在編輯器中顯示 appsscript.json 資訊清單檔案」
5. 將 `appsscript.json` 內容覆蓋原有內容

### 2. 啟用 Google Calendar Advanced Service

1. 編輯器左側 **服務 (+)** → 搜尋 **Google Calendar API** → 新增
2. 確認識別碼為 `Calendar`

### 3. 設定 Script Properties

**專案設定 → 指令碼屬性 → 新增屬性**：

| 屬性名稱 | 值 | 取得方式 |
|---|---|---|
| `LINE_ACCESS_TOKEN` | `xxxxxx...` | LINE Developers Console → Messaging API → Channel access token |
| `OWNER_USER_ID` | `Uxxxxxxxxxx` | 你自己對 Bot 傳訊息後從 Webhook log 取 userId |
| `CONTACT_USER_ID` | `Uxxxxxxxxxx` | 對方對 Bot 傳訊息後從 Webhook log 取 userId |
| `CALENDAR_IDS` | `a@gmail.com,b@gmail.com` | 逗號分隔的 Calendar ID，Google Calendar 設定 → 整合日曆 → 日曆 ID |
| `LIFF_APP_ID` | `1234567890-xxxxxxxx` | LINE Developers → Messaging API → LIFF 頁籤 → 建立 LIFF App (Size: Full) |
| `MUTE_KEYWORDS` | `信用卡結帳日,每月扣款` | 逗號分隔的靜音關鍵字，含此關鍵字的行程不發任何通知（選填） |

#### 取得 userId（OWNER / CONTACT）

兩人都必須先加 Bot 為好友，對 Bot 傳任意訊息。  
Webhook handler 中印出 `event.source.userId` 即可取得各自的 userId（`U` 開頭）。

> 若尚未架設 Webhook server，可在 LINE Developers Console →  
> **Messaging API → Webhook URL** 填入 [Webhook.site](https://webhook.site) 的臨時 URL，  
> 傳訊後直接在網頁看到 `source.userId`。

### 4. 設定 LIFF（LINE Front-end Framework）

此步可選，若要使用「新增行程」表單功能需設定：

1. 複製 Apps Script Web App URL：**部署 → 新部署 → 類型：Web 應用 → 執行身份：自己 → 誰可以存取：任何人 → 部署** → 複製 URL
2. 前往 [LINE Developers Console](https://developers.line.biz/) → 頻道設定 → Messaging API 頁籤
3. **LIFF** 區段 → 建立新 LIFF App
   - **LIFF App Name**：任意（如 `Event Creator`）
   - **Size**：`Full`
   - **Endpoint URL**：貼上上面複製的 Web App URL
   - **Permissions**：`profile`、`openid`、`email`（可選）
4. 複製生成的 **LIFF ID**（格式：`1234567890-xxxxxxxx`）
5. 回到 Script Properties，新增 `LIFF_APP_ID` = 複製的 LIFF ID

> 設定完後，在 LINE 富選單中新增按鈕，連結到 LIFF 表單：`https://liff.line.me/{LIFF_APP_ID}`

### 5. 執行 setup()

1. 選擇函式 `setup`
2. 點選 **執行**
3. 第一次需授權 Google 帳號權限
4. 執行記錄顯示「Setup 完成。已建立 N 個 trigger」即成功（N = 日曆數 + 1）

### 6. 測試

- **變更通知**：在 Google Calendar 新增、修改或刪除一個事件，數秒後 LINE 應收到對應通知。
- **明日提醒**：選函式 `sendDailyReminders` → 執行，確認 LINE 收到明日行程列表（需有隔天的行程）。
- **新增行程**（若設定 LIFF）：點擊 LINE 富選單「新增行程」連結，填入表單並提交，確認事件新增至 Google Calendar。

### 7. LINE 富選單設定（可選）

新增富選單按鈕以提升使用體驗：

1. [LINE Developers Console](https://developers.line.biz/) → Messaging API → 富選單管理
2. 新增富選單，新增按鈕如下：

| 按鈕標籤 | 動作類型 | 動作值 |
|---|---|---|
| 新增行程 | Postback / URI | `https://liff.line.me/{LIFF_APP_ID}` |
| 本週行程 | Message | `本週行程` |
| 下週行程 | Message | `下週行程` |

---

## 訊息格式範例

### 新增行程
```
📅 新行程建立
─────────────
標題：週會
開始：2026/06/05 14:00
結束：2026/06/05 15:00
📍 地點：會議室 A
📝 說明：討論 Q2 進度
```

### 修改行程
```
✏️ 行程已修改
─────────────
標題：週會
開始：2026/06/05 15:00
結束：2026/06/05 16:00
```

### 刪除行程
```
🗑️ 行程已刪除
─────────────
標題：週會
時間：2026/06/05 14:00
```

### 明日提醒（每天 09:00）
```
⏰ 明日行程提醒
─────────────
1. 晨會　2026/06/06 09:30
2. 週會　2026/06/06 14:00
   📍 會議室 A
```

---

## 新增行程功能

### 方式 1：LIFF 表單（推薦）

點擊 LINE 富選單「新增行程」，透過日期選擇器填入：
- 行程名稱（必填）
- 開始時間（必填，datetime-local 格式）
- 結束時間（必填）
- 地點（選填）
- 備註（選填）

### 方式 2：文字訊息

直接在 LINE 傳送訊息，格式如下：

**最簡形式**（預設結束時間 = 開始時間 + 1 小時）：
```
會議
2026/06/10 14:00
```

**指定結束時間**：
```
會議
2026/06/10 14:00
2026/06/10 15:00
會議室 A
```

**完整格式**（含地點與備註）：
```
會議
2026/06/10 14:00
2026/06/10 15:00
會議室 A
討論 Q3 計畫
```

系統自動建立事件並回覆確認訊息。

---

## 注意事項

### 運作細節

- **setup() 只需執行一次**；重複執行會自動清除舊 trigger 並重建
- **時區**：所有時間統一以 `Asia/Taipei`（UTC+8）處理，見 `appsscript.json`
- **每日提醒觸發**：每天 09:00，實際觸發有 ±15 分鐘誤差（Apps Script 限制）
- **跨日曆去重**：`sendDailyReminders` 用 `event.id` 和「標題|開始時間」雙重 key 去重，防止同步至多個日曆的事件重複
- **同一事件同時通知**：變更或提醒通知同時推播給 `OWNER_USER_ID` 和 `CONTACT_USER_ID`
- **syncToken 機制**：自動增量同步以減少 API 呼叫，HTTP 410 錯誤時自動重設，不影響後續通知
- **靜音功能**：若設定 `MUTE_KEYWORDS`（如「信用卡結帳日」），含此關鍵字的行程不發任何通知
- **明日無行程**：若隔天無行程，不發提醒通知
- **新增行程快取**：新增後 5 分鐘內自動註記 cache key，避免立即被 onEventUpdated trigger 重複通知
- **LINE 推播額度**：push message 需要 **付費方案** 或在免費額度內（每月 200 則免費）
- **時間篩選**：`onCalendarChange` 自動略過已過期（> 24 小時前）的事件，避免歷史資料污染
