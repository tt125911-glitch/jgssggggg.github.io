const express = require('express');
const cookieParser = require('cookie-parser');
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// 連線至雲端 Redis
const redis = createClient({
  url: process.env.REDIS_URL || 'redis://127.0.0.1:6379'
});
redis.on('error', (err) => console.error('Redis 錯誤:', err));
redis.connect().catch(console.error);

// -----------------------------------------------------------------------------
// 1. [後台管理] 獎項與機率設定檔 (預設值)
// -----------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  prizes: [
    { name: "頭獎：免費大餐", prob: 5 },    // 5%
    { name: "二獎：8折優惠券", prob: 15 },   // 15%
    { name: "三獎：精美小禮物", prob: 30 }, // 30%
    { name: "銘謝惠顧", prob: 50 }          // 50%
  ]
};

// 取得當前獎項設定
async function getPrizeConfig() {
  const config = await redis.get('lottery_config');
  return config ? JSON.parse(config) : DEFAULT_CONFIG;
}

// 後台管理頁面 UI
app.get('/admin', async (req, res) => {
  const config = await getPrizeConfig();
  let prizeRows = config.prizes.map((p, i) => `
    <tr>
      <td><input type="text" name="name_${i}" value="${p.name}" required></td>
      <td><input type="number" name="prob_${i}" value="${p.prob}" min="0" max="100" required> %</td>
    </tr>
  `).join('');

  res.send(`
    <html>
      <head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>抽獎後台管理</title></head>
      <body style="font-family:sans-serif; padding:20px; max-width:600px; margin:0 auto;">
        <h2>⚙️ 抽獎系統 - 後台管理控制台</h2>
        <form action="/admin/save" method="POST">
          <table border="1" cellpadding="8" cellspacing="0" style="width:100%; text-align:left;">
            <tr><th>獎項名稱</th><th>中獎機率 (%)</th></tr>
            ${prizeRows}
          </table>
          <br>
          <button type="submit" style="padding:10px 20px; background:#27ae60; color:white; border:none; cursor:pointer;">💾 儲存設定</button>
        </form>
      </body>
    </html>
  `);
});

// 後台儲存機率與獎項
app.post('/admin/save', async (req, res) => {
  const prizes = [];
  for (let i = 0; i < 4; i++) {
    if (req.body[`name_${i}`]) {
      prizes.push({
        name: req.body[`name_${i}`],
        prob: parseInt(req.body[`prob_${i}`] || 0)
      });
    }
  }
  await redis.set('lottery_config', JSON.stringify({ prizes }));
  res.send('<h1>✅ 設定已儲存！</h1><a href="/admin">返回後台</a>');
});

// -----------------------------------------------------------------------------
// 2. [店員設備] 產生滾動 QR Code (10秒換碼)
// -----------------------------------------------------------------------------
app.get('/api/clerk/generate-qr', async (req, res) => {
  try {
    const token = uuidv4();
    // 儲存一次性 Token，15 秒自動廢棄
    await redis.set(`qr_token:${token}`, 'active', { EX: 15 });

    const protocol = req.protocol;
    const host = req.get('host');
    const qrUrl = `${protocol}://${host}/lottery/scan?token=${token}`;

    return res.json({ success: true, token, qrUrl });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
});

// -----------------------------------------------------------------------------
// 3. [顧客手機] 掃描 QR Code (驗證 Token + 銷毀 Token + 綁定 Session)
// -----------------------------------------------------------------------------
app.get('/lottery/scan', async (req, res) => {
  const { token } = req.query;

  if (!token) return res.status(400).send('<h1>⚠️ 連結無效</h1>');

  // GETDEL 原子操作：讀取並「立即銷毀」Token，確保無法重複開啟或偷存網址
  const tokenStatus = await redis.getDel(`qr_token:${token}`);

  if (!tokenStatus) {
    return res.status(403).send(`
      <div style="text-align:center; padding:50px; font-family:sans-serif;">
        <h2>⚠️ 連結已失效</h2>
        <p>請重新掃描現場店員畫面的最新 QR Code。</p>
      </div>
    `);
  }

  const lotteryId = uuidv4();
  const sessionId = uuidv4();

  // 寫入抽獎紀錄與 Session 綁定
  await redis.hSet(`lottery:${lotteryId}`, {
    sessionId: sessionId,
    status: 'NOT_DRAWN', // 未抽獎
    prize: '',
    createdAt: Date.now().toString()
  });

  // 發放 HTTP-Only Cookie 給掃碼者的手機
  res.cookie('user_session', sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 1000
  });

  return res.redirect(`/lottery/page?id=${lotteryId}`);
});

