const express = require('express');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;

/**
 * 현재 확보된 블록 ID
 */
const BLOCK_ID_RESERVATION_START = '69cdd92b1ccc360c0ff51c39'; // B01_예약시작
const BLOCK_ID_MEMBER_PHONE_INPUT = '69d1abb31361c36188274b8a'; // B02M_회원휴대폰입력
const BLOCK_ID_GUEST_NAME_INPUT = '69d1abc804c4b27460071bcc'; // B02N_비회원이름입력
const BLOCK_ID_MEMBER_SELECT = '69d21379bdaf9c4b9af74da0'; // B03M_회원조회결과확인 (재사용)

/**
 * 블록명 상수
 * 실제 관리자센터 블록명과 정확히 같아야 fallback 재질문이 동작함
 */
const BLOCK_NAME_MEMBER_PHONE_INPUT = 'B02M_회원휴대폰입력';
const BLOCK_NAME_GUEST_NAME_INPUT = 'B02N_비회원이름입력';
const BLOCK_NAME_GUEST_PHONE_INPUT = 'B03N_비회원휴대폰입력';
const BLOCK_NAME_MEMBER_SELECT = 'B03M_회원조회결과확인'; // 필요 시 관리자센터 블록명과 동일하게 수정
const BLOCK_NAME_RESERVATION_DATETIME_INPUT = 'B04_예약일입력'; // 실제 블록명 다르면 수정

/**
 * 사용자별 예약 세션
 * 메모리 저장이므로 재배포/재시작 시 초기화됨
 */
const bookingSessions = new Map();

/**
 * 공통 유틸
 */
function normalizePhone(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw).trim().replace(/\D/g, '');
}

function isValidMobile(phone) {
  return /^01[016789]\d{7,8}$/.test(phone);
}

function formatPhone(phone) {
  const p = normalizePhone(phone);

  if (p.length === 11) {
    return `${p.slice(0, 3)}-${p.slice(3, 7)}-${p.slice(7)}`;
  }

  if (p.length === 10) {
    return `${p.slice(0, 3)}-${p.slice(3, 6)}-${p.slice(6)}`;
  }

  return p;
}

function extractValidationRawValue(body) {
  if (!body || typeof body !== 'object') return '';
  if (body?.value?.resolved) return body.value.resolved;
  if (body?.value?.origin) return body.value.origin;
  if (body?.utterance) return body.utterance;
  return '';
}

function getActionParam(body, key) {
  return body?.action?.params?.[key] ?? '';
}

function getDetailParamValue(body, key) {
  const dp = body?.action?.detailParams?.[key];
  if (!dp) return '';
  return dp.value ?? dp.resolved ?? dp.origin ?? '';
}

function getClientExtra(body) {
  return body?.action?.clientExtra || {};
}

function getRequestId(req) {
  return req.get('X-Request-Id') || '';
}

function getUserKey(body) {
  return (
    body?.userRequest?.user?.id ||
    body?.userRequest?.user?.properties?.appUserId ||
    body?.userRequest?.user?.properties?.botUserKey ||
    body?.userRequest?.user?.properties?.plusfriendUserKey ||
    'anonymous'
  );
}

function getBookingSession(userKey) {
  if (!bookingSessions.has(userKey)) {
    bookingSessions.set(userKey, {
      memberType: '',
      name: '',
      memberNo: '',
      phone: '',
      reservationDate: '',
      reservationTime: '',
      reservationDateTime: '',
      reservationTimeZone: '',
      candidateTimes: [],
      memberCandidates: [],
      selectedMember: null,
      updatedAt: Date.now(),
    });
  }
  return bookingSessions.get(userKey);
}

function clearBookingSession(userKey) {
  bookingSessions.delete(userKey);
}

function sanitizeGuestName(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isValidGuestName(name) {
  return /^[가-힣a-zA-Z\s·]{2,20}$/.test(name);
}

function qrMessage(label, messageText) {
  return {
    label,
    action: 'message',
    messageText,
  };
}

function qrBlock(label, blockId, extra = {}) {
  return {
    label,
    action: 'block',
    blockId,
    extra,
  };
}

function textResponse(text, quickReplies = []) {
  const response = {
    version: '2.0',
    template: {
      outputs: [
        {
          simpleText: {
            text,
          },
        },
      ],
    },
  };

  if (quickReplies.length > 0) {
    response.template.quickReplies = quickReplies;
  }

  return response;
}

function parsePluginDateTimeValue(raw) {
  if (!raw) {
    return {
      value: '',
      userTimeZone: '',
    };
  }

  if (typeof raw === 'object') {
    return {
      value: raw.value || '',
      userTimeZone: raw.userTimeZone || '',
    };
  }

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return {
        value: parsed.value || '',
        userTimeZone: parsed.userTimeZone || '',
      };
    } catch (e) {
      return {
        value: raw,
        userTimeZone: '',
      };
    }
  }

  return {
    value: '',
    userTimeZone: '',
  };
}

