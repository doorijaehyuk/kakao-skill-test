import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TZ = "Asia/Seoul";

// 임시 세션 저장소 (운영은 Redis 권장)
const sessions = new Map();

app.get("/health", (_, res) => res.status(200).send("ok"));

app.post("/kakao/webhook", async (req, res) => {
try {
const body = req.body || {};
const userId = body?.userRequest?.user?.id || "unknown";
const utterance = String(body?.userRequest?.utterance || "").trim();

const session = sessions.get(userId) || {
step: "INIT", // INIT -> WAIT_DATE -> WAIT_TIME -> CONFIRM
date_ymd: "",
time_hhmm: ""
};

// 1) 시작
if (/예약|시작/.test(utterance) || session.step === "INIT") {
session.step = "WAIT_DATE";
sessions.set(userId, session);
return res.json(kakaoText("예약 날짜를 입력해 주세요. (예: 오늘, 내일, 4월 5일)"));
}

// 2) 날짜 받기
if (session.step === "WAIT_DATE") {
const d = parseDate(utterance);
if (!d.ok) return res.json(kakaoText("날짜를 이해하지 못했어요. 예: 오늘, 내일, 2026-04-05"));
session.date_ymd = d.date_ymd;
session.step = "WAIT_TIME";
sessions.set(userId, session);
return res.json(kakaoText(`좋아요. ${d.date_ymd} 예약 시간을 입력해 주세요. (예: 오전 7시, 19시)`));
}

// 3) 시간 받기
if (session.step === "WAIT_TIME") {
const t = parseTime(utterance);
if (!t.ok) return res.json(kakaoText("시간을 이해하지 못했어요. 예: 오전 7시, 19시, 7:30"));
session.time_hhmm = t.time_hhmm;
session.step = "CONFIRM";
sessions.set(userId, session);

// 여기서 OpenClaw 예약 엔진 조회 호출 (3초 제한 주의)
// const r = await queryAvailability(session.date_ymd, session.time_hhmm);

return res.json(kakaoText(`${session.date_ymd} ${session.time_hhmm}로 조회할게요. 진행할까요? (네/아니오)`));
}

// 4) 확인
if (session.step === "CONFIRM") {
if (/네|예|진행|확인/.test(utterance)) {
// 실제 예약 실행 호출
// const rr = await makeReservation(...)
session.step = "INIT";
sessions.set(userId, session);
return res.json(kakaoText("예약 요청을 접수했어요. 결과를 확인해 안내드릴게요."));
}
if (/아니|취소|다시/.test(utterance)) {
session.step = "WAIT_TIME";
sessions.set(userId, session);
return res.json(kakaoText("알겠습니다. 다른 시간을 입력해 주세요."));
}
return res.json(kakaoText("진행 여부를 입력해 주세요. (네/아니오)"));
}

return res.json(kakaoText("다시 시도해 주세요."));
} catch (e) {
return res.status(200).json(kakaoText("일시적인 오류가 발생했어요. 다시 시도해 주세요."));
}
});

app.listen(PORT, () => console.log(`server on ${PORT}`));

function kakaoText(text) {
return {
version: "2.0",
template: {
outputs: [{ simpleText: { text } }]
}
};
}

function parseDate(input) {
const now = new Date();
const y = now.getFullYear();

if (input === "오늘") return { ok: true, date_ymd: fmt(now) };
if (input === "내일") {
const d = new Date(now); d.setDate(d.getDate() + 1);
return { ok: true, date_ymd: fmt(d) };
}

let m = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
if (m) return validYmd(+m[1], +m[2], +m[3]);

m = input.match(/^(\d{1,2})\s*월\s*(\d{1,2})\s*일$/);
if (m) return validYmd(y, +m[1], +m[2]);

return { ok: false };
}

function parseTime(input) {
let txt = input.replace(/\s+/g, " ").trim();
let ampm = null;
if (txt.includes("오전")) ampm = "AM";
if (txt.includes("오후")) ampm = "PM";
txt = txt.replace(/오전|오후/g, "").trim();

let h = null, m = 0;
let mm = txt.match(/^(\d{1,2})(?::(\d{1,2}))?\s*시?$/) || txt.match(/^(\d{1,2})$/);
if (!mm) return { ok: false };
h = Number(mm[1]);
m = mm[2] ? Number(mm[2]) : 0;

if (m < 0 || m > 59) return { ok: false };
if (ampm === "AM" && h === 12) h = 0;
if (ampm === "PM" && h >= 1 && h <= 11) h += 12;
if (h < 0 || h > 23) return { ok: false };

return { ok: true, time_hhmm: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` };
}

function validYmd(y, mo, d) {
const dt = new Date(y, mo - 1, d);
const ok = dt.getFullYear() === y && dt.getMonth() + 1 === mo && dt.getDate() === d;
return ok ? { ok: true, date_ymd: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}` } : { ok: false };
}

function fmt(d) {
return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}


