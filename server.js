const express = require('express');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;

/**
 * 환경변수
 * - OPENCLAW_MEMBER_LOOKUP_URL: OpenClaw 또는 대표님 서버의 회원조회 API URL
 * - OPENCLAW_API_KEY: 필요 시 인증키
 *
 * Render 예시:
 * OPENCLAW_MEMBER_LOOKUP_URL=https://your-openclaw-or-api.com/member-lookup
 * OPENCLAW_API_KEY=xxxxx
 */

/**
 * 테스트용 샘플 회원 DB
 * 실제 운영에서는 OPENCLAW_MEMBER_LOOKUP_URL 사용 권장
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

  let str = String(raw).trim();

  // 숫자만 남김
  str = str.replace(/\D/g, '');

  // 한국 휴대폰 일반 형식만 허용: 010xxxxxxxx
  // 필요 시 011/016/017/018/019까지 허용 확장 가능
  return str;
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

/**
 * Kakao validation API body 예:
 * {
 *   "isInSlotFilling": true,
 *   "utterance": "010-1234-5678",
 *   "value": {
 *     "origin": "010-1234-5678",
 *     "resolved": "010-1234-5678"
 *   },
 *   "user": {
 *     "id": "xxx",
 *     "type": "accountId"
 *   }
 * }
 */
function extractValidationRawValue(body) {
  if (!body || typeof body !== 'object') return '';
  if (body?.value?.resolved) return body.value.resolved;
  if (body?.value?.origin) return body.value.origin;
  if (body?.utterance) return body.utterance;
  return '';
}

/**
 * Kakao skill payload 에서 파라미터 안전 추출
 * 문서 예시상 action.params, action.detailParams 구조를 사용
 */
function getActionParam(body, key) {
  return body?.action?.params?.[key] ?? '';
}

function getDetailParamValue(body, key) {
  const dp = body?.action?.detailParams?.[key];
  if (!dp) return '';

  // 문서/실전에서 value 또는 resolved 형태가 혼재될 수 있어 둘 다 대응
  return dp.value ?? dp.resolved ?? dp.origin ?? '';
}

function getRequestId(req) {
  return req.get('X-Request-Id') || '';
}

function buildSimpleText(text) {
  return {
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
}

/**
 * OpenClaw 또는 외부 회원조회 API 호출
 * 실제 형식은 대표님 환경마다 다를 수 있으므로,
 * 아래는 표준화용 어댑터입니다.
 */
async function lookupMemberByPhone(phone, requestId = '') {
  const normalized = normalizePhone(phone);

  if (!isValidMobile(normalized)) {
    return {
      found: false,
      reason: 'INVALID_PHONE',
    };
  }

  const remoteUrl = process.env.OPENCLAW_MEMBER_LOOKUP_URL;
  const apiKey = process.env.OPENCLAW_API_KEY || '';

  // 1) 외부 API가 있으면 우선 사용
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

    /**
     * 외부 응답 기대 형태 예:
     * {
     *   "found": true,
     *   "name": "홍길동",
     *   "memberNo": "M0001",
     *   "status": "ACTIVE"
     * }
     */
    return {
      found: !!data.found,
      name: data.name || '',
      memberNo: data.memberNo || '',
      status: data.status || '',
      phone: normalized,
      reason: data.reason || (data.found ? '' : 'NOT_FOUND'),
    };
  }

  // 2) 외부 API가 없으면 샘플 DB 사용
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
 * 1) Health check
 */
app.get('/', (req, res) => {
  res.status(200).send('kakao golf skill server is running');
});

/**
 * 2) Kakao parameter validation API
 * member_phone 검증/정규화
 *
 * 성공 응답 예:
 * {
 *   "status": "SUCCESS",
 *   "value": "01012345678",
 *   "message": ""
 * }
 *
 * 실패 응답 예:
 * {
 *   "status": "FAIL",
 *   "value": "",
 *   "message": "휴대폰 번호 형식이 올바르지 않습니다. 숫자만 다시 입력해 주세요."
 * }
 */
