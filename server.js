import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const TZ_OFFSET_MS = 9 * 60 * 60 * 1000; // KST

app.get("/", (_, res) => res.send("kakao skill server is running"));
app.get("/health", (_, res) => res.status(200).send("ok"));

function replyText(text, clientExtra = {}) {
return {
version: "2.0",
template: { outputs: [{ simpleText: { text } }] },
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

function reqMeta(body = {}) {
return {
utterance: String(body?.userRequest?.utterance || "").trim(),
userId: String(body?.userRequest?.user?.id || ""),
skillId: String(body?.action?.id || ""),
blockId: String(body?.contexts?.[0]?.id || "")
};
}

/** E10: 날짜 */
app.post("/e10", (req, res) => {
const safe = withTimeoutGuard(res);
try {
const body = req.body || {};
const action = body.action || {};
const params = action.params || {};
const detailParams = action.detailParams || {};
const utterance = String(body?.userRequest?.utterance || "").trim();

// 운영 정합성: date_text 우선, await_date는 호환용
const dateText = String(
params.date_text ||
detailParams?.date_text?.origin ||
params.await_date ||
detailParams?.await_date?.origin ||
utterance ||
""
).trim();

const parsed = parseDateText(dateText);

console.log("[E10]", {
...reqMeta(body),
params,
dateText,
parsed
});

if (!parsed.ok) {
const msg =
parsed.reason === "LIKELY_TIME"
? "시간으로 보이는 입력입니다. 시간을 말씀해 주세요. (예: 07, 7시)"
: "날짜를 다시 입력해주세요. (예: 오늘, 내일, 5월 28일, 2026-05-28, 0528, 528, 05.28)";
return safe.send(
replyText(msg, { parse_error: "DATE_INVALID", date_ymd: "" })
);
}

return safe.send(
replyText(
`입력하신 날짜는 ${formatKoreanDate(parsed.date_ymd)} 입니다.\n예약 시간을 말씀해주세요.\n(예: 08, 9시, 13:30)\n※ 분 입력은 가능하며, 조회는 해당 시간대 기준으로 진행됩니다.`,
{ parse_error: "NONE", date_ymd: parsed.date_ymd }
)
);
} catch (err) {
console.error("[E10][ERROR]", err);
return safe.fail("서버 처리 중 오류가 발생했습니다.", {
parse_error: "DATE_INVALID",
date_ymd: ""
});
}
});

/** E20: 시간 */
app.post("/e20", (req, res) => {
const safe = withTimeoutGuard(res);
try {
const body = req.body || {};
const action = body.action || {};
const params = action.params || {};
const detailParams = action.detailParams || {};
const utterance = String(body?.userRequest?.utterance || "").trim();

const hourText = String(
params.hour_text || detailParams?.hour_text?.origin || utterance || ""
).trim();

const dateYmd = String(
params.date_ymd || detailParams?.date_ymd?.origin || ""
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

console.log("[E20]", {
...reqMeta(body),
params,
dateYmd,
hourText,
parsedTime: t,
parse_error,
time_hhmm,
hour24
});

if (parse_error !== "NONE") {
const msg =
parse_error === "OUT_OF_RANGE"
? "예약 가능 시간(05:00~14:59) 내로 입력해 주세요."
: parse_error === "PAST_TIME"
? "이미 지난 시간이에요. 다시 입력해 주세요."
: "시간을 다시 입력해 주세요. (예: 07, 7시, 오전 7시, 13:30)";
return safe.send(
replyText(msg, { parse_error, time_hhmm: "", hour24: "" })
);
}

const minutePart = Number(time_hhmm.split(":")[1]);
const timeLabel = minutePart
? `${Number(hour24)}시 ${minutePart}분`
: `${Number(hour24)}시`;

return safe.send(
replyText(`${timeLabel}로 확인되었습니다. 예약 가능 시간 검색 하겠습니다.`, {
parse_error: "NONE",
time_hhmm,
hour24
})
);
} catch (err) {
console.error("[E20][ERROR]", err);
return safe.fail("시간 처리 중 오류가 발생했습니다.", {
parse_error: "TIME_INVALID",
time_hhmm: "",
hour24: ""
});
}
});

/** router: 폴백 우회 */
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
params.date_ymd || detailParams?.date_ymd?.origin || ""
).trim();

let stage = String(
params.stage || detailParams?.stage?.origin || ""
).trim().toUpperCase();

if (!stage) stage = dateYmdHint ? "TIME" : "DATE";

console.log("[ROUTER]", {
...reqMeta(body),
params,
utterance,
dateYmdHint,
stage
});

if (stage === "DATE") {
const d = parseDateText(utterance);
if (!d.ok) {
const msg =
d.reason === "LIKELY_TIME"
? "시간으로 보이는 입력입니다. 시간을 말씀해 주세요. (예: 07, 7시)"
: "날짜를 다시 입력해주세요. (예: 오늘, 내일, 5월 28일, 0528)";
return safe.send(
replyText(msg, {
parse_error: "DATE_INVALID",
date_ymd: "",
stage: "DATE"
})
);
}
return safe.send(
replyText(
`입력하신 날짜는 ${formatKoreanDate(d.date_ymd)} 입니다.\n예약 시간을 말씀해주세요.\n(예: 08, 9시, 13:30)\n※ 분 입력은 가능하며, 조회는 해당 시간대 기준으로 진행됩니다.`,
{ parse_error: "NONE", date_ymd: d.date_ymd, stage: "TIME" }
)
);
}

if (stage === "TIME") {
const t = parseTimeText(utterance);
if (!t.ok) {
return safe.send(
replyText("시간을 다시 입력해 주세요. (예: 07, 7시, 오전 7시, 13:30)", {
parse_error: "TIME_INVALID",
time_hhmm: "",
hour24: "",
stage: "TIME"
})
);
}
if (!isInBusinessHours(t.hour, t.minute)) {
return safe.send(
replyText("예약 가능 시간(05:00~14:59) 내로 입력해 주세요.", {
parse_error: "OUT_OF_RANGE",
time_hhmm: "",
hour24: "",
stage: "TIME"
})
);
}
if (dateYmdHint && isPastDateTimeKST(dateYmdHint, t.hour, t.minute)) {
return safe.send(
replyText("이미 지난 시간이에요. 다시 입력해 주세요.", {
parse_error: "PAST_TIME",
time_hhmm: "",
hour24: "",
stage: "TIME"
})
);
}

const time_hhmm = `${pad2(t.hour)}:${pad2(t.minute)}`;
const hour24 = String(t.hour);
const minutePart = Number(time_hhmm.split(":")[1]);
const timeLabel = minutePart
? `${Number(hour24)}시 ${minutePart}분`
: `${Number(hour24)}시`;

return safe.send(
replyText(`${timeLabel}로 확인되었습니다. 예약 가능 시간 검색 하겠습니다.`, {
parse_error: "NONE",
time_hhmm,
hour24,
stage: "NEXT"
})
);
}

return safe.send(
replyText("진행 단계 정보가 없습니다. 처음부터 다시 진행해 주세요.", {
parse_error: "STAGE_INVALID",
stage: "DATE"
})
);
} catch (err) {
console.error("[ROUTER][ERROR]", err);
return safe.fail("요청 처리 중 오류가 발생했습니다.", { parse_error: "ERROR" });
}
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
console.log(`server listening on port ${port}`);
});

