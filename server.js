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

    // 1) 휴대폰 형식 자체가 잘못된 경우
    if (!normalizedPhone || !isValidMobile(normalizedPhone)) {
      return res.json({
        version: '2.0',
        template: {
          outputs: [
            {
              simpleText: {
                text:
                  '휴대폰 번호 형식이 올바르지 않습니다.\n' +
                  '숫자만 다시 입력해 주세요.\n' +
                  '예: 01012345678',
              },
            },
          ],
          quickReplies: [
            {
              label: '다시 입력',
              action: 'message',
              messageText: '회원휴대폰다시입력',
            },
            {
              label: '비회원으로 진행',
              action: 'message',
              messageText: '비회원으로진행',
            },
          ],
        },
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
              lifeSpan: 3,
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

    // 2) 조회 성공
    if (lookup.found) {
      return res.json({
        version: '2.0',
        template: {
          outputs: [
            {
              simpleText: {
                text:
                  `${lookup.name} 회원님으로 확인되었습니다.\n` +
                  `휴대폰 번호는 ${formatPhone(lookup.phone)} 입니다.\n` +
                  `맞으시면 아래 버튼을 눌러 주세요.`,
              },
            },
          ],
          quickReplies: [
            {
              label: '확인',
              action: 'message',
              messageText: '회원확인완료',
            },
            {
              label: '다시 입력',
              action: 'message',
              messageText: '회원휴대폰다시입력',
            },
            {
              label: '비회원으로 진행',
              action: 'message',
              messageText: '비회원으로진행',
            },
          ],
        },
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

    // 3) 조회 실패
    return res.json({
      version: '2.0',
      template: {
        outputs: [
          {
            simpleText: {
              text:
                `입력하신 휴대폰 번호(${formatPhone(normalizedPhone)})로 회원 정보를 찾지 못했습니다.\n` +
                `번호를 다시 입력하시거나 비회원으로 진행해 주세요.`,
            },
          },
        ],
        quickReplies: [
          {
            label: '다시 입력',
            action: 'message',
            messageText: '회원휴대폰다시입력',
          },
          {
            label: '비회원으로 진행',
            action: 'message',
            messageText: '비회원으로진행',
          },
        ],
      },
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
        ],
      },
    });
  } catch (error) {
    console.error('[MEMBER_LOOKUP ERROR]', error);

    return res.json({
      version: '2.0',
      template: {
        outputs: [
          {
            simpleText: {
              text:
                '회원 확인 중 오류가 발생했습니다.\n' +
                '잠시 후 다시 시도하시거나 비회원으로 진행해 주세요.',
            },
          },
        ],
        quickReplies: [
          {
            label: '다시 입력',
            action: 'message',
            messageText: '회원휴대폰다시입력',
          },
          {
            label: '비회원으로 진행',
            action: 'message',
            messageText: '비회원으로진행',
          },
        ],
      },
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
