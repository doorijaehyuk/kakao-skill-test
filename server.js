const express = require('express');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;

/**
 * 환경변수
 * - OPENCLAW_MEMBER_LOOKUP_URL: 실제 회원조회 API URL
 * - OPENCLAW_API_KEY: 필요 시 인증키
 * - KAKAO_BLOCK_ID_MEMBER_CONFIRMED: 회원확인 성공 후 다음 블록 ID
 * - KAKAO_BLOCK_ID_MEMBER_PHONE_INPUT: 휴대폰 재입력 블록 ID (보통 B02M 자기 자신)
 * - KAKAO_BLOCK_ID_GUEST_NAME_INPUT: 비회원 이름입력 블록 ID
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

function buildQuickReplyBlock(label, blockId, extra = {}) {
  return {
    label,
    action: 'block',
    blockId,
    extra,
  };
}

function buildSimpleTextResponse(text, quickReplies = [], data = {}, contextValues = []) {
  const payload = {
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
    payload.template.quickReplies = quickReplies;
  }

  if (Object.keys(data).length > 0) {
    payload.data = data;
  }

  if (contextValues.length > 0) {
    payload.context = {
      values: contextValues,
    };
  }

  return payload;
}

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

app.get('/', (req, res) => {
  res.status(200).send('kakao golf skill server is running');
});

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
    return res.json({
      status: 'FAIL',
      value: '',
      message: '휴대폰 번호 확인 중 오류가 발생했습니다. 다시 입력해 주세요.',
    });
  }
});

app.post('/kakao/skill/member-lookup', async (req, res) => {
  const requestId = getRequestId(req);

  const BLOCK_ID_MEMBER_CONFIRMED =
    process.env.KAKAO_BLOCK_ID_MEMBER_CONFIRMED || '';
  const BLOCK_ID_MEMBER_PHONE_INPUT =
    process.env.KAKAO_BLOCK_ID_MEMBER_PHONE_INPUT || '';
  const BLOCK_ID_GUEST_NAME_INPUT =
    process.env.KAKAO_BLOCK_ID_GUEST_NAME_INPUT || '';

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

    if (!normalizedPhone || !isValidMobile(normalizedPhone)) {
      return res.json(
        buildSimpleTextResponse(
          '휴대폰 번호 형식이 올바르지 않습니다.\n숫자만 다시 입력해 주세요.\n예: 01012345678',
          [
            ...(BLOCK_ID_MEMBER_PHONE_INPUT
              ? [buildQuickReplyBlock('다시 입력', BLOCK_ID_MEMBER_PHONE_INPUT)]
              : []),
            ...(BLOCK_ID_GUEST_NAME_INPUT
              ? [buildQuickReplyBlock('비회원으로 진행', BLOCK_ID_GUEST_NAME_INPUT)]
              : []),
          ],
          {
            memberType,
            memberFound: false,
            reason: 'INVALID_PHONE',
          },
          [
            {
              name: 'ctx_member_lookup',
              lifeSpan: 3,
              ttl: 300,
              params: {
                memberFound: 'false',
                reason: 'INVALID_PHONE',
              },
            },
          ]
        )
      );
    }

    const lookup = await lookupMemberByPhone(normalizedPhone, requestId);

    if (lookup.found) {
      return res.json(
        buildSimpleTextResponse(
          `${lookup.name} 회원님으로 확인되었습니다.\n휴대폰 번호는 ${formatPhone(lookup.phone)} 입니다.\n맞으시면 아래 버튼을 눌러 주세요.`,
          [
            ...(BLOCK_ID_MEMBER_CONFIRMED
              ? [
                  buildQuickReplyBlock('확인', BLOCK_ID_MEMBER_CONFIRMED, {
                    member_type: memberType || 'member',
                    member_found: 'true',
                    member_name: lookup.name,
                    member_no: lookup.memberNo,
                    member_phone: lookup.phone,
                  }),
                ]
              : []),
            ...(BLOCK_ID_MEMBER_PHONE_INPUT
              ? [buildQuickReplyBlock('다시 입력', BLOCK_ID_MEMBER_PHONE_INPUT)]
              : []),
            ...(BLOCK_ID_GUEST_NAME_INPUT
              ? [buildQuickReplyBlock('비회원으로 진행', BLOCK_ID_GUEST_NAME_INPUT)]
              : []),
          ],
          {
            memberType: memberType || 'member',
            memberFound: true,
            memberName: lookup.name,
            memberNo: lookup.memberNo,
            memberPhone: lookup.phone,
            displayPhone: formatPhone(lookup.phone),
            memberStatus: lookup.status || '',
            reason: '',
          },
          [
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
          ]
        )
      );
    }

    return res.json(
      buildSimpleTextResponse(
        `입력하신 휴대폰 번호(${formatPhone(normalizedPhone)})로 회원 정보를 찾지 못했습니다.\n번호를 다시 입력하시거나 비회원으로 진행해 주세요.`,
        [
          ...(BLOCK_ID_MEMBER_PHONE_INPUT
            ? [buildQuickReplyBlock('다시 입력', BLOCK_ID_MEMBER_PHONE_INPUT)]
            : []),
          ...(BLOCK_ID_GUEST_NAME_INPUT
            ? [buildQuickReplyBlock('비회원으로 진행', BLOCK_ID_GUEST_NAME_INPUT)]
            : []),
        ],
        {
          memberType: memberType || 'member',
          memberFound: false,
          memberName: '',
          memberNo: '',
          memberPhone: normalizedPhone,
          displayPhone: formatPhone(normalizedPhone),
          reason: lookup.reason || 'NOT_FOUND',
        },
        [
          {
            name: 'ctx_member_lookup',
            lifeSpan: 3,
            ttl: 300,
            params: {
              memberType: memberType || 'member',
              memberFound: 'false',
              memberPhone: normalizedPhone,
              displayPhone: formatPhone(normalizedPhone),
              reason: lookup.reason || 'NOT_FOUND',
            },
          },
        ]
      )
    );
  } catch (error) {
    console.error('[MEMBER_LOOKUP ERROR]', error);

    return res.json(
      buildSimpleTextResponse(
        '회원 확인 중 오류가 발생했습니다.\n잠시 후 다시 시도하시거나 비회원으로 진행해 주세요.',
        [
          ...(process.env.KAKAO_BLOCK_ID_MEMBER_PHONE_INPUT
            ? [buildQuickReplyBlock('다시 입력', process.env.KAKAO_BLOCK_ID_MEMBER_PHONE_INPUT)]
            : []),
          ...(process.env.KAKAO_BLOCK_ID_GUEST_NAME_INPUT
            ? [buildQuickReplyBlock('비회원으로 진행', process.env.KAKAO_BLOCK_ID_GUEST_NAME_INPUT)]
            : []),
        ],
        {
          memberFound: false,
          reason: 'SERVER_ERROR',
        },
        [
          {
            name: 'ctx_member_lookup',
            lifeSpan: 1,
            ttl: 60,
            params: {
              memberFound: 'false',
              reason: 'SERVER_ERROR',
            },
          },
        ]
      )
    );
  }
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    message: 'Not Found',
  });
});

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