function splitDateTimeParts(dateTimeValue) {
  if (!dateTimeValue) {
    return {
      date: '',
      time: '',
      dateTime: '',
    };
  }

  const normalized = String(dateTimeValue).trim().replace(' ', 'T');
  const parts = normalized.split('T');

  if (parts.length >= 2) {
    const date = parts[0];
    const timeRaw = parts[1];
    const time = timeRaw.slice(0, 5);

    return {
      date,
      time,
      dateTime: `${date} ${time}`,
    };
  }

  return {
    date: normalized,
    time: '',
    dateTime: normalized,
  };
}

function compactMemberTypeLabel(label) {
  const source = String(label || '').trim();
  if (!source) return '회원';
  if (source.includes('공식')) return '공식';
  if (source.includes('웹')) return '웹';
  return source.slice(0, 4);
}

/**
 * OpenClaw /v1/responses 호출부
 * 환경변수:
 * OPENCLAW_BASE_URL=http://127.0.0.1:18789
 * OPENCLAW_TOKEN=...
 * OPENCLAW_MODEL=openclaw/default
 */
function getOpenClawConfig() {
  return {
    baseUrl: (process.env.OPENCLAW_BASE_URL || 'http://127.0.0.1:18789').replace(/\/$/, ''),
    token: process.env.OPENCLAW_TOKEN || '',
    model: process.env.OPENCLAW_MODEL || 'openclaw/default',
  };
}

async function callOpenClawResponses({ user, instructions, input, maxOutputTokens = 1500 }) {
  const cfg = getOpenClawConfig();

  const headers = {
    'Content-Type': 'application/json',
  };

  if (cfg.token) {
    headers.Authorization = `Bearer ${cfg.token}`;
  }

  const resp = await fetch(`${cfg.baseUrl}/v1/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model,
      user,
      instructions,
      input,
      max_output_tokens: maxOutputTokens,
    }),
  });

  const text = await resp.text();

  if (!resp.ok) {
    throw new Error(`OpenClaw /v1/responses failed: ${resp.status} ${text}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`OpenClaw response was not valid JSON: ${text}`);
  }

  return data;
}

function extractResponsesText(responseJson) {
  if (typeof responseJson?.output_text === 'string' && responseJson.output_text.trim()) {
    return responseJson.output_text.trim();
  }

  if (Array.isArray(responseJson?.output)) {
    const chunks = [];

    for (const item of responseJson.output) {
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (typeof part?.text === 'string' && part.text.trim()) {
            chunks.push(part.text.trim());
          }
          if (typeof part?.output_text === 'string' && part.output_text.trim()) {
            chunks.push(part.output_text.trim());
          }
        }
      }
    }

    if (chunks.length > 0) {
      return chunks.join('\n');
    }
  }

  return '';
}

function parseJsonOnlyText(text) {
  if (!text) {
    throw new Error('OpenClaw returned empty text');
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1].trim() : text.trim();

  return JSON.parse(raw);
}

function buildSearchSlotsInstructions() {
  return [
    'You are golf_reservation_operator.',
    'Return JSON only. No prose. No markdown unless unavoidable.',
    'Follow the website order, not the chat order.',
    'Website order is:',
    '1) confirm admin login or login first',
    '2) open reservation page',
    '3) select reservation date/time first',
    '4) search available slots around anchorTime within the given window',
    '5) only after date/time context exists, search by phone (and name if needed by the page)',
    '6) collect member search results',
    '7) do not click final booking confirmation',
    '8) return structured JSON only',
    'If multiple member records match the same phone, return all of them in memberCandidates and set memberStatus="multiple_match".',
    'If exactly one record matches, set memberStatus="single_match" and selectedMember to that record.',
    'If none matches, set memberStatus="not_found".',
    'Output schema exactly:',
    '{"ok":true,"memberStatus":"single_match","memberCandidates":[{"memberKey":"official:qwer","memberTypeLabel":"공식정회원","loginId":"qwer","name":"홍길동","phone":"01012345678"}],"selectedMember":{"memberKey":"official:qwer","memberTypeLabel":"공식정회원","loginId":"qwer","name":"홍길동","phone":"01012345678"},"candidates":["09:05","09:12"],"reason":"","notes":""}',
  ].join('\n');
}

