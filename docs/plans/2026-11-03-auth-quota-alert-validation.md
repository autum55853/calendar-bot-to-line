# 資安、額度、告警、輸入驗證 四項優化

## 背景

程式碼審視（2026-11-03）找出四個高優先問題，本計畫一次處理。範圍僅限 `Code.gs`、文件、新增測試；不碰其他重構項（重複程式碼抽取、cache 鎖、訊息分段等，另案）。

## 項目與決策

### 1. `doPost` 身分驗證

- **LIFF `createEvent`**：前端送 `liff.getIDToken()`；後端打 `POST https://api.line.me/oauth2/v2.1/verify`（`id_token` + `client_id`），取回 `sub`（userId），須為 `OWNER_USER_ID` 或 `CONTACT_USER_ID`。
  - `client_id` = `LIFF_APP_ID` 的 `-` 前段（channel ID），不新增 env var。
  - 驗證放在取 lock 之前，失敗回 `{ ok:false, error:"未授權" }` 並 log。
- **LINE webhook**：`event.source.userId` 不在白名單就略過並 log。
- 白名單未設定（owner/contact 皆空）= 全部拒絕（fail closed）。
- **殘餘風險**：GAS 讀不到 `x-line-signature`，webhook 無法驗簽；webhook 路徑只靠 userId 白名單（userId 為不公開資訊，但非密鑰）。
- **部署前提**：LIFF App 的 Scope 必須勾 `openid`，否則 `getIDToken()` 回 null；Web App 需重新部署新版本。

### 2. 推播額度

- 每日提醒的「contact 送達確認」改為**只在失敗時**發給 owner；成功只寫 log。
- 每日基準從 3 則降為 2 則（約省 30 則/月）。

### 3. 失敗主動告警

- 新增 `_alertOwner(context, err)`：推播給 owner，內容含 context 與錯誤訊息；同一 context 10 分鐘內只發一次（cache 節流），避免告警風暴；告警本身失敗只 log，不再拋。
- 套用位置：
  - `onCalendarChange`：外層錯誤（含設定缺失）告警後 rethrow；單一收件者發送失敗彙整後告警一次。
  - `sendDailyReminders`：設定缺失由「靜默 return」改為 throw；整體例外告警後 rethrow。
- **不做自動重試**：重發會讓已成功的收件者收到重複通知；改為告警讓人處理。

### 4. 日期與時間驗證

- `_parseDateTime`：解析後做 round-trip 比對（`Utilities.formatDate` 結果須等於輸入），擋掉 `2026/13/45`、`2026/02/31` 等。
- 兩條建立路徑（文字、LIFF）都檢查 `end > start`。
- 文字路徑：`eventResource` 建構移入 `try`，任何例外都回覆使用者。

## 驗收條件

- [x] 本地測試（node 內建 `node:test`，無新增套件）全綠（25/25；舊版 Code.gs 跑同一份測試 20 項失敗，確認測試有效）：`_parseDateTime` 合法/非法日期、`_looksLikeEventData`、`_createEventFromText` 的 end<=start 與非法日期回覆、`doPost` 白名單（webhook 與 createEvent，含驗證失敗/成功）、`sendDailyReminders` 成功時只發 2 則、contact 失敗時發告警、`_alertOwner` 節流。
- [x] `grep` 確認無殘留舊行為（無條件確認訊息、靜默 return）。
- [x] `CLAUDE.md` / `README.md` 同步（openid scope、重新部署、告警行為、5000ms→30000ms 文件錯誤順手修正）。
- [ ] 使用者端到端確認一次（真實 LINE：LIFF 建立行程成功；非白名單被拒無法本地驗證）。

## 完成後

計畫驗收項全過 → 移至 `docs/plans/archive/`。
