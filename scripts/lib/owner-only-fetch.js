// 真實推播測試的安全閘：只放行 push 給 OWNER，其餘一律攔截（不送出、回假 200）。
// realFetch(url, options) → { code, text }，只有通過檢查的請求才會呼叫。
const PUSH_SUFFIX = "/message/push";

function makeOwnerOnlyFetch(ownerId, realFetch) {
  if (!ownerId) throw new Error("ownerId 不可為空");
  const sent = [];
  const blocked = [];

  function fetch(url, options) {
    const isPush = String(url).endsWith(PUSH_SUFFIX);
    const body = isPush ? JSON.parse(options.payload) : null;
    // 非 push（reply / verify 等）一律攔截：測試只允許對 owner 的 push
    if (!isPush || body.to !== ownerId) {
      blocked.push({ url, to: body && body.to });
      return { code: 200, text: "{}" };
    }
    // 標記為測試訊息，避免 owner 誤認為真實通知
    const marked = Object.assign({}, body, {
      messages: body.messages.map((m, i) => (i === 0 ? Object.assign({}, m, { text: "🧪 [測試]\n" + m.text }) : m)),
    });
    const res = realFetch(url, Object.assign({}, options, { payload: JSON.stringify(marked) }));
    sent.push({ to: body.to, text: marked.messages[0].text, code: res.code });
    return res;
  }

  return { fetch, sent, blocked };
}

module.exports = { makeOwnerOnlyFetch };
