import express from "express";

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
res.send("kakao skill server is running");
});

app.get("/health", (req, res) => {
res.status(200).send("ok");
});

app.post("/e10", (req, res) => {
try {
const body = req.body || {};
const action = body.action || {};
const params = action.params || {};
const detailParams = action.detailParams || {};
const utterance = String(body?.userRequest?.utterance || "").trim();

// ✅ date_text 추출 우선순위:
// 1) action.params.date_text
// 2) action.detailParams.date_text.origin
// 3) action.detailParams.await_date.origin (블록 파라미터명이 await_date인 경우)
// 4) userRequest.utterance
const dateText = String(
params.date_text ??
detailParams?.date_text?.origin ??
detailParams?.await_date?.origin ??
utterance ??
""
).trim();

// 디버깅 로그 (Render 로그에서 확인)
console.log("[/e10] params =", params);
console.log("[/e10] detailParams =", detailParams);
console.log("[/e10] utterance =", utterance);
console.log("[/e10] resolved dateText =", dateText);

const parsed = parseDateText(dateText);

if (!parsed.ok) {
return res.status(200).json({
version: "2.0",
template: {
outputs: [
{
simpleText: {
text: "날짜를 다시 입력해주세요. (예: 오늘, 내일, 2026-05-28, 5월 28일)"
}
}
]
},
action: {
clientExtra: {
parse_error: "DATE_INVALID",
date_ymd: ""
}
}
});
}

return res.status(200).json({
version: "2.0",
template: {
outputs: [
{
simpleText: {
text: `입력한 날짜: ${parsed.date_ymd}`
}
}
]
},
action: {
clientExtra: {
parse_error: "NONE",
date_ymd: parsed.date_ymd
}
}
});
} catch (error) {
console.error("[/e10] error =", error);
return res.status(200).json({
version: "2.0",
template: {
outputs: [
{
simpleText: {
text: "서버 처리 중 오류가 발생했습니다."
}
}
]
},
action: {
clientExtra: {
parse_error: "DATE_INVALID",
date_ymd: ""
}
}
});
}
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
console.log(`server listening on port ${port}`);
});

/* ---------- 날짜 파싱 ---------- */
function parseDateText(text) {
if (!text) return { ok: false };

const now = new Date();
const currentYear = now.getFullYear();

const normalized = text.replace(/\s+/g, " ").trim();

if (normalized === "오늘") {
return { ok: true, date_ymd: formatYmd(now) };
}

if (normalized === "내일") {
const d = new Date(now);
d.setDate(d.getDate() + 1);
return { ok: true, date_ymd: formatYmd(d) };
}

if (normalized === "모레") {
const d = new Date(now);
d.setDate(d.getDate() + 2);
return { ok: true, date_ymd: formatYmd(d) };
}

// YYYY-MM-DD
let m = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
if (m) return validYmd(+m[1], +m[2], +m[3]);

// YYYY/MM/DD
m = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
if (m) return validYmd(+m[1], +m[2], +m[3]);

// MM월 DD일 / 5월28일 / 05월 28일
m = normalized.match(/^(\d{1,2})\s*월\s*(\d{1,2})\s*일$/);
if (m) return validYmd(currentYear, +m[1], +m[2]);

// M/D
m = normalized.match(/^(\d{1,2})\/(\d{1,2})$/);
if (m) return validYmd(currentYear, +m[1], +m[2]);

return { ok: false };
}

function validYmd(y, m, d) {
const dt = new Date(y, m - 1, d);
const ok =
dt.getFullYear() === y &&
dt.getMonth() + 1 === m &&
dt.getDate() === d;

if (!ok) return { ok: false };

return {
ok: true,
date_ymd: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
};
}

function formatYmd(d) {
const y = d.getFullYear();
const m = String(d.getMonth() + 1).padStart(2, "0");
const day = String(d.getDate()).padStart(2, "0");
return `${y}-${m}-${day}`;
}
