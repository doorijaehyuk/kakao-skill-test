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
 * 테스트용 샘플 회원 DB
 * 실제 운영에서는 OPENCLAW_MEMBER_LOOKUP_URL 환경변수 사용 가능
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
 * - 특정 블록에 임시 연결해서 userRequest.block.id 확인
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
 * - 서버가 직접 simpleText + quickReplies 반환
 * - quickReplies는 모두 동일한 block 스키마 사용
 * - 현재 B03M ID가 없으므로 "확인" 버튼은 보류
 */
app.post('/kakao/skill/member-lookup', async (req, res) => {
  const requestId = getRequestId(req);

  try {
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
      memberType,
      memberPhone,
      normalizedPhone,
    });

    const commonQuickReplies = [
      qrBlock('다시 입력', BLOCK_ID_MEMBER_PHONE_INPUT, {}),
      qrBlock('비회원으로 진행', BLOCK_ID_GUEST_NAME_INPUT, {}),
      qrBlock('처음으로', BLOCK_ID_RESERVATION_START, {}),
    ];

    // 1) 번호 형식 오류
    if (!normalizedPhone || !isValidMobile(normalizedPhone)) {
      return res.json(
        textResponse(
          '휴대폰 번호 형식이 올바르지 않습니다.\n숫자만 다시 입력해 주세요.\n예: 01012345678',
          commonQuickReplies
        )
      );
    }

    const lookup = await lookupMemberByPhone(normalizedPhone, requestId);

    // 2) 조회 성공
    if (lookup.found) {
      return res.json(
        textResponse(
          `${lookup.name} 회원님으로 확인되었습니다.\n` +
          `휴대폰 번호는 ${formatPhone(lookup.phone)} 입니다.\n` +
          `다음 단계 블록 ID 연결 전까지는 아래 버튼으로만 이동해 주세요.`,
          commonQuickReplies
        )
      );
    }

    // 3) 조회 실패
    return res.json(
      textResponse(
        `입력하신 휴대폰 번호(${formatPhone(normalizedPhone)})로 회원 정보를 찾지 못했습니다.\n` +
        `번호를 다시 입력하시거나 비회원으로 진행해 주세요.`,
        commonQuickReplies
      )
    );
  } catch (error) {
    console.error('[MEMBER_LOOKUP ERROR]', error);

    return res.json(
      textResponse(
        '회원 확인 중 오류가 발생했습니다.\n잠시 후 다시 시도해 주세요.',
        [
          qrBlock('다시 입력', BLOCK_ID_MEMBER_PHONE_INPUT, {}),
          qrBlock('비회원으로 진행', BLOCK_ID_GUEST_NAME_INPUT, {}),
          qrBlock('처음으로', BLOCK_ID_RESERVATION_START, {}),
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