function buildSearchSlotsInput({
  memberType,
  name,
  phone,
  date,
  anchorTime,
  windowMinutes = 30,
}) {
  return [
    'mode=search_slots',
    `memberType=${memberType || ''}`,
    `name=${name || ''}`,
    `phone=${phone || ''}`,
    `date=${date || ''}`,
    `anchorTime=${anchorTime || ''}`,
    `windowMinutes=${windowMinutes}`,
  ].join('\n');
}

function normalizeSearchSlotsResult(parsed) {
  const candidates = Array.isArray(parsed?.candidates)
    ? parsed.candidates.map((v) => String(v).trim()).filter(Boolean)
    : [];

  const memberCandidates = Array.isArray(parsed?.memberCandidates)
    ? parsed.memberCandidates.map((row, idx) => ({
        memberKey: String(row?.memberKey || `candidate:${idx + 1}`),
        memberTypeLabel: String(row?.memberTypeLabel || ''),
        loginId: String(row?.loginId || ''),
        name: String(row?.name || ''),
        phone: normalizePhone(row?.phone || ''),
      }))
    : [];

  let selectedMember = null;
  if (parsed?.selectedMember && typeof parsed.selectedMember === 'object') {
    selectedMember = {
      memberKey: String(parsed.selectedMember.memberKey || ''),
      memberTypeLabel: String(parsed.selectedMember.memberTypeLabel || ''),
      loginId: String(parsed.selectedMember.loginId || ''),
      name: String(parsed.selectedMember.name || ''),
      phone: normalizePhone(parsed.selectedMember.phone || ''),
    };
  }

  let memberStatus = String(parsed?.memberStatus || '').trim();

  if (!memberStatus) {
    if (memberCandidates.length > 1) {
      memberStatus = 'multiple_match';
    } else if (memberCandidates.length === 1) {
      memberStatus = 'single_match';
    } else {
      memberStatus = 'not_found';
    }
  }

  if (!selectedMember && memberStatus === 'single_match' && memberCandidates.length === 1) {
    selectedMember = memberCandidates[0];
  }

  return {
    ok: !!parsed?.ok,
    memberStatus,
    memberCandidates,
    selectedMember,
    candidates,
    reason: String(parsed?.reason || ''),
    notes: String(parsed?.notes || ''),
    raw: parsed,
  };
}

async function openClawSearchSlots({
  sessionKey,
  memberType,
  name,
  phone,
  date,
  anchorTime,
  windowMinutes = 30,
}) {
  const responseJson = await callOpenClawResponses({
    user: sessionKey,
    instructions: buildSearchSlotsInstructions(),
    input: buildSearchSlotsInput({
      memberType,
      name,
      phone,
      date,
      anchorTime,
      windowMinutes,
    }),
    maxOutputTokens: 1500,
  });

  const text = extractResponsesText(responseJson);
  const parsed = parseJsonOnlyText(text);

  return normalizeSearchSlotsResult(parsed);
}

function buildCandidateLines(candidateTimes, max = 8) {
  return candidateTimes
    .slice(0, max)
    .map((time, idx) => `${idx + 1}. ${time}`)
    .join('\n');
}

function buildCandidateTimeQuickReplies(candidateTimes) {
  const quickReplies = candidateTimes
    .slice(0, 5)
    .map((time) => qrMessage(time, `후보시간선택:${time}`));

  quickReplies.push(qrMessage('예약일시 다시 입력', '예약일시다시입력'));
  quickReplies.push(qrMessage('처음으로', '예약시작'));
  return quickReplies;
}

function buildMemberSelectionQuickReplies(memberCandidates) {
  const quickReplies = memberCandidates
    .slice(0, 5)
    .map((candidate, idx) =>
      qrBlock(`${idx + 1}번 선택`, BLOCK_ID_MEMBER_SELECT, {
        memberKey: candidate.memberKey,
      })
    );

  quickReplies.push(qrMessage('휴대폰 다시 입력', '회원휴대폰다시입력'));
  quickReplies.push(qrMessage('처음으로', '예약시작'));

  return quickReplies;
}

function buildMemberSelectionText(memberCandidates, reservationDate, reservationTime) {
  const lines = memberCandidates
    .slice(0, 5)
    .map((row, idx) => {
      const typeLabel = row.memberTypeLabel || '회원';
      const loginId = row.loginId || '-';
      const name = row.name || '-';
      const phone = row.phone ? formatPhone(row.phone) : '-';
      return `${idx + 1}. ${typeLabel} / 아이디:${loginId} / 이름:${name} / 휴대폰:${phone}`;
    })
    .join('\n');

  return (
    `같은 휴대폰 번호로 여러 회원이 확인되었습니다.\n` +
    `기준 예약일시: ${reservationDate} ${reservationTime}\n\n` +
    `${lines}\n\n` +
    `예약에 사용할 회원을 선택해 주세요.`
  );
}

