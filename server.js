import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const TZ_OFFSET_MS = 9 * 60 * 60 * 1000; // KST

/** ===== 기본 ===== */
app.get("/", (_, res) => res.send("kakao skill server is running"));
app.get("/health", (_, res) => res.status(200).send("ok"));

/** ===== 공통 응답 ===== */
function replyText(text, clientExtra = {}) {
return {
version: "2.0",
template: { outputs: [{ simpleText: { text } }] },
action: { clientExtra }
};
}

/** ===== 공통 타임아웃 가드 (카카오 5초 대응) ===== */
function withTimeoutGuard(res, fallbackText = "요청 처리 중입니다. 잠시 후 다시 시도해 주세요.") {
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

/** =========================================================
* E10: 날짜 파싱
* ========================================================= */
app.post("/e10", (req, res) => {
const safe = withTimeoutGuard(res);

try {
const body = req.body || {};
const action = body.action || {};
const params = action.params || {};
const detailParams = action.detailParams || {};
const utterance = String(body?.userRequest?.utterance || "").trim();

// ✅ 파라미터 우선, utterance fallback
const dateText = String(
params.await_date ||
detailParams?.await_date?.origin ||
params.date_text ||
detailParams?.date_text?.origin ||
utterance ||
""
).trim();

const parsed = parseDateText(dateText);

if (!parsed.ok) {
return safe.send(
replyText(
"날짜를 다시 입력해주세요. (예: 오늘, 내일, 5월 28일, 2026-05-28, 0528, 528, 05.28)",
{ parse_error: "DATE_INVALID", date_ymd: "" }
)
);
}

return safe.send(
replyText(
`입력하신 날짜는 ${formatKoreanDate(parsed.date_ymd)} 입니다.\n예약 시간을 말씀해주세요.\n(예:08, 9시, 14시 / 1시간 단위로 검색됩니다.)`,
{ parse_error: "NONE", date_ymd: parsed.date_ymd }
)
);
} catch (e) {
return safe.fail("서버 처리 중 오류가 발생했습니다.", {
parse_error: "DATE_INVALID",
date_ymd: ""
});
}
});

/** =========================================================
* E20: 시간 파싱
* ========================================================= */
app.post("/e20", (req, res) => {
const safe = withTimeoutGuard(res);

try {
const body = req.body || {};
const action = body.action || {};
const params = action.params || {};
const detailParams = action.detailParams || {};
const utterance = String(body?.userRequest?.utterance || "").trim();

// ✅ 파라미터 우선, utterance fallback
const hourText = String(
params.hour_text ||
detailParams?.hour_text?.origin ||
utterance ||
""
).trim();

const dateYmd = String(
params.date_ymd ||
detailParams?.date_ymd?.origin ||
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
} else if (dateYmd && isPastDateTimeKST(dateYmd, t.hour, t.minute)) {
parse_error = "PAST_TIME";
} else {
time_hhmm = `${pad2(t.hour)}:${pad2(t.minute)}`;
hour24 = String(t.hour);
}

if (parse_error !== "NONE") {
const msg =
parse_error === "OUT_OF_RANGE"
? "예약 가능 시간(05:00~14:59) 내로 입력해 주세요."
: parse_error === "PAST_TIME"
? "이미 지난 시간이에요. 다시 입력해 주세요."
: "시간을 다시 입력해 주세요. (예: 07, 7시, 오전 7시, 13:30)";
return safe.send(replyText(msg, { parse_error, time_hhmm: "", hour24: "" }));
}

return safe.send(
replyText(
`예약 시간은 ${Number(hour24)}시 입니다. 예약 가능 시간 검색 하겠습니다.`,
{ parse_error: "NONE", time_hhmm, hour24 }
)
);
} catch (e) {
return safe.fail("시간 처리 중 오류가 발생했습니다.", {
parse_error: "TIME_INVALID",
time_hhmm: "",
hour24: ""
});
}
});

/** =========================================================
*
ROUTER: 폴백 우회용 라우터
* - 입력: utterance, stage (DATE | TIME)
* ========================================================= */
app.post("/router", (req, res) => {
const safe = withTimeoutGuard(res);

try {
const body = req.body || {};
const action = body.action || {};
const params = action.params || {};
const detailParams = action.detailParams || {};

const utterance = String(
body?.userRequest?.utterance ||
params.utterance ||
detailParams?.utterance?.origin ||
""
).trim();

const dateYmdHint = String(
params.date_ymd ||
detailParams?.date_ymd?.origin ||
""
).trim();

// ✅ stage 기본 추론 추가
let stage = String(
params.stage ||
detailParams?.stage?.origin ||
""
).trim().toUpperCase();

if (!stage) {
stage = dateYmdHint ? "TIME" : "DATE";
}

if (stage === "DATE") {
const d = parseDateText(utterance);

if (!d.ok) {
return safe.send(
replyText(
"날짜를 다시 입력해주세요. (예: 오늘, 내일, 5월 28일, 0528)",
{ parse_error: "DATE_INVALID", date_ymd: "", stage: "DATE" }
)
);
}

return safe.send(
replyText(
`입력하신 날짜는 ${formatKoreanDate(d.date_ymd)} 입니다.\n예약 시간을 말씀해주세요.\n(예:08, 9시, 14시 / 1시간 단위로 검색됩니다.)`,
{ parse_error: "NONE", date_ymd: d.date_ymd, stage: "TIME" }
)
);
}

if (stage === "TIME") {
const t = parseTimeText(utterance);

if (!t.ok) {
return safe.send(
replyText(
"시간을 다시 입력해 주세요. (예: 07, 7시, 오전 7시, 13:30)",
{ parse_error: "TIME_INVALID", time_hhmm: "", hour24: "", stage: "TIME" }
)
);
}

if (!isInBusinessHours(t.hour, t.minute)) {
return safe.send(
replyText(
"예약 가능 시간(05:00~14:59) 내로 입력해 주세요.",
{ parse_error: "OUT_OF_RANGE", time_hhmm: "", hour24: "", stage: "TIME" }
)
);
}

// dateYmdHint가 있으면 과거시간도 체크
if (dateYmdHint && isPastDateTimeKST(dateYmdHint, t.hour, t.minute)) {
return safe.send(
replyText(
"이미 지난 시간이에요. 다시 입력해 주세요.",
{ parse_error: "PAST_TIME", time_hhmm: "", hour24: "", stage: "TIME" }
)
);
}

const time_hhmm = `${pad2(t.hour)}:${pad2(t.minute)}`;
const hour24 = String(t.hour);

return safe.send(
replyText(
`예약 시간은 ${Number(hour24)}시 입니다. 예약 가능 시간 검색 하겠습니다.`,
{ parse_error: "NONE", time_hhmm, hour24, stage: "NEXT" }
)
);
}

return safe.send(
replyText("진행 단계 정보가 없습니다. 처음부터 다시 진행해 주세요.", {
parse_error: "STAGE_INVALID",
stage: "DATE"
})
);
} catch (e) {
return safe.fail("요청 처리 중 오류가 발생했습니다.", {
parse_error: "ERROR"
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
const currentYear = now.getUTCFullYear(); // KST 환산은 format 시 처리
const t = String(text).trim().replace(/\s+/g, " ").replace(/\.$/, "");

if (t === "오늘") return { ok: true, date_ymd: formatYmdKST(new Date()) };
if (t === "내일") return { ok: true, date_ymd: formatYmdKST(addDaysKST(new Date(), 1)) };
if (t === "모레") return { ok: true, date_ymd: formatYmdKST(addDaysKST(new Date(), 2)) };

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

// 숫자만 추출해 MMDD 처리 (528, 0528)
const digitsOnly = t.replace(/\D/g, "");
if (digitsOnly.length === 3 || digitsOnly.length === 4) {
const month = Number(digitsOnly.slice(0, digitsOnly.length - 2));
const day = Number(digitsOnly.slice(-2));
return validYmd(currentYear, month, day);
}

return { ok: false };
}

function validYmd(y, m, d) {
const dt = new Date(Date.UTC(y, m - 1, d));
const ok = dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === m && dt.getUTCDate() === d;
if (!ok) return { ok: false };
return { ok: true, date_ymd: `${y}-${pad2(m)}-${pad2(d)}` };
}

function formatKoreanDate(ymd) {
const [y, m, d] = String(ymd).split("-");
return `${y}년 ${m}월 ${d}일`;
}

function formatYmdKST(dateObj) {
const kst = new Date(dateObj.getTime() + TZ_OFFSET_MS);
const y = kst.getUTCFullYear();
const m = kst.getUTCMonth() + 1;
const d = kst.getUTCDate();
return `${y}-${pad2(m)}-${pad2(d)}`;
}

function addDaysKST(dateObj, days) {
const kst = new Date(dateObj.getTime() + TZ_OFFSET_MS);
kst.setUTCDate(kst.getUTCDate() + days);
return new Date(kst.getTime() - TZ_OFFSET_MS);
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

let m = text.match(/^(\d{1,2})\s*:\s*(\d{1,2})$/);
if (m) {
hour = +m[1];
minute = +m[2];
} else {
m = text.match(/^(\d{1,2})\s*시\s*(\d{1,2})?\s*분?$/);
if (m) {
hour = +m[1];
minute = m[2] ? +m[2] : 0;
} else {
m = text.match(/^(\d{1,2})$/); // 7, 07
if (m) {
hour = +m[1];
minute = 0;
}
}
}

if (hour === null) return { ok: false };
if (minute < 0 || minute > 59) return { ok: false };

if (ampm === "AM") {
if (hour === 12) hour = 0;
} else if (ampm === "PM") {
if (hour >= 1 && hour <= 11) hour += 12;
}

if (hour < 0 || hour > 23) return { ok: false };
return { ok: true, hour, minute };
}

function isInBusinessHours(hour) {
// 05:00 ~ 14:59
if (hour < 5) return false;
if (hour > 14) return false;
return true;
}

function isPastDateTimeKST(dateYmd, hour, minute) {
const [y, m, d] = String(dateYmd).split("-").map(Number);
if (!y || !m || !d) return false;

// target KST -> UTC ms
const targetUtcMs = Date.UTC(y, m - 1, d, hour - 9, minute, 0, 0);

// now KST 기준 UTC ms
const nowUtcMs = Date.now();

return targetUtcMs < nowUtcMs;
}

function pad2(n) {
return String(n).padStart(2, "0");
}


