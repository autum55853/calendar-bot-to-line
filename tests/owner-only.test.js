// 驗證真實推播煙霧測試的安全閘：只有 push 給 OWNER 才會送出。
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeOwnerOnlyFetch } = require("../scripts/lib/owner-only-fetch");

const OWNER = "Uowner";
const CONTACT = "Ucontact";
const push = (to, text = "hi") => ({ payload: JSON.stringify({ to, messages: [{ type: "text", text }] }) });
const PUSH = "https://api.line.me/v2/bot/message/push";

function setup() {
  const real = [];
  const g = makeOwnerOnlyFetch(OWNER, (url, opts) => {
    real.push(JSON.parse(opts.payload));
    return { code: 200, text: "{}" };
  });
  return { g, real };
}

test("push 給 OWNER → 實際送出，且首則加上測試標記", () => {
  const { g, real } = setup();
  g.fetch(PUSH, push(OWNER, "內容"));
  assert.equal(real.length, 1);
  assert.equal(real[0].to, OWNER);
  assert.match(real[0].messages[0].text, /^🧪 \[測試\]\n內容$/);
});

test("push 給 CONTACT → 攔截，真實 fetch 0 次", () => {
  const { g, real } = setup();
  const r = g.fetch(PUSH, push(CONTACT));
  assert.equal(real.length, 0);
  assert.equal(g.blocked.length, 1);
  assert.equal(g.blocked[0].to, CONTACT);
  assert.equal(r.code, 200);
});

test("非 push（reply / verify）一律攔截", () => {
  const { g, real } = setup();
  g.fetch("https://api.line.me/v2/bot/message/reply", { payload: JSON.stringify({ replyToken: "x", messages: [] }) });
  g.fetch("https://api.line.me/oauth2/v2.1/verify", { payload: { id_token: "x" } });
  assert.equal(real.length, 0);
  assert.equal(g.blocked.length, 2);
});

test("混合送出：只有 OWNER 的進 sent", () => {
  const { g, real } = setup();
  [OWNER, CONTACT, OWNER, "Ustranger"].forEach((to) => g.fetch(PUSH, push(to)));
  assert.equal(real.length, 2);
  assert.ok(g.sent.every((s) => s.to === OWNER));
  assert.equal(g.blocked.length, 2);
});

test("多則訊息只標記第一則", () => {
  const { g, real } = setup();
  g.fetch(PUSH, { payload: JSON.stringify({ to: OWNER, messages: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }) });
  assert.equal(real[0].messages[1].text, "b");
});

test("ownerId 為空 → 直接拋錯（fail-fast）", () => {
  assert.throws(() => makeOwnerOnlyFetch("", () => ({})), /ownerId/);
});