/**
 * 헬스체크
 */
app.get('/', (req, res) => {
  res.status(200).send('kakao golf skill server is running');
});

/**
 * 휴대폰 검증 API
 */
app.post('/kakao/validate/member-phone', (req, res) => {
  try {
    const rawValue = extractValidationRawValue(req.body);
    const normalized = normalizePhone(rawValue);

    console.log('[VALIDATE MEMBER PHONE REQUEST]', JSON.stringify(req.body, null, 2));
    console.log('[VALIDATE MEMBER PHONE NORMALIZED]', normalized);

    if (!normalized) {
      return res.json({
        status: 'FAIL',
        value: '',
        message: '휴대폰 번호를 입력해 주세요. 예: 01012345678',
      });
    }

    if (!isValidMobile(normalized)) {
      return res.json({
        status: 'FAIL',
        value: '',
        message: '휴대폰 번호 형식이 올바르지 않습니다. 숫자만 다시 입력해 주세요. 예: 01012345678',
      });
    }

    return res.json({
      status: 'SUCCESS',
      value: normalized,
      message: '',
    });
  } catch (error) {
    console.error('[VALIDATION ERROR]', error);

    return res.json({
      status: 'FAIL',
      value: '',
      message: '휴대폰 번호 확인 중 오류가 발생했습니다. 다시 입력해 주세요.',
    });
  }
});

/**
 * 블록 ID 확인용 디버그 스킬
 */
app.post('/kakao/skill/debug-block-info', (req, res) => {
  try {
    console.log('[DEBUG_BLOCK_INFO REQUEST]', JSON.stringify(req.body, null, 2));

    const userRequestBlockId = req.body?.userRequest?.block?.id || '';
    const userRequestBlockName = req.body?.userRequest?.block?.name || '';
    const intentId = req.body?.intent?.id || '';
    const intentName = req.body?.intent?.name || '';
    const utterance = req.body?.userRequest?.utterance || '';
    const referrerBlockId = req.body?.flow?.trigger?.referrerBlock?.id || '';
    const referrerBlockName = req.body?.flow?.trigger?.referrerBlock?.name || '';

    const debugText =
      '디버그 블록 확인\n' +
      `userRequest.block.name: ${userRequestBlockName}\n` +
      `userRequest.block.id: ${userRequestBlockId}\n` +
      `intent.name: ${intentName}\n` +
      `intent.id: ${intentId}\n` +
      `referrerBlock.name: ${referrerBlockName}\n` +
      `referrerBlock.id: ${referrerBlockId}\n` +
      `utterance: ${utterance}`;

    return res.json(textResponse(debugText));
  } catch (error) {
    console.error('[DEBUG_BLOCK_INFO ERROR]', error);
    return res.json(textResponse('디버그 블록 확인 중 오류 발생'));
  }
});

/**
 * 회원 전화번호 입력 단계
 * 실제 회원확정은 아직 하지 않고 정보만 저장
 */
app.post('/kakao/skill/member-lookup', async (req, res) => {
  try {
    const userKey = getUserKey(req.body);

    const memberPhone =
      getActionParam(req.body, 'member_phone') ||
      getDetailParamValue(req.body, 'member_phone') ||
      '';

    const normalizedPhone = normalizePhone(memberPhone);

    if (!normalizedPhone || !isValidMobile(normalizedPhone)) {
      return res.json(
        textResponse(
          '휴대폰 번호 형식이 올바르지 않습니다.\n숫자만 다시 입력해 주세요.\n예: 01012345678',
          [
            qrMessage('다시 입력', '회원휴대폰다시입력'),
            qrMessage('비회원으로 진행', '비회원으로진행'),
            qrMessage('처음으로', '예약시작'),
          ]
        )
      );
    }

    const session = getBookingSession(userKey);
    session.memberType = 'member';
    session.phone = normalizedPhone;
    session.name = '';
    session.memberNo = '';
    session.reservationDate = '';
    session.reservationTime = '';
    session.reservationDateTime = '';
    session.reservationTimeZone = '';
    session.candidateTimes = [];
    session.memberCandidates = [];
    session.selectedMember = null;
    session.updatedAt = Date.now();

    return res.json(
      textResponse(
        `회원 예약용 휴대폰 번호를 받았습니다.\n휴대폰: ${formatPhone(normalizedPhone)}\n다음 단계를 선택해 주세요.`,
        [
          qrMessage('예약일시 입력', '예약일시입력'),
          qrMessage('다시 입력', '회원휴대폰다시입력'),
          qrMessage('비회원으로 진행', '비회원으로진행'),
          qrMessage('처음으로', '예약시작'),
        ]
      )
    );
  } catch (error) {
    console.error('[MEMBER_LOOKUP ERROR]', error);

    return res.json(
      textResponse(
        '회원 정보 입력 처리 중 오류가 발생했습니다.\n다시 시도해 주세요.',
        [
          qrMessage('다시 입력', '회원휴대폰다시입력'),
          qrMessage('비회원으로 진행', '비회원으로진행'),
          qrMessage('처음으로', '예약시작'),
        ]
      )
    );
  }
});