/* ===== utils ===== */

function parseDateText(text) {
if (!text) return { ok: false };

// 버그 수정: KST 기준 연도 사용
const currentYear = getKstNowParts().year;
const t = String(text).trim().replace(/\s+/g, " ").replace(/\.$/, "");
const digitsOnly = t.replace(/\D/g, "");

// 1~2자리 숫자는 날짜로 보지 않음 (시간 후보)
if (/^\d{1,2}$/.test(digitsOnly)) {
return { ok: false, reason: "LIKELY_TIME" };
}

if (t === "오늘") return { ok: true, date_ymd: formatYmdKST(new Date()) };
if (t === "내일") return { ok: true, date_ymd: formatYmdKST(addDaysKST(new Date(), 1)) };
if (t === "모레") return { ok: true, date_ymd: formatYmdKST(addDaysKST(new Date(), 2)) };

let m;
m = t.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
if (m) return validYmd(+m[1], +m[2], +m[3]);

m = t.match(/^(\d{1,2})\s*월\s*(\d{1,2})\s*일$/);
if (m) return validYmd(currentYear, +m[1], +m[2]);

m = t.match(/^(\d{1,2})[./-](\d{1,2})$/);
if (m) return validYmd(currentYear, +m[1], +m[2]);

// 3~4자리 숫자만 MMDD 처리 (0528, 528)
if (/^\d{3,4}$/.test(digitsOnly)) {
const month = Number(digitsOnly.slice(0, digitsOnly.length - 2));
const day = Number(digitsOnly.slice(-2));
return validYmd(currentYear, month, day);
}

return { ok: false };
}

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

if (ampm === "AM" && hour === 12) hour = 0;
if (ampm === "PM" && hour >= 1 && hour <= 11) hour += 12;

if (hour < 0 || hour > 23) return { ok: false };
return { ok: true, hour, minute };
}

function isInBusinessHours(hour) {
return hour >= 5 && hour <= 14; // 05:00~14:59
}

function isPastDateTimeKST(dateYmd, hour, minute) {
const [y, m, d] = String(dateYmd).split("-").map(Number);
if (!y || !m || !d) return false;
const targetUtcMs = Date.UTC(y, m - 1, d, hour - 9, minute, 0, 0);
return targetUtcMs < Date.now();
}

function validYmd(y, m, d) {
const dt = new Date(Date.UTC(y, m - 1, d));
const ok =
dt.getUTCFullYear() === y &&
dt.getUTCMonth() + 1 === m &&
dt.getUTCDate() === d;
return ok
? { ok: true, date_ymd: `${y}-${pad2(m)}-${pad2(d)}` }
: { ok: false };
}

function getKstNowParts() {
const now = new Date();
const kst = new Date(now.getTime() + TZ_OFFSET_MS);
return {
year: kst.getUTCFullYear(),
month: kst.getUTCMonth() + 1,
day: kst.getUTCDate()
};
}

function formatYmdKST(dateObj) {
const kst = new Date(dateObj.getTime() + TZ_OFFSET_MS);
return `${kst.getUTCFullYear()}-${pad2(kst.getUTCMonth() + 1)}-${pad2(
kst.getUTCDate()
)}`;
}

function addDaysKST(dateObj, days) {
const kst = new Date(dateObj.getTime() + TZ_OFFSET_MS);
kst.setUTCDate(kst.getUTCDate() + days);
return new Date(kst.getTime() - TZ_OFFSET_MS);
}

function formatKoreanDate(ymd) {
const [y, m, d] = String(ymd).split("-");
return `${y}년 ${m}월 ${d}일`;
}

function pad2(n) {
return String(n).padStart(2, "0");
}

