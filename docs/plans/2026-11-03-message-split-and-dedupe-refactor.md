# LINE 訊息分段、重複程式碼抽取、靜音關鍵字快取

承接 `2026-11-03-auth-quota-alert-validation.md` 之後的中優先項。純行為保持的重構 + 一個容錯修正。

## 項目與決策

### A. LINE 訊息超過 5000 字元
- LINE text message 上限 5000 字元，超過 push/reply 回 400，整則收不到。
- 新增 `_toLineMessages(text)`：以 4800 字為界、**依換行切段**；單行超長則硬切；最多 5 則（LINE 單次請求上限），超過則最後一則結尾加「…（已截斷）」。
- `_sendLineMessage` / `_replyLineMessage` 改用它；短訊息行為不變（仍是 1 則）。

### B. 重複程式碼抽取（行為不變）
- `_getConfig()`：統一讀 token / owner / contact / calendarIds。
- `_jsonOut(obj)`：取代 `doPost` / `_handleLiffCreateEvent` 內 9 處 `ContentService...JSON` 樣板。
- `_fetchMergedEvents(start, end, excludeMuted)`：「查所有日曆 → 以 id 與 標題|開始時間 去重 → 排序」，供 `_sendDailyReminders`（排除靜音）與 `_getWeekEventText`（不排除靜音，維持現狀）共用。

### C. 靜音關鍵字
- `_isMutedEvent` 每個事件都讀一次 PropertiesService（慢）→ 單次執行內只讀一次（GAS 每次執行全域重新初始化，無跨執行過期問題）。

## 不做（及原因）
- **cache 鎖改 LockService**：需真實 trigger 並發才能驗證，本地無法重現；既有註解也指出 script lock 會讓跨日曆互卡。另案、需線上觀測。
- **文字建立行程補 09:00 彈窗提醒**：是行為變更，非重構；待使用者決定。

## 驗收條件
- [x] 既有 25 項測試仍全綠（行為保持的證明）。
- [x] 新增測試（共 33 項全綠）：分段（短訊息 1 則、依換行切、超長單行硬切、>5 則截斷標記）、每日提醒排除靜音而週報不排除、跨日曆去重、靜音關鍵字單次執行只讀一次 property。
- [x] `grep` 確認 `ContentService.createTextOutput(JSON.stringify` 只剩 `_jsonOut` 內一處。
- [x] 文件（README 注意事項）補一句分段行為。

## 完成後
驗收全過 → 本計畫與前一份（端到端確認後）移至 `docs/plans/archive/`。