/**
 * 비회원 이름 입력 단계
 */
app.post('/kakao/skill/guest-name-step', (req, res) => {
  try {
    const userKey = getUserKey(req.body);
    const rawName =
      getActionParam(req.body, 'guest_name') ||
      getDetailParamValue(req.body, 'guest_name') ||
      '';

    const guestName = sanitizeGuestName(rawName);

    console.log('[GUEST_NAME_STEP REQUEST]', JSON.stringify(req.body, null, 2));
    console.log('[GUEST_NAME_STEP PARAMS]', {
      userKey,
      rawName,
      guestName,
    });

    if (!guestName || !isValidGuestName(guestName)) {
      clearBookingSession(userKey);

      return res.json(
        textResponse(
          '성함은 한글 또는 영문 2~20자로 입력해 주세요.\n예: 홍길동',
          [
            qrMessage('이름 다시 입력', '비회원이름재입력'),
            qrMessage('처음으로', '예약시작'),
          ]
        )
      );
    }

    const session = getBookingSession(userKey);
    session.memberType = 'guest';
    session.name = guestName;
    session.memberNo = '';
    session.phone = '';
    session.reservationDate = '';
    session.reservationTime = '';
    session.reservationDateTime = '';
    session.reservationTimeZone = '';
    session.candidateTimes = [];
    session.memberCandidates = [];
    session.selectedMember = null;
    session.updatedAt = Date.now();

    return res.json(
      textResponse(
        `${guestName}님, 다음 단계를 선택해 주세요.`,
        [
          qrMessage('휴대폰 입력', '비회원휴대폰입력'),
          qrMessage('다시 입력', '비회원이름재입력'),
          qrMessage('처음으로', '예약시작'),
        ]
      )
    );
  } catch (error) {
    console.error('[GUEST_NAME_STEP ERROR]', error);
    return res.json(
      textResponse(
        '비회원 이름 확인 중 오류가 발생했습니다.\n다시 시도해 주세요.',
        [
          qrMessage('이름 다시 입력', '비회원이름재입력'),
          qrMessage('처음으로', '예약시작'),
        ]
      )
    );
  }
});

/**
 * 비회원 휴대폰 입력 단계
 */
app.post('/kakao/skill/guest-phone-step', (req, res) => {
  try {
    const userKey = getUserKey(req.body);
    const session = getBookingSession(userKey);

    const rawPhone =
      getActionParam(req.body, 'guest_phone') ||
      getDetailParamValue(req.body, 'guest_phone') ||
      '';

    const normalizedPhone = normalizePhone(rawPhone);

    console.log('[GUEST_PHONE_STEP REQUEST]', JSON.stringify(req.body, null, 2));
    console.log('[GUEST_PHONE_STEP PARAMS]', {
      userKey,
      guestName: session.name,
      rawPhone,
      normalizedPhone,
    });

    if (!session.name) {
      return res.json(
        textResponse(
          '비회원 성함 정보가 없습니다.\n이름부터 다시 입력해 주세요.',
          [
            qrMessage('이름 다시 입력', '비회원이름재입력'),
            qrMessage('처음으로', '예약시작'),
          ]
        )
      );
    }

    if (!normalizedPhone || !isValidMobile(normalizedPhone)) {
      return res.json(
        textResponse(
          '휴대폰 번호 형식이 올바르지 않습니다.\n숫자만 다시 입력해 주세요.\n예: 01012345678',
          [
            qrMessage('휴대폰 다시 입력', '비회원휴대폰다시입력'),
            qrMessage('이름 다시 입력', '비회원이름재입력'),
            qrMessage('처음으로', '예약시작'),
          ]
        )
      );
    }

    session.phone = normalizedPhone;
    session.updatedAt = Date.now();

    return res.json(
      textResponse(
        `입력하신 비회원 정보입니다.\n성함: ${session.name}\n휴대폰: ${formatPhone(session.phone)}\n다음 단계를 선택해 주세요.`,
        [
          qrMessage('예약일시 입력', '예약일시입력'),
          qrMessage('이름 다시 입력', '비회원이름재입력'),
          qrMessage('휴대폰 다시 입력', '비회원휴대폰다시입력'),
          qrMessage('처음으로', '예약시작'),
        ]
      )
    );
  } catch (error) {
    console.error('[GUEST_PHONE_STEP ERROR]', error);
    return res.json(
      textResponse(
        '비회원 휴대폰 확인 중 오류가 발생했습니다.\n다시 시도해 주세요.',
        [
          qrMessage('휴대폰 다시 입력', '비회원휴대폰다시입력'),
          qrMessage('이름 다시 입력', '비회원이름재입력'),
          qrMessage('처음으로', '예약시작'),
        ]
      )
    );
  }
});

