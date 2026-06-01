# Google Calendar → LINE 行程通知

## 架構

```
Google Calendar 新增 / 修改 / 刪除事件
  → Apps Script Calendar Trigger (onEventUpdated)
  → 判斷事件類型（新增 / 修改 / 刪除）
  → LINE Messaging API push message → 兩位使用者各自對話視窗

每天 09:00（Asia/Taipei）
  → Time-based Trigger (sendDailyReminders)
  → 查詢隔天所有行程
  → LINE 發送明日提醒
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

#### 取得 userId（OWNER / CONTACT）

兩人都必須先加 Bot 為好友，對 Bot 傳任意訊息。  
Webhook handler 中印出 `event.source.userId` 即可取得各自的 userId（`U` 開頭）。

> 若尚未架設 Webhook server，可在 LINE Developers Console →  
> **Messaging API → Webhook URL** 填入 [Webhook.site](https://webhook.site) 的臨時 URL，  
> 傳訊後直接在網頁看到 `source.userId`。

### 4. 執行 setup()

1. 選擇函式 `setup`
2. 點選 **執行**
3. 第一次需授權 Google 帳號權限
4. 執行記錄顯示「Setup 完成。已建立 N 個 trigger」即成功（N = 日曆數 + 1）

### 5. 測試

- **變更通知**：在 Google Calendar 新增、修改或刪除一個事件，數秒後 LINE 應收到對應通知。
- **明日提醒**：選函式 `sendDailyReminders` → 執行，確認 LINE 收到明日行程列表（需有隔天的行程）。

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

## 注意事項

- `setup()` 只需執行一次；重複執行會自動清除舊 trigger
- 每天 09:00 提醒依 `appsscript.json` 的 `timeZone: Asia/Taipei`，實際觸發有 ±15 分鐘誤差
- 明日無行程時不發通知
- syncToken 過期（HTTP 410）時腳本會自動重設，不影響後續通知
- LINE Messaging API push message 需要 **付費方案** 或在免費額度內（每月 200 則免費）