app.post('/kakao/validate/member-phone', (req, res) => {
  try {
    const rawValue = extractValidationRawValue(req.body);
    const normalized = normalizePhone(rawValue);

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

    // 카카오 문서상 ERROR도 가능하지만,
    // 운영에서는 사용자에게 다시 입력받게 FAIL 처리하는 편이 안전
    return res.json({
      status: 'FAIL',
      value: '',
      message: '휴대폰 번호 확인 중 오류가 발생했습니다. 다시 입력해 주세요.',
    });
  }
});

/**
 * 3) Kakao skill: member_lookup
 *
 * 목적:
 * - B02M_회원휴대폰입력 에서 전달된 member_phone 으로 회원 조회
 * - 결과를 data 및 context 로 반환
 *
 * 반환 구조:
 * - version: 2.0
 * - data: webhook.data.xxx 로 사용 가능
 * - context: 다음 블록에서 ctx_member_lookup 사용 가능
 *
 * 필요 시 이 응답을 기반으로
 * B03M_회원조회결과확인 블록에서
 * {{#webhook.data.memberName}} 회원님 맞으신가요?
 * 처럼 사용
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

    // 방어적 검증
    if (!normalizedPhone || !isValidMobile(normalizedPhone)) {
      return res.json({
        version: '2.0',
        data: {
          memberType,
          memberFound: false,
          memberName: '',
          memberNo: '',
          memberPhone: '',
          displayPhone: '',
          reason: 'INVALID_PHONE',
        },
        context: {
          values: [
            {
              name: 'ctx_member_lookup',
              lifeSpan: 5,
              ttl: 300,
              params: {
                memberFound: 'false',
                reason: 'INVALID_PHONE',
              },
            },
          ],
        },
      });
    }

    const lookup = await lookupMemberByPhone(normalizedPhone, requestId);

    // 조회 성공
    if (lookup.found) {
      return res.json({
        version: '2.0',
        data: {
          memberType: memberType || 'member',
          memberFound: true,
          memberName: lookup.name,
          memberNo: lookup.memberNo,
          memberPhone: lookup.phone,
          displayPhone: formatPhone(lookup.phone),
          memberStatus: lookup.status || '',
          reason: '',
        },
        context: {
          values: [
            {
              name: 'ctx_member_lookup',
              lifeSpan: 5,
              ttl: 300,
              params: {
                memberType: memberType || 'member',
                memberFound: 'true',
                memberName: lookup.name,
                memberNo: lookup.memberNo,
                memberPhone: lookup.phone,
                displayPhone: formatPhone(lookup.phone),
                memberStatus: lookup.status || '',
              },
            },
          ],
        },
      });
    }

    // 조회 실패
    return res.json({
      version: '2.0',
      data: {
        memberType: memberType || 'member',
        memberFound: false,
        memberName: '',
        memberNo: '',
        memberPhone: normalizedPhone,
        displayPhone: formatPhone(normalizedPhone),
        reason: lookup.reason || 'NOT_FOUND',
      },
      context: {
        values: [
          {
            name: 'ctx_member_lookup',
            lifeSpan: 5,
            ttl: 300,
            params: {
              memberType: memberType || 'member',
              memberFound: 'false',
              memberPhone: normalizedPhone,
              displayPhone: formatPhone(normalizedPhone),
              reason: lookup.reason || 'NOT_FOUND',
            },
          },
        ],
      },
    });
  } catch (error) {
    console.error('[MEMBER_LOOKUP ERROR]', error);

    // 운영 중 장애가 나더라도 카카오 응답은 JSON으로 유지
    return res.json({
      version: '2.0',
      data: {
        memberFound: false,
        reason: 'SERVER_ERROR',
      },
      context: {
        values: [
          {
            name: 'ctx_member_lookup',
            lifeSpan: 1,
            ttl: 60,
            params: {
              memberFound: 'false',
              reason: 'SERVER_ERROR',
            },
          },
        ],
      },
    });
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
 * global error handler
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