/**
 * 예약일시 입력 단계
 * sys.plugin.datetime 사용
 * 여기서 실제 OpenClaw search_slots 호출
 */
app.post('/kakao/skill/reservation-datetime-step', async (req, res) => {
  try {
    const userKey = getUserKey(req.body);
    const session = getBookingSession(userKey);

    const rawReservationDateTime =
      getActionParam(req.body, 'reservation_datetime') ||
      getDetailParamValue(req.body, 'reservation_datetime') ||
      '';

    const parsedReservationDateTime = parsePluginDateTimeValue(rawReservationDateTime);
    const reservationDateTimeValue = parsedReservationDateTime.value;
    const userTimeZone = parsedReservationDateTime.userTimeZone;

    const split = splitDateTimeParts(reservationDateTimeValue);
    const reservationDate = split.date;
    const reservationTime = split.time;
    const reservationDateTime = split.dateTime;

    console.log('[RESERVATION_DATETIME_STEP REQUEST]', JSON.stringify(req.body, null, 2));
    console.log('[RESERVATION_DATETIME_STEP PARAMS]', {
      userKey,
      rawReservationDateTime,
      reservationDateTimeValue,
      userTimeZone,
      reservationDate,
      reservationTime,
      reservationDateTime,
      session,
    });

    if (!session.memberType || !session.phone) {
      return res.json(
        textResponse(
          '예약자 정보가 없습니다.\n처음부터 다시 진행해 주세요.',
          [qrMessage('처음으로', '예약시작')]
        )
      );
    }

    if (session.memberType === 'guest' && !session.name) {
      return res.json(
        textResponse(
          '비회원 성함 정보가 없습니다.\n처음부터 다시 진행해 주세요.',
          [qrMessage('처음으로', '예약시작')]
        )
      );
    }

    if (!reservationDateTimeValue || !reservationDate || !reservationTime) {
      return res.json(
        textResponse(
          '예약일시를 다시 선택해 주세요.',
          [
            qrMessage('예약일시 다시 입력', '예약일시다시입력'),
            qrMessage('처음으로', '예약시작'),
          ]
        )
      );
    }

    session.reservationDate = reservationDate;
    session.reservationTime = reservationTime;
    session.reservationDateTime = reservationDateTime;
    session.reservationTimeZone = userTimeZone;
    session.updatedAt = Date.now();

    const searchResult = await openClawSearchSlots({
      sessionKey: `booking:${userKey}:${reservationDate}:${reservationTime}`,
      memberType: session.memberType,
      name: session.name,
      phone: session.phone,
      date: reservationDate,
      anchorTime: reservationTime,
      windowMinutes: 30,
    });

    console.log('[OPENCLAW SEARCH_SLOTS RESULT]', searchResult);

    if (!searchResult.ok) {
      return res.json(
        textResponse(
          `예약 가능 시간 조회에 실패했습니다.\n사유: ${searchResult.reason || 'UNKNOWN'}\n다시 시도해 주세요.`,
          [
            qrMessage('예약일시 다시 입력', '예약일시다시입력'),
            qrMessage('처음으로', '예약시작'),
          ]
        )
      );
    }

    session.memberCandidates = searchResult.memberCandidates || [];
    session.selectedMember = searchResult.selectedMember || null;
    session.candidateTimes = searchResult.candidates || [];
    session.updatedAt = Date.now();

    if (!session.candidateTimes || session.candidateTimes.length === 0) {
      return res.json(
        textResponse(
          `선택하신 ${reservationDate} ${reservationTime} 기준 ±30분 내 예약 가능한 시간이 없습니다.\n다른 예약일시로 다시 시도해 주세요.`,
          [
            qrMessage('예약일시 다시 입력', '예약일시다시입력'),
            qrMessage('처음으로', '예약시작'),
          ]
        )
      );
    }

    if (session.memberType === 'member') {
      if (searchResult.memberStatus === 'not_found') {
        clearBookingSession(userKey);
        return res.json(
          textResponse(
            `입력한 휴대폰 번호로 회원을 찾지 못했습니다.\n휴대폰 번호를 다시 확인해 주세요.`,
            [
              qrMessage('회원휴대폰다시입력', '회원휴대폰다시입력'),
              qrMessage('비회원으로진행', '비회원으로진행'),
              qrMessage('처음으로', '예약시작'),
            ]
          )
        );
      }

      if (searchResult.memberStatus === 'multiple_match') {
        return res.json(
          textResponse(
            buildMemberSelectionText(session.memberCandidates, reservationDate, reservationTime),
            buildMemberSelectionQuickReplies(session.memberCandidates)
          )
        );
      }

      if (searchResult.memberStatus === 'single_match' && session.selectedMember) {
        session.name = session.selectedMember.name || session.name;
        session.phone = normalizePhone(session.selectedMember.phone || session.phone);
        session.updatedAt = Date.now();

        const candidateLines = buildCandidateLines(session.candidateTimes);

        return res.json(
          textResponse(
            `회원 확인 완료\n선택 회원: ${session.selectedMember.memberTypeLabel || '회원'} / ${session.selectedMember.loginId || '-'} / ${session.selectedMember.name || '-'}\n` +
            `예약일시 기준 후보 시간입니다.\n기준: ${reservationDate} ${reservationTime} (±30분)\n\n${candidateLines}\n\n원하시는 시간을 선택해 주세요.`,
            buildCandidateTimeQuickReplies(session.candidateTimes)
          )
        );
      }
    }

    const candidateLines = buildCandidateLines(session.candidateTimes);

    return res.json(
      textResponse(
        `예약 가능 시간 후보입니다.\n기준: ${reservationDate} ${reservationTime} (±30분)\n\n${candidateLines}\n\n원하시는 시간을 선택해 주세요.`,
        buildCandidateTimeQuickReplies(session.candidateTimes)
      )
    );
  } catch (error) {
    console.error('[RESERVATION_DATETIME_STEP ERROR]', error);

    return res.json(
      textResponse(
        '예약 가능 시간 조회 중 오류가 발생했습니다.\n다시 시도해 주세요.',
        [
          qrMessage('예약일시 다시 입력', '예약일시다시입력'),
          qrMessage('처음으로', '예약시작'),
        ]
      )
    );
  }
});

