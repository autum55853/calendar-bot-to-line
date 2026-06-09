# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 專案概述

Google Apps Script 專案，監聽 Google Calendar 事件變更並透過 LINE Messaging API 推播通知給兩位指定使用者。無 npm、無 build 系統，直接複製貼上至 [script.google.com](https://script.google.com)。

## 部署方式

此專案無 CLI deploy 工具。所有變更需手動同步：

1. 將 `Code.gs` 內容貼入 Apps Script 編輯器
2. 將 `appsscript.json` 覆蓋原有資訊清單（需在專案設定開啟顯示）
3. 執行 `setup()` 函式重建 trigger（會清除所有舊 trigger 再重建）

## 設定（Script Properties，非 .env）

所有機密存於 Apps Script **Script Properties**，不寫死在程式碼：

| Key | 說明 |
|---|---|
| `LINE_ACCESS_TOKEN` | LINE Bot Channel Access Token |
| `OWNER_USER_ID` | 擁有者 LINE userId（`U` 開頭） |
| `CONTACT_USER_ID` | 對方 LINE userId（`U` 開頭） |
| `CALENDAR_IDS` | 逗號分隔的 Calendar ID |
| `LIFF_APP_ID` | LIFF App ID（格式：`1234567890-xxxxxxxx`），用於「新增行程」表單 |
| `MUTE_KEYWORDS` | 逗號分隔的靜音關鍵字，含此關鍵字的行程不發任何通知（選填） |

`.env` 僅供本地參考，**不會被 Apps Script 讀取**。

## 架構

- **`Code.gs`** — 唯一程式碼檔案，含所有邏輯
- **`appsscript.json`** — 宣告 Google Calendar Advanced Service（`Calendar` v3）與時區 `Asia/Taipei`

### 主要函式

| 函式 | 觸發方式 | 說明 |
|---|---|---|
| `setup()` | 手動執行一次 | 清除舊 trigger、初始化 syncToken、建立新 trigger |
| `onCalendarChange(e)` | Calendar onEventUpdated trigger | 用 syncToken 增量取得變更事件，判斷新增/修改/刪除並發 LINE |
| `sendDailyReminders()` | Time-based trigger 每天 09:00 | 查詢所有日曆明日事件，跨日曆去重後發 LINE |
| `doGet(e)` | HTTP GET（LINE 富選單點擊） | 回傳 LIFF 表單 HTML 供使用者新增行程 |
| `doPost(e)` | HTTP POST（LINE webhook 與 LIFF 表單提交） | 處理 LINE 訊息與 LIFF `createEvent` 表單提交 |

### 關鍵設計細節

- **syncToken 機制**：`onCalendarChange` 使用 `SYNC_TOKEN_<calendarId>` 做增量同步，避免重複通知。HTTP 410 錯誤時自動重設 syncToken。
- **新增 vs 修改判斷**：`created` 與 `updated` 時間差 < 5000ms 視為新建。
- **跨日曆去重**：`sendDailyReminders` 用 `event.id` 和 `標題|開始時間` 雙重 key 去重，防止同步至多個日曆的事件重複出現。
- **訊息發送**：同一事件通知同時推播給 `OWNER_USER_ID` 和 `CONTACT_USER_ID`。

## LIFF 新增行程表單

「新增行程」功能使用 LINE LIFF 開啟 HTML 表單（`doGet` 回傳），使用者可用 date picker 填入時間。

**設定步驟：**
1. 前往 LINE Developers Console → Messaging API 頻道 → LIFF 頁籤
2. 建立新 LIFF App：Size = Full，Endpoint URL = Apps Script Web App URL
3. 取得 LIFF ID（格式：`1234567890-xxxxxxxx`）
4. 在 Script Properties 設定 `LIFF_APP_ID`

**CORS 限制：** LIFF 表單送出用 `fetch` + `mode: 'no-cors'`（避免 preflight），回應為 opaque 型態無法讀取，前端採樂觀 UI（送出即顯示成功）。時間統一以台灣時區（UTC+8）處理。

## 注意事項

- 修改 trigger 數量或日曆清單時需重新執行 `setup()`
- `sendDailyReminders` 的觸發時間有 ±15 分鐘誤差（Apps Script 限制）
- LINE push message 需付費方案或在每月 200 則免費額度內
