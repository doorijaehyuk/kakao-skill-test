import express from "express";

const app = express();
app.use(express.json());

/** ===== 기본 ===== */
app.get("/", (req, res) => {
res.send("kakao skill server is running");
});

app.get("/health", (req, res) => {
res.status(200).send("ok");
});

/** =========================================================
* E10: 날짜 파싱
* - 입력: date_text (또는 utterance fallback)
* - 출력(clientExtra):
* parse_error: NONE | DATE_INVALID
* date_ymd: YYYY-MM-DD
* ========================================================= */
app.post("/e10", (req, res) => {
try {
const body = req.body || {};
const action = body.action || {};
const params = action.params || {};
const detailParams = action.detailParams || {};
const utterance = String(body?.userRequest?.utterance || "").trim();

const dateText = String(
utterance ??
params.await_date ??
detailParams?.await_date?.origin ??
params.date_text ??
detailParams?.date_text?.origin ??
""
).trim();

console.log("[/e10] params =", params);
console.log("[/e10] detailParams =", detailParams);
console.log("[/e10] utterance =", utterance);
console.log("[/e10] resolved dateText =", dateText);

const parsed = parseDateText(dateText);
console.log("[/e10] parsed =", parsed);

if (!parsed.ok) {
const payload = {
version: "2.0",
template: {
outputs: [
{
simpleText: {
text: "날짜를 다시 입력해주세요. (예: 오늘, 내일, 2026-05-28, 5월 28일, 0528, 528, 05.28)"
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
};
console.log("[/e10] response payload =", JSON.stringify(payload));
return res.status(200).json(payload);
}

const payload = {
version: "2.0",
template: {
outputs: [
{
simpleText: {
text: `입력하신 날짜는 ${formatKoreanDate(parsed.date_ymd)} 입니다.
예약 시간을 말씀해주세요.
(예:08, 9시, 14시 / 1시간 단위로 검색됩니다.)`
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
};
console.log("[/e10] response payload =", JSON.stringify(payload));
return res.status(200).json(payload);
} catch (error) {
console.error("[/e10] error =", error);
return res.status(200).json({
version: "2.0",
template: {
outputs: [{ simpleText: { text: "서버 처리 중 오류가 발생했습니다." } }]
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

/** =========================================================
* E20: 시간 파싱
* - 입력: hour_text, date_ymd(선택)
* - 출력(clientExtra):
* parse_error: NONE | TIME_INVALID | OUT_OF_RANGE | PAST_TIME
* time_hhmm: HH:mm
* hour24: 0~23
* ========================================================= */
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

console.log("[/e20] params =", params);
console.log("[/e20] detailParams =", detailParams);
console.log("[/e20] utterance =", utterance);
console.log("[/e20] resolved hourText =", hourText);
console.log("[/e20] resolved dateYmd =", dateYmd);

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

const text =
parse_error === "NONE"
? `예약 시간은 ${Number(hour24)}시 입니다. 예약 가능 시간 검색 하겠습니다.`
: parse_error === "OUT_OF_RANGE"
? "예약 가능 시간(05:00~14:59) 내로 입력해 주세요."
: parse_error === "PAST_TIME"
? "이미 지난 시간이에요. 다시 입력해 주세요."
: "시간을 다시 입력해 주세요. (예: 07, 7시, 오전 7시, 13:30)";

const payload = {
version: "2.0",
template: {
outputs: [{ simpleText: { text } }]
},
action: {
clientExtra: {
parse_error,
time_hhmm,
hour24
}
}
};

console.log("[/e20] result =", payload.action.clientExtra);
console.log("[/e20] response payload =", JSON.stringify(payload));
return res.status(200).json(payload);
} catch (error) {
console.error("[/e20] error =", error);
return res.status(200).json({
version: "2.0",
template: {
outputs: [{ simpleText: { text: "시간 처리 중 오류가 발생했습니다." } }]
},
action: {
clientExtra: {
parse_error: "TIME_INVALID",
time_hhmm: "",
hour24: ""
}
}
});
}
});

/** ===== 서버 시작 ===== */
const port = process.env.PORT || 3000;
app.listen(port, () => {
console.log(`server listening on port ${port}`);
});

/** ===== 유틸: 날짜 ===== */
function parseDateText(text) {
if (!text) return { ok: false };

const now = new Date();
const currentYear = now.getFullYear();

// 공백/끝점 정리
const t = String(text).trim().replace(/\s+/g, " ").replace(/\.$/, "");

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

// M월 D일
m = t.match(/^(\d{1,2})\s*월\s*(\d{1,2})\s*일$/);
if (m) return validYmd(currentYear, +m[1], +m[2]);

// M/D, M-D, M.D
m = t.match(/^(\d{1,2})[./-](\d{1,2})$/);
if (m) return validYmd(currentYear, +m[1], +m[2]);

// 3~4자리 숫자 날짜 (예: 528, 0528, 1225)
m = t.match(/^(\d{3,4})$/);
if (m) {
const digits = m[1];
const month = Number(digits.slice(0, digits.length - 2));
const day = Number(digits.slice(-2));
return validYmd(currentYear, month, day);
}

return { ok: false };
}

function validYmd(y, m, d) {
const dt = new Date(y, m - 1, d);
const ok =
dt.getFullYear() === y &&
dt.getMonth() + 1 === m &&
dt.getDate() === d;

if (!ok) return { ok: false };
return { ok: true, date_ymd: `${y}-${pad2(m)}-${pad2(d)}` };
}

function formatYmd(d) {
return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** ===== 유틸: 시간 ===== */
function parseTimeText(raw) {
if (!raw) return { ok: false };

let text = String(raw).replace(/\s+/g, " ").trim();
let ampm = null;

if (/오전/.test(text)) ampm = "AM";
if (/오후/.test(text)) ampm = "PM";
text = text.replace(/오전|오후/g, "").trim();

let hour = null;
let minute = 0;

// HH:MM
let m = text.match(/^(\d{1,2})\s*:\s*(\d{1,2})$/);
if (m) {
hour = +m[1];
minute = +m[2];
} else {
// HH시, HH시MM분
m = text.match(/^(\d{1,2})\s*시\s*(\d{1,2})?\s*분?$/);
if (m) {
hour = +m[1];
minute = m[2] ? +m[2] : 0;
} else {
// HH (예: 07, 7)
m = text.match(/^(\d{1,2})$/);
if (m) {
hour = +m[1];
minute = 0;
}
}
}

if (hour === null) return { ok: false };
if (minute < 0 || minute > 59) return { ok: false };

// 오전/오후 처리
if (ampm === "AM") {
if (hour === 12) hour = 0;
} else if (ampm === "PM") {
if (hour >= 1 && hour <= 11) hour += 12;
}

if (hour < 0 || hour > 23) return { ok: false };
return { ok: true, hour, minute };
}

function isInBusinessHours(hour, minute) {
// 05:00 ~ 14:59 허용
if (hour < 5) return false;
if (hour > 14) return false;
return true;
}

function isPastDateTime(dateYmd, hour, minute) {
const [y, m, d] = String(dateYmd).split("-").map(Number);
if (!y || !m || !d) return false;
const target = new Date(y, m - 1, d, hour, minute, 0, 0);
return target.getTime() < Date.now();
}

function pad2(n) {
return String(n).padStart(2, "0");
}