// -----------------------------------------------------------------------------
// 4. [顧客手機] 抽獎大輪盤頁面 (防轉貼 + 自動鎖定)
// -----------------------------------------------------------------------------
app.get('/lottery/page', async (req, res) => {
  const lotteryId = req.query.id;
  const userSession = req.cookies.user_session;

  if (!lotteryId) return res.status(400).send('<h1>無效頁面</h1>');

  const lotteryData = await redis.hGetAll(`lottery:${lotteryId}`);

  if (!lotteryData || !lotteryData.sessionId) {
    return res.status(404).send('<h1>抽獎活動不存在或已過期</h1>');
  }

  // 🔒 防轉貼驗證： Session 不符 (例如轉貼給朋友) 直接檔掉
  if (!userSession || lotteryData.sessionId !== userSession) {
    return res.status(403).send(`
      <div style="text-align:center; padding:50px; font-family:sans-serif;">
        <h2>⚠️ 連結無效 / 禁止轉貼</h2>
        <p>此抽獎連結不可跨裝置或分享給他人開啟。</p>
      </div>
    `);
  }

  const config = await getPrizeConfig();
  const isRedeemed = lotteryData.status === 'REDEEMED';
  const hasDrawn = lotteryData.status === 'DRAWN' || isRedeemed;

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>幸運大輪盤</title>
      <style>
        body { font-family: sans-serif; text-align: center; background: #2c3e50; color: white; padding: 20px; }
        .box { background: white; color: #333; padding: 20px; border-radius: 12px; margin-top: 20px; }
        button { background: #27ae60; color: white; border: none; padding: 12px 25px; font-size: 18px; border-radius: 20px; cursor: pointer; }
      </style>
    </head>
    <body>
      <h1>🎁 滿額幸運抽獎</h1>
      <p>抽獎編號：${lotteryId.substring(0, 8)}</p>

      ${isRedeemed ? `
        <div class="box">
          <h2 style="color:#e74c3c;">❌ 此獎項已完成核銷</h2>
          <p>獲得獎項：<strong>${lotteryData.prize}</strong></p>
        </div>
      ` : hasDrawn ? `
        <div class="box">
          <h2 style="color:#27ae60;">🎉 恭喜中獎：${lotteryData.prize}</h2>
          <p>⚠️ 請出示此畫面給現場店員點擊核銷</p>
          <button onclick="redeem()">店員點擊現場核銷</button>
        </div>
      ` : `
        <div class="box">
          <h2 id="prizeText">準備好開始抽獎了嗎？</h2>
          <button id="drawBtn" onclick="startDraw()">開始抽獎</button>
        </div>
      `}

      <script>
        async function startDraw() {
          document.getElementById('drawBtn').disabled = true;
          const res = await fetch('/api/lottery/draw', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ lotteryId: '${lotteryId}' })
          });
          const data = await res.json();
          if (data.success) {
            alert('🎉 恭喜抽中：' + data.prize);
            location.reload();
          } else {
            alert(data.message);
          }
        }

        async function redeem() {
          if (!confirm('確定由店員進行現場核銷？')) return;
          const res = await fetch('/api/clerk/redeem', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ lotteryId: '${lotteryId}' })
          });
          const data = await res.json();
          if (data.success) {
            alert('✅ 核銷成功！');
            location.reload();
          }
        }
      </script>
    </body>
    </html>
  `);
});

// -----------------------------------------------------------------------------
// 5. [後端算獎引擎] 依照後台設定機率計算中獎結果
// -----------------------------------------------------------------------------
app.post('/api/lottery/draw', async (req, res) => {
  const { lotteryId } = req.body;
  const userSession = req.cookies.user_session;

  const lotteryData = await redis.hGetAll(`lottery:${lotteryId}`);
  if (!lotteryData || lotteryData.sessionId !== userSession) {
    return res.status(403).json({ success: false, message: '無效的請求' });
  }

  if (lotteryData.status !== 'NOT_DRAWN') {
    return res.status(400).json({ success: false, message: '您已經抽過獎了' });
  }

  // 讀取後台機率設定
  const config = await getPrizeConfig();
  const rand = Math.random() * 100;
  let cumulative = 0;
  let wonPrize = "銘謝惠顧";

  for (const p of config.prizes) {
    cumulative += p.prob;
    if (rand <= cumulative) {
      wonPrize = p.name;
      break;
    }
  }

  // 將抽獎結果寫入伺服器資料庫
  await redis.hSet(`lottery:${lotteryId}`, {
    status: 'DRAWN',
    prize: wonPrize
  });

  return res.json({ success: true, prize: wonPrize });
});

// -----------------------------------------------------------------------------
// 6. [店員核銷] 更新狀態為已失效
// -----------------------------------------------------------------------------
app.post('/api/clerk/redeem', async (req, res) => {
  const { lotteryId } = req.body;
  await redis.hSet(`lottery:${lotteryId}`, 'status', 'REDEEMED');
  return res.json({ success: true, message: '核銷成功' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server ready on port ${PORT}`));