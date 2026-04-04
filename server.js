import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_, res) => res.send("kakao skill server is running"));
app.get("/health", (_, res) => res.status(200).send("ok"));

function replyText(text, clientExtra = {}) {
return {
version: "2.0",
template: {
outputs: [{ simpleText: { text } }]
},
action: { clientExtra }
};
}

function withTimeoutGuard(
res,
fallbackText = "요청 처리 중입니다. 잠시 후 다시 시도해 주세요."
) {
let sent = false;
const timer = setTimeout(() => {
if (!sent) {
sent = true;
res.status(200).json(replyText(fallbackText, { parse_error: "TIMEOUT" }));
}
}, 4500);

return {
send: (payload) => {
if (sent) return;
sent = true;
clearTimeout(timer);
res.status(200).json(payload);
},
fail: (text, extra = {}) => {
if (sent) return;
sent = true;
clearTimeout(timer);
res.status(200).json(replyText(text, extra));
}
};
}

/** E01: 회원/비회원 구분 */
app.post("/e01_member_type", (req, res) => {
const safe = withTimeoutGuard(res);

try {
const body = req.body || {};
const action = body.action || {};
const params = action.params || {};
const detailParams = action.detailParams || {};
const utterance = String(body?.userRequest?.utterance || "").trim();

const raw = String(
params.member_type ||
detailParams?.member_type?.origin ||
utterance ||
""
).trim();

const norm = normalizeMemberType(raw);

if (norm === "UNKNOWN") {
return safe.send(
replyText("회원/비회원을 다시 입력해주세요. (예: 회원 또는 비회원)", {
parse_error: "MEMBER_TYPE_INVALID",
member_type: ""
})
);
}

const label = norm === "MEMBER" ? "회원" : "비회원";

return safe.send(
replyText(`${label}으로 확인했습니다.\n예약자 성함을 입력해주세요.`, {
parse_error: "NONE",
member_type: norm,
member_type_label: label,
next_ctx: "ctx_name" // 디버그용
})
);
} catch (err) {
console.error("[E01][ERROR]", err);
return safe.fail("회원 구분 처리 중 오류가 발생했습니다.", {
parse_error: "MEMBER_TYPE_ERROR",
member_type: ""
});
}
});

/** E02: 이름 입력 */
app.post("/e02_name", (req, res) => {
const safe = withTimeoutGuard(res);

try {
const body = req.body || {};
const action = body.action || {};
const params = action.params || {};
const detailParams = action.detailParams || {};
const utterance = String(body?.userRequest?.utterance || "").trim();

// 슬롯필링으로 채워진 값(customer_name) 우선 사용
const rawName = String(
params.customer_name ||
detailParams?.customer_name?.origin ||
utterance ||
""
).trim();

const name = normalizeName(rawName);

if (!name || name.length < 2) {
return safe.send(
replyText("성함을 다시 입력해주세요. (예: 홍길동)", {
parse_error: "NAME_INVALID",
customer_name: ""
})
);
}

return safe.send(
replyText(`${name}님으로 확인했습니다.\n휴대폰번호를 입력해주세요. (예: 01012345678)`, {
parse_error: "NONE",
customer_name: name,
next_ctx: "ctx_phone" // 디버그용
})
);
} catch (err) {
console.error("[E02][ERROR]", err);
return safe.fail("이름 처리 중 오류가 발생했습니다.", {
parse_error: "NAME_ERROR",
customer_name: ""
});
}
});

/* ===== utils ===== */

function normalizeMemberType(text) {
const t = String(text || "").replace(/\s+/g, "");

// "비회원"이 "회원"을 포함하므로 비회원 먼저 검사
if (/비회원|일반|guest|nonmember|non-member/i.test(t)) return "NON_MEMBER";
if (/회원|member/i.test(t)) return "MEMBER";

return "UNKNOWN";
}

function normalizeName(text) {
let t = String(text || "").trim();

// 흔한 접두/접미 정리
t = t.replace(/(이름은|제 이름은|저는|입니다|이에요|예요)/g, "").trim();

// 한글/영문/공백만 허용
t = t.replace(/[^가-힣a-zA-Z\s]/g, "").replace(/\s+/g, " ").trim();

return t;
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
console.log(`server listening on port ${port}`);
});
