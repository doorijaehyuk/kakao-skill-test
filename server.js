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

/**
 * 블록명 상수
 * fallback 재질문 용도
 * 실제 관리자센터 블록명과 정확히 같아야 함
 */
const BLOCK_NAME_MEMBER_PHONE_INPUT = 'B02M_회원휴대폰입력';
const BLOCK_NAME_GUEST_NAME_INPUT = 'B02N_비회원이름입력';
const BLOCK_NAME_GUEST_PHONE_INPUT = 'B03N_비회원휴대폰입력';
const BLOCK_NAME_RESERVATION_DATETIME_INPUT = 'B04_예약일입력'; // 실제 블록명을 바꿨다면 여기 같이 수정

/**
 * 테스트용 샘플 회원 DB
 */
const SAMPLE_MEMBERS = [
  {
    phone: '01012345678',
    name: '홍길동',
    memberNo: 'M0001',
    status: 'ACTIVE',
  },
  {
    phone: '01098765432',
    name: '김철수',
    memberNo: 'M0002',
    status: 'ACTIVE',
  },
];

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

  const normalized = String(dateTimeValue).trim();

  // 2026-04-11T07:00:00 / 2026-04-11 07:00 / 2026-04-11T07:00
  const tSplit = normalized.replace(' ', 'T').split('T');

  if (tSplit.length >= 2) {
    const date = tSplit[0];
    const timeRaw = tSplit[1];
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

/**
 * 실제 회원조회
 * OPENCLAW_MEMBER_LOOKUP_URL 환경변수가 있으면 외부 API 우선 호출
 * 없으면 샘플 DB 사용
 */
async function lookupMemberByPhone(phone, requestId = '') {
  const normalized = normalizePhone(phone);

  if (!isValidMobile(normalized)) {
    return {
      found: false,
      reason: 'INVALID_PHONE',
      phone: normalized,
    };
  }

  const remoteUrl = process.env.OPENCLAW_MEMBER_LOOKUP_URL;
  const apiKey = process.env.OPENCLAW_API_KEY || '';

  if (remoteUrl) {
    const resp = await fetch(remoteUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(requestId ? { 'X-Request-Id': requestId } : {}),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        member_type: 'member',
        member_phone: normalized,
      }),
    });

    if (!resp.ok) {
      throw new Error(`Remote lookup failed: ${resp.status}`);
    }

    const data = await resp.json();

    return {
      found: !!data.found,
      name: data.name || '',
      memberNo: data.memberNo || '',
      status: data.status || '',
      phone: normalized,
      reason: data.reason || (data.found ? '' : 'NOT_FOUND'),
    };
  }

  const member = SAMPLE_MEMBERS.find((m) => m.phone === normalized);

  if (!member) {
    return {
      found: false,
      reason: 'NOT_FOUND',
      phone: normalized,
    };
  }

  return {
    found: true,
    name: member.name,
    memberNo: member.memberNo,
    status: member.status,
    phone: normalized,
    reason: '',
  };
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
 * 회원조회 스킬
 * 성공 시 바로 예약일시 입력 단계로 보냄
 */
app.post('/kakao/skill/member-lookup', async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const userKey = getUserKey(req.body);
    const memberType =
      getActionParam(req.body, 'member_type') ||
      getDetailParamValue(req.body, 'member_type') ||
      'member';

    const memberPhone =
      getActionParam(req.body, 'member_phone') ||
      getDetailParamValue(req.body, 'member_phone') ||
      '';

    const normalizedPhone = normalizePhone(memberPhone);

    console.log('[MEMBER_LOOKUP REQUEST]', JSON.stringify(req.body, null, 2));
    console.log('[MEMBER_LOOKUP PARAMS]', {
      userKey,
      memberType,
      memberPhone,
      normalizedPhone,
    });

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

    const lookup = await lookupMemberByPhone(normalizedPhone, requestId);

    if (lookup.found) {
      const session = getBookingSession(userKey);
      session.memberType = 'member';
      session.name = lookup.name;
      session.memberNo = lookup.memberNo;
      session.phone = lookup.phone;
      session.reservationDate = '';
      session.reservationTime = '';
      session.reservationDateTime = '';
      session.reservationTimeZone = '';
      session.updatedAt = Date.now();

      return res.json(
        textResponse(
          `${lookup.name} 회원님으로 확인되었습니다.\n` +
          `휴대폰 번호는 ${formatPhone(lookup.phone)} 입니다.\n` +
          `다음 단계를 선택해 주세요.`,
          [
            qrMessage('예약일시 입력', '예약일시입력'),
            qrMessage('다시 입력', '회원휴대폰다시입력'),
            qrMessage('비회원으로 진행', '비회원으로진행'),
            qrMessage('처음으로', '예약시작'),
          ]
        )
      );
    }

    clearBookingSession(userKey);

    return res.json(
      textResponse(
        `입력하신 휴대폰 번호(${formatPhone(normalizedPhone)})로 회원 정보를 찾지 못했습니다.\n` +
        `번호를 다시 입력하시거나 비회원으로 진행해 주세요.`,
        [
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
        '회원 확인 중 오류가 발생했습니다.\n잠시 후 다시 시도해 주세요.',
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
 * 연결 스킬: guest_name_step
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
 * 연결 스킬: guest_phone_step
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
 * 연결 스킬: reservation_datetime_step
 * sys.plugin.datetime 사용 전제
 */
app.post('/kakao/skill/reservation-datetime-step', (req, res) => {
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

    if (!session.memberType || !session.name || !session.phone) {
      return res.json(
        textResponse(
          '예약자 정보가 없습니다.\n처음부터 다시 진행해 주세요.',
          [
            qrMessage('처음으로', '예약시작'),
          ]
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

    const typeText = session.memberType === 'member' ? '회원' : '비회원';

    return res.json(
      textResponse(
        `${typeText} 예약 정보 확인\n` +
        `성함: ${session.name}\n` +
        `휴대폰: ${formatPhone(session.phone)}\n` +
        `예약일: ${reservationDate}\n` +
        `희망시간: ${reservationTime}\n` +
        `다음 단계로 가용 시간 조회 블록을 연결해 주세요.`,
        [
          qrMessage('예약일시 다시 입력', '예약일시다시입력'),
          qrMessage('처음으로', '예약시작'),
        ]
      )
    );
  } catch (error) {
    console.error('[RESERVATION_DATETIME_STEP ERROR]', error);
    return res.json(
      textResponse(
        '예약일시 확인 중 오류가 발생했습니다.\n다시 시도해 주세요.',
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
 * 버튼 단계에서 임의 텍스트 입력 시 같은 질문 재노출
 */
app.post('/kakao/skill/fallback-router', (req, res) => {
  try {
    console.log('[FALLBACK_ROUTER REQUEST]', JSON.stringify(req.body, null, 2));

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