/**
 * 다건 회원 선택 단계
 * B03M 블록에 연결
 * action.clientExtra.memberKey 사용
 */
app.post('/kakao/skill/member-select-step', async (req, res) => {
  try {
    const userKey = getUserKey(req.body);
    const session = getBookingSession(userKey);
    const clientExtra = getClientExtra(req.body);
    const memberKey = String(clientExtra?.memberKey || '').trim();

    console.log('[MEMBER_SELECT_STEP REQUEST]', JSON.stringify(req.body, null, 2));
    console.log('[MEMBER_SELECT_STEP CLIENT_EXTRA]', clientExtra);
    console.log('[MEMBER_SELECT_STEP SESSION]', session);

    if (!session.memberCandidates || session.memberCandidates.length === 0) {
      return res.json(
        textResponse(
          '선택할 회원 목록 정보가 없습니다.\n예약일시부터 다시 진행해 주세요.',
          [
            qrMessage('예약일시 다시 입력', '예약일시다시입력'),
            qrMessage('처음으로', '예약시작'),
          ]
        )
      );
    }

    if (!memberKey) {
      return res.json(
        textResponse(
          '버튼으로 회원을 선택해 주세요.',
          buildMemberSelectionQuickReplies(session.memberCandidates)
        )
      );
    }

    const selected = session.memberCandidates.find((row) => row.memberKey === memberKey);

    if (!selected) {
      return res.json(
        textResponse(
          '선택한 회원 정보를 찾지 못했습니다.\n다시 선택해 주세요.',
          buildMemberSelectionQuickReplies(session.memberCandidates)
        )
      );
    }

    session.selectedMember = selected;
    session.name = selected.name || session.name;
    session.phone = normalizePhone(selected.phone || session.phone);
    session.updatedAt = Date.now();

    const candidateLines = buildCandidateLines(session.candidateTimes);

    return res.json(
      textResponse(
        `선택 회원 확인\n${selected.memberTypeLabel || '회원'} / ${selected.loginId || '-'} / ${selected.name || '-'}\n` +
        `휴대폰: ${selected.phone ? formatPhone(selected.phone) : '-'}\n\n` +
        `예약 가능 시간 후보입니다.\n기준: ${session.reservationDate} ${session.reservationTime} (±30분)\n\n${candidateLines}\n\n원하시는 시간을 선택해 주세요.`,
        buildCandidateTimeQuickReplies(session.candidateTimes)
      )
    );
  } catch (error) {
    console.error('[MEMBER_SELECT_STEP ERROR]', error);

    return res.json(
      textResponse(
        '회원 선택 처리 중 오류가 발생했습니다.\n다시 시도해 주세요.',
        [
          qrMessage('예약일시 다시 입력', '예약일시다시입력'),
          qrMessage('처음으로', '예약시작'),
        ]
      )
    );
  }
});

