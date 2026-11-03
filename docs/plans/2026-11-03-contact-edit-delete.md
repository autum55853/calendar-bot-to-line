# CONTACT 可修改／刪除「自己建立的」行程

## 背景與已定決策（2026-11-03 與 Amber 確認）

| 項目 | 決策 |
|---|---|
| 操作方式 | LIFF：行程列表頁 + 編輯表單（date picker），不走文字指令 |
| 權限範圍 | CONTACT 只能改／刪「自己建立」的行程；舊行程（無建立者標記）CONTACT 不能動 |
| 刪除確認 | 需二次確認（前端 `confirm`，後端不信任前端，仍驗權限） |
| OWNER | 假設可改／刪所有行程（未特別指定，若要限縮再說） |

## 設計

### 1. 記錄建立者
- 新增行程時（LIFF `createEvent`、文字 `_createEventFromText`）寫入 `extendedProperties.private.createdBy = <verified LINE userId>`。
- `_createEventFromText` 目前沒收 userId → 簽名加參數，`_handleLineMessage` 往下傳（webhook 已有 `source.userId`）。
- 既有行程無此欄位 → CONTACT 無權；OWNER 不受限。

### 2. 後端 API（`doPost`，沿用 `_verifyLiffIdToken` + `_isAllowedUser`）
- `action: "updateEvent"` ：`eventId, title, start, end, location, note`
- `action: "deleteEvent"` ：`eventId`
- 共用 `_authorizeEventChange(userId, eventId)`：撈 event（`calendarIds[0]`）→ OWNER 通過；CONTACT 須 `createdBy === userId`；否則 `{ok:false, error:"無權限"}` 並 log。
- 欄位驗證複用 createEvent（抽出共用函式，不複製貼上）。進 `LockService`。
- update 用 `Calendar.Events.patch`（保留 reminders 以外欄位），時間改變時重算 9:00 提醒（同 create 邏輯）。
- 通知：沿用 `onCalendarChange`，雙方都會收到修改／刪除通知（不新增邏輯）。

### 3. 列表 API（**需先 spike**）
前端是 `no-cors` POST，讀不到回應，列表無法走現有通道。候選：
- A. `doGet?action=list&idToken=...` 回 JSON（GAS ContentService GET 通常帶 CORS，可 fetch 讀取）
- B. `google.script.run`（頁面由 GAS HtmlService 提供）
先在真實部署驗證 A 在 LINE 內建瀏覽器是否可讀；不行再用 B。idToken 放 query 會進 GAS 執行記錄／網址，優先選 B 或改 POST+可讀回應方案，spike 時一併評估。

### 4. 前端
- 同一個 LIFF 頁加 tab：「新增」／「我的行程」。
- 列表顯示：OWNER＝近期全部；CONTACT＝自己建立且未來的行程。每筆有「編輯」「刪除」。
- 編輯＝帶入現值的表單，送 `updateEvent`。
- 因 POST 為 opaque 回應：維持樂觀 UI，之後重新撈列表確認結果（可驗證是否真的成功）。

### 5. 文件
- CLAUDE.md：新增 action、`createdBy` 規則、權限矩陣。README 同步。

## 測試（`node --test tests/code.test.js`，mock GAS 全域）
- CONTACT 改／刪自己建立的 → 成功
- CONTACT 改／刪 OWNER 建立的、舊行程（無標記）→ 無權限，不呼叫 patch/delete
- OWNER 改／刪任意 → 成功
- 非白名單／idToken 驗證失敗 → 未授權
- 新增行程會寫入 `createdBy`（LIFF 與文字兩條路徑）
- 時間錯誤、缺欄位、eventId 不存在
- 改完跑 `tests/owner-only.test.js`、既有測試全綠

## 風險
- 列表通道（§3）是最大未知，spike 失敗會改變前端做法。
- 部署需手動：貼 `Code.gs` → 部署**新版本**；LIFF 無需改設定（沿用同一個 LIFF App）。
- 多日曆同步的事件副本：僅以 `calendarIds[0]` 的 event 為準，其他日曆的副本由 Google 同步。

## 驗收
- CONTACT 在 LINE 內開 LIFF：只看到自己建立的未來行程，可改、可刪（有確認）。
- CONTACT 對他人行程直接送 API → 被拒（測試覆蓋）。
- 雙方收到修改／刪除通知。
