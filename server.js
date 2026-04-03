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

// ✅ 현재 턴 발화 우선 + 컨텍스트 파라미터 fallback
const dateText = String(
body?.userRequest?.utterance ??
params.await_date ??
detailParams?.await_date?.origin ??
params.date_text ??
detailParams?.date_text?.origin ??
""
).trim();

// 디버그 로그
console.log("[/e10] params =", params);
console.log("[/e10] detailParams =", detailParams);
console.log("[/e10] utterance =", utterance);
console.log("[/e10] resolved dateText =", dateText);

const parsed = parseDateText(dateText);
console.log("[/e10] parsed =", parsed);
const payload = {
version: "2.0",
template: { outputs: [{ simpleText: { text: `입력한 날짜: ${parsed.date_ymd}` } }] },
action: { clientExtra: { parse_error: "NONE", date_ymd: parsed.date_ymd } }
};
console.log("[/e10] response payload =", JSON.stringify(payload));
return res.status(200).json(payload);
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

/* ---------------- 날짜 파싱 ---------------- */

function parseDateText(text) {
if (!text) return { ok: false };

const now = new Date();
const currentYear = now.getFullYear();

const t = String(text).trim().replace(/\s+/g, " ");

// 상대 날짜
if (t === "오늘") return { ok: true, date_ymd: formatYmd(now) };
if (t === "내일") {
const d = new Date(now);
d.setDate(d.getDate() + 1);
return { ok: true, date_ymd: formatYmd(d) };
}
if (t === "모레") {
const d = new Date(now);
d.setDate(d.getDate() + 2);
return { ok: true, date_ymd: formatYmd(d) };
}

let m;

// YYYY-MM-DD / YYYY.MM.DD / YYYY/MM/DD
m = t.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
if (m) return validYmd(+m[1], +m[2], +m[3]);

// M월 D일 (공백 유무 모두 허용)
m = t.match(/^(\d{1,2})\s*월\s*(\d{1,2})\s*일$/);
if (m) return validYmd(currentYear, +m[1], +m[2]);

// M/D, M-D, M.D
m = t.match(/^(\d{1,2})[./-](\d{1,2})$/);
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
app.post("/e20", (req, res) => {
try {
const body = req.body || {};
const action = body.action || {};
const params = action.params || {};
const detailParams = action.detailParams || {};

const utterance = String(body?.userRequest?.utterance || "").trim();

const hourText = String(
utterance ??
params.hour_text ??
detailParams?.hour_text?.origin ??
""
).trim();

const dateYmd = String(
params.date_ymd ??
detailParams?.date_ymd?.origin ??
""
).trim();

const t = parseTimeText(hourText);

let parse_error = "NONE";
let time_hhmm = "";
let hour24 = "";

if (!t.ok) {
parse_error = "TIME_INVALID";
} else if (!isInBusinessHours(t.hour, t.minute)) {
parse_error = "OUT_OF_RANGE";
} else if (dateYmd && isPastDateTime(dateYmd, t.hour, t.minute)) {
parse_error = "PAST_TIME";
} else {
time_hhmm = `${pad2(t.hour)}:${pad2(t.minute)}`;
hour24 = String(t.hour);
}

const payload = {
version: "2.0",
template: {
outputs: [
{
simpleText: {
text:
parse_error === "NONE"
? `입력한 시간: ${time_hhmm}`
: parse_error === "OUT_OF_RANGE"
? "예약 가능 시간(09:00~21:00) 내로 입력해 주세요."
: parse_error === "PAST_TIME"
? "이미 지난 시간이에요. 다시 입력해 주세요."
: "시간을 다시 입력해 주세요. (예: 오전 7시, 19시, 7:30)"
}
}
]
},
action: {
clientExtra: {
parse_error,
time_hhmm,
hour24
}
}
};

console.log("[/e20] hourText =", hourText);
console.log("[/e20] dateYmd =", dateYmd);
console.log("[/e20] result =", payload.action.clientExtra);

return res.status(200).json(payload);
} catch (e) {
console.error("[/e20] error =", e);
return res.status(200).json({
version: "2.0",
template: { outputs: [{ simpleText: { text: "시간 처리 중 오류가 발생했습니다." } }] },
action: { clientExtra: { parse_error: "TIME_INVALID", time_hhmm: "", hour24: "" } }
});
}
});
