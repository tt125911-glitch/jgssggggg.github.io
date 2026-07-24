const express = require('express');
const cookieParser = require('cookie-parser');
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(cookieParser());

// 初始化 Redis 連線
const redis = createClient();
redis.connect().catch(console.error);

// -----------------------------------------------------------------------------
// 1. [店員設備] 產生滾動 QR Code (每 10 秒由前端發起請求)
// -----------------------------------------------------------------------------
app.get('/api/clerk/generate-qr', async (req, res) => {
  try {
    const token = uuidv4();
    
    // 將 Token 存入 Redis，15 秒自動過期 (覆蓋 10 秒換碼週期 + 網路延遲)
    await redis.set(`qr_token:${token}`, 'active', { EX: 15 });

    // 構造顧客掃描的網址
    const qrUrl = `https://yourdomain.com/lottery/scan?token=${token}`;

    return res.json({ success: true, token, qrUrl });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
});

// -----------------------------------------------------------------------------
// 2. [顧客手機] 掃描 QR Code 進入 (驗證 Token 並綁定 Session)
// -----------------------------------------------------------------------------
app.get('/lottery/scan', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).send('<h1>請求無效：缺少 Token</h1>');
  }

  // 原子操作 GETDEL：讀取並「立即刪除」Token，保證該 Token 只能被使用一次
  const tokenStatus = await redis.getDel(`qr_token:${token}`);

  if (!tokenStatus) {
    // 若 Token 已被前一人掃走或已逾時過期
    return res.status(403).send('<h1>連結已失效或已被使用</h1>');
  }

  // 1. 產生該次抽獎實例的 ID (lotteryId)
  const lotteryId = uuidv4();
  // 2. 產生該顧客手機專屬的 Session ID
  const sessionId = uuidv4();

  // 3. 在 Redis 紀錄這筆抽獎資料與綁定的 Session ID
  await redis.hSet(`lottery:${lotteryId}`, {
    sessionId: sessionId,
    status: 'UNCLAIMED', // 狀態: UNCLAIMED (未核銷) / REDEEMED (已核銷)
    createdAt: Date.now().toString()
  });

  // 4. 設定 HTTP-Only Cookie 將 Session ID 發放給該顧客手機
  res.cookie('user_session', sessionId, {
    httpOnly: true, // 防止 JS 讀取竊取
    secure: true,   // 正式環境僅允許 HTTPS
    maxAge: 60 * 60 * 1000 // Session 存活 1 小時
  });

  // 5. 重導向至抽獎實體頁面
  return res.redirect(`/lottery/page?id=${lotteryId}`);
});

// -----------------------------------------------------------------------------
// 3. [顧客手機 / 轉貼頁面] 請求抽獎頁面 (防轉分享驗證機制)
// -----------------------------------------------------------------------------
app.get('/lottery/page', async (req, res) => {
  const lotteryId = req.query.id;
  const userSession = req.cookies.user_session; // 拿顧客手機的 Cookie

  if (!lotteryId) {
    return res.status(400).send('<h1>無效的頁面網址</h1>');
  }

  // 讀取該抽獎 ID 紀錄
  const lotteryData = await redis.hGetAll(`lottery:${lotteryId}`);

  if (!lotteryData || !lotteryData.sessionId) {
    return res.status(404).send('<h1>抽獎活動不存在或已過期</h1>');
  }

  // 核心檢查：無 Session 或 Cookie 內的 Session 與 Redis 紀錄不匹配 (例如朋友點開連結)
  if (!userSession || lotteryData.sessionId !== userSession) {
    return res.status(403).send(`
      <div style="text-align:center; padding: 50px;">
        <h2>⚠️ 連結失效</h2>
        <p>此連結已被他人開啟，或不可跨裝置/轉貼分享。</p>
      </div>
    `);
  }

  // 檢查是否已核銷
  const isRedeemed = lotteryData.status === 'REDEEMED';

  return res.send(`
    <html>
      <body style="text-align: center; font-family: sans-serif; padding: 20px;">
        <h1>🎉 幸運抽獎頁面</h1>
        <p>抽獎編號：${lotteryId}</p>
        <p>狀態：<strong>${isRedeemed ? '❌ 已失效/已核銷' : '✅ 有效/未核銷'}</strong></p>
        ${!isRedeemed ? '<button onclick="alert(\'請出示此畫面給店員核銷\')">出示店員核銷</button>' : ''}
      </body>
    </html>
  `);
});

// -----------------------------------------------------------------------------
// 4. [店員手機] 點擊核銷請求
// -----------------------------------------------------------------------------
app.post('/api/clerk/redeem', async (req, res) => {
  const { lotteryId } = req.body;

  if (!lotteryId) {
    return res.status(400).json({ success: false, message: '缺少抽獎編號' });
  }

  const status = await redis.hGet(`lottery:${lotteryId}`, 'status');

  if (!status) {
    return res.status(404).json({ success: false, message: '找不到該筆抽獎資料' });
  }

  if (status === 'REDEEMED') {
    return res.status(400).json({ success: false, message: '該獎項先前已完成核銷' });
  }

  // 將狀態更新為「已核銷 / 已失效」
  await redis.hSet(`lottery:${lotteryId}`, 'status', 'REDEEMED');

  return res.json({ success: true, message: '核銷成功！' });
});

app.listen(3000, () => {
  console.log('Server high-availability anti-fraud API running on port 3000');
});