/**
 * 폴백 라우터 스킬
 */
app.post('/kakao/skill/fallback-router', (req, res) => {
  try {
    console.log('[FALLBACK_ROUTER REQUEST]', JSON.stringify(req.body, null, 2));

    const userKey = getUserKey(req.body);
    const session = getBookingSession(userKey);

    const lastBlockName =
      req.body?.flow?.lastBlock?.name ||
      req.body?.userRequest?.block?.name ||
      '';

    if (lastBlockName === BLOCK_NAME_MEMBER_PHONE_INPUT) {
      return res.json(
        textResponse(
          '직접 입력하지 말고 아래 버튼으로 선택해 주세요.',
          [
            qrMessage('예약일시 입력', '예약일시입력'),
            qrMessage('다시 입력', '회원휴대폰다시입력'),
            qrMessage('비회원으로 진행', '비회원으로진행'),
            qrMessage('처음으로', '예약시작'),
          ]
        )
      );
    }

    if (lastBlockName === BLOCK_NAME_GUEST_NAME_INPUT) {
      return res.json(
        textResponse(
          '직접 입력하지 말고 아래 버튼으로 선택해 주세요.',
          [
            qrMessage('휴대폰 입력', '비회원휴대폰입력'),
            qrMessage('다시 입력', '비회원이름재입력'),
            qrMessage('처음으로', '예약시작'),
          ]
        )
      );
    }

    if (lastBlockName === BLOCK_NAME_GUEST_PHONE_INPUT) {
      return res.json(
        textResponse(
          '직접 입력하지 말고 아래 버튼으로 선택해 주세요.',
          [
            qrMessage('예약일시 입력', '예약일시입력'),
            qrMessage('이름 다시 입력', '비회원이름재입력'),
            qrMessage('휴대폰 다시 입력', '비회원휴대폰다시입력'),
            qrMessage('처음으로', '예약시작'),
          ]
        )
      );
    }

    if (lastBlockName === BLOCK_NAME_MEMBER_SELECT && session.memberCandidates && session.memberCandidates.length > 0) {
      return res.json(
        textResponse(
          buildMemberSelectionText(session.memberCandidates, session.reservationDate, session.reservationTime),
          buildMemberSelectionQuickReplies(session.memberCandidates)
        )
      );
    }

    if (lastBlockName === BLOCK_NAME_RESERVATION_DATETIME_INPUT) {
      return res.json(
        textResponse(
          '직접 입력하지 말고 아래 버튼으로 선택해 주세요.',
          [
            qrMessage('예약일시 다시 입력', '예약일시다시입력'),
            qrMessage('처음으로', '예약시작'),
          ]
        )
      );
    }

    return res.json(
      textResponse(
        '죄송합니다. 이해하지 못했습니다.\n처음으로 돌아가 다시 진행해 주세요.',
        [
          qrMessage('처음으로', '예약시작'),
        ]
      )
    );
  } catch (error) {
    console.error('[FALLBACK_ROUTER ERROR]', error);
    return res.json(
      textResponse(
        '처리 중 오류가 발생했습니다.\n처음으로 돌아가 다시 진행해 주세요.',
        [
          qrMessage('처음으로', '예약시작'),
        ]
      )
    );
  }
});

/**
 * 404
 */
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    message: 'Not Found',
  });
});

/**
 * 전역 에러 핸들러
 */
app.use((err, req, res, next) => {
  console.error('[UNHANDLED ERROR]', err);
  res.status(500).json({
    ok: false,
    message: 'Internal Server Error',
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
