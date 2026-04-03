import express from "express";

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("kakao skill server is running");
});

app.post("/e10", (req, res) => {
  try {
    const body = req.body || {};
    const params = (((body || {}).action || {}).params || {});
    const dateText = String(params.date_text || "").trim();

    if (!dateText) {
      return res.json({
        version: "2.0",
        template: {
          outputs: [
            {
              simpleText: {
                text: "날짜를 다시 입력해주세요."
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
      });
    }

    return res.json({
      version: "2.0",
      template: {
        outputs: [
          {
            simpleText: {
              text: `입력한 날짜: ${dateText}`
            }
          }
        ]
      },
      action: {
        clientExtra: {
          parse_error: "NONE",
          date_ymd: "2026-05-28"
        }
      }
    });
  } catch (error) {
    return res.status(200).json({
      version: "2.0",
      template: {
        outputs: [
          {
            simpleText: {
              text: "서버 처리 중 오류가 발생했습니다."
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
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`server listening on port ${port}`);
});