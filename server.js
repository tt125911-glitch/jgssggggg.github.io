const express = require('express');
const cookieParser = require('cookie-parser');
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// 記憶體備用資料庫（當 Redis 連不上時自動接手，保證絕不卡死轉圈）
let memoryConfig = {
  prizes: [
    { name: "頭獎：免費大餐", prob: 5 },
    { name: "二獎：8折優惠券", prob: 15 },
    { name: "三獎：精美小禮物", prob: 30 },
    { name: "銘謝惠顧", prob: 50 }
  ]
};
const memoryStorage = new Map();

// 初始化 Redis (設定 3 秒超時)
const redis = createClient({
  url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  socket: { connectTimeout: 3000 }
});
redis.on('error', (err) => console.error('⚠️ Redis 連線跳過/異常:', err.message));
redis.connect().catch(() => console.log('⚠️ 將啟用記憶體備用模式'));

// -----------------------------------------------------------------------------
// 超時安全保護機制：1.5 秒內 Redis 沒回應就立刻改用記憶體，絕不讓網頁轉圈卡死
// -----------------------------------------------------------------------------
async function getPrizeConfig() {
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), 1500)
    );
    const redisPromise = redis.get('lottery_config');
    const config = await Promise.race([redisPromise, timeoutPromise]);
    return config ? JSON.parse(config) : memoryConfig;
  } catch (err) {
    return memoryConfig;
  }
}

// -----------------------------------------------------------------------------
// 1. 首頁入口
// -----------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.send(`
    <div style="text-align:center; padding:50px; font-family:sans-serif;">
      <h1>🚀 門店滿額抽獎系統 API 運作中</h1>
      <p style="font-size:18px;">狀態：<span style="color:green; font-weight:bold;">🟢 伺服器正常運作</span></p>
      <hr style="max-width:300px; margin:20px auto;">
      <p><a href="/admin" style="font-size:18px; color:#27ae60; font-weight:bold; text-decoration:none;">👉 點此進入【後台管理控制台】</a></p>
    </div>
  `);
});

// -----------------------------------------------------------------------------
// 2. 後台管理控制台
// -----------------------------------------------------------------------------
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
      <body style="font-family:sans-serif; padding:20px; max-width:500px; margin:0 auto;">
        <h2>⚙️ 抽獎系統 - 後台控制台</h2>
        <form action="/admin/save" method="POST">
          <table border="1" cellpadding="8" cellspacing="0" style="width:100%; text-align:left;">
            <tr><th>獎項名稱</th><th>中獎機率 (%)</th></tr>
            ${prizeRows}
          </table>
          <br>
          <button type="submit" style="padding:10px 20px; background:#27ae60; color:white; border:none; border-radius:5px; cursor:pointer; font-weight:bold;">💾 儲存設定</button>
        </form>
      </body>
    </html>
  `);
});

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
  memoryConfig = { prizes };
  try {
    await redis.set('lottery_config', JSON.stringify({ prizes }));
  } catch (err) {}
  res.send('<h1>✅ 設定已儲存！</h1><a href="/admin">返回後台</a>');
});

// -----------------------------------------------------------------------------
// 3. 店員滾動 QR Code API
// -----------------------------------------------------------------------------
app.get('/api/clerk/generate-qr', async (req, res) => {
  try {
    const token = uuidv4();
    try {
      await redis.set(`qr_token:${token}`, 'active', { EX: 15 });
    } catch (e) {
      memoryStorage.set(`qr_token:${token}`, 'active');
      setTimeout(() => memoryStorage.delete(`qr_token:${token}`), 15000);
    }

    const protocol = req.protocol;
    const host = req.get('host');
    const qrUrl = `${protocol}://${host}/lottery/scan?token=${token}`;

    return res.json({ success: true, token, qrUrl });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
});

// -----------------------------------------------------------------------------
// 4. 顧客掃碼驗證與抽獎頁面
// -----------------------------------------------------------------------------
app.get('/lottery/scan', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('<h1>⚠️ 連結無效</h1>');

  let tokenStatus = null;
  try {
    tokenStatus = await redis.getDel(`qr_token:${token}`);
  } catch (err) {
    tokenStatus = memoryStorage.get(`qr_token:${token}`);
    memoryStorage.delete(`qr_token:${token}`);
  }

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

  const data = { sessionId, status: 'NOT_DRAWN', prize: '', createdAt: Date.now().toString() };
  try {
    await redis.hSet(`lottery:${lotteryId}`, data);
  } catch (err) {
    memoryStorage.set(`lottery:${lotteryId}`, data);
  }

  res.cookie('user_session', sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 1000
  });

  return res.redirect(`/lottery/page?id=${lotteryId}`);
});

app.get('/lottery/page', async (req, res) => {
  const lotteryId = req.query.id;
  const userSession = req.cookies.user_session;

  if (!lotteryId) return res.status(400).send('<h1>無效頁面</h1>');

  let lotteryData = {};
  try {
    lotteryData = await redis.hGetAll(`lottery:${lotteryId}`);
  } catch (err) {
    lotteryData = memoryStorage.get(`lottery:${lotteryId}`) || {};
  }

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
        body { font-family: sans-serif; text-align: center; background: #2c3e50; color: white; padding: 20px 10px; margin: 0; }
        .wheel-box { position: relative; width: 280px; height: 280px; margin: 20px auto; }
        #wheel { width: 100%; height: 100%; border-radius: 50%; transition: transform 4s cubic-bezier(0.15, 0.99, 0.35, 1); }
        .pointer { position: absolute; top: -10px; left: 50%; transform: translateX(-50%); width: 0; height: 0; border-left: 15px solid transparent; border-right: 15px solid transparent; border-top: 30px solid #e74c3c; z-index: 10; }
        .box { background: white; color: #333; padding: 20px; border-radius: 12px; margin-top: 20px; }
        button { background: #27ae60; color: white; border: none; padding: 12px 25px; font-size: 18px; border-radius: 25px; cursor: pointer; font-weight: bold; }
      </style>
    </head>
    <body>
      <h1>🎁 滿額幸運抽獎</h1>
      <p style="font-size:12px; opacity:0.8;">抽獎編號：${lotteryId.substring(0, 8)}</p>

      ${isRedeemed ? `
        <div class="box">
          <h2 style="color:#e74c3c;">❌ 此獎項已完成現場核銷</h2>
          <p>抽中獎項：<strong>${lotteryData.prize}</strong></p>
        </div>
      ` : hasDrawn ? `
        <div class="box">
          <h2 style="color:#27ae60;">🎉 恭喜抽中：${lotteryData.prize}</h2>
          <p style="color:#666; font-size:14px;">⚠️ 請出示此畫面給現場店員點擊核銷</p>
          <button style="background:#e67e22;" onclick="redeem()">店員點擊現場核銷</button>
        </div>
      ` : `
        <div class="wheel-box">
          <div class="pointer"></div>
          <canvas id="wheel" width="280" height="280"></canvas>
        </div>
        <button id="drawBtn" onclick="startDraw()">開始旋轉抽獎</button>
      `}

      <script>
        const prizes = ${JSON.stringify(config.prizes.map(p => p.name))};
        const colors = ["#f1c40f", "#e67e22", "#e74c3c", "#3498db"];
        
        const canvas = document.getElementById('wheel');
        if (canvas) {
          const ctx = canvas.getContext('2d');
          const numPrizes = prizes.length;
          const arcSize = (2 * Math.PI) / numPrizes;

          for (let i = 0; i < numPrizes; i++) {
            const angle = i * arcSize;
            ctx.beginPath();
            ctx.fillStyle = colors[i % colors.length];
            ctx.moveTo(140, 140);
            ctx.arc(140, 140, 140, angle, angle + arcSize);
            ctx.fill();

            ctx.save();
            ctx.translate(140, 140);
            ctx.rotate(angle + arcSize / 2);
            ctx.textAlign = "right";
            ctx.fillStyle = "white";
            ctx.font = "bold 13px sans-serif";
            ctx.fillText(prizes[i], 125, 5);
            ctx.restore();
          }
        }

        async function startDraw() {
          const btn = document.getElementById('drawBtn');
          btn.disabled = true;

          const res = await fetch('/api/lottery/draw', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ lotteryId: '${lotteryId}' })
          });
          const data = await res.json();

          if (data.success) {
            const winIdx = prizes.indexOf(data.prize);
            const targetIdx = winIdx !== -1 ? winIdx : 0;
            const degrees = 360 * 5 + (360 - (targetIdx * (360 / prizes.length)) - (180 / prizes.length));
            
            canvas.style.transform = "rotate(" + degrees + "deg)";
            
            setTimeout(() => {
              location.reload();
            }, 4500);
          } else {
            alert(data.message);
            btn.disabled = false;
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
// 5. 算獎與核銷 API
// -----------------------------------------------------------------------------
app.post('/api/lottery/draw', async (req, res) => {
  const { lotteryId } = req.body;
  const userSession = req.cookies.user_session;

  let lotteryData = {};
  try {
    lotteryData = await redis.hGetAll(`lottery:${lotteryId}`);
  } catch (err) {
    lotteryData = memoryStorage.get(`lottery:${lotteryId}`) || {};
  }

  if (!lotteryData || lotteryData.sessionId !== userSession) {
    return res.status(403).json({ success: false, message: '無效的請求' });
  }

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

  try {
    await redis.hSet(`lottery:${lotteryId}`, { status: 'DRAWN', prize: wonPrize });
  } catch (err) {
    lotteryData.status = 'DRAWN';
    lotteryData.prize = wonPrize;
    memoryStorage.set(`lottery:${lotteryId}`, lotteryData);
  }

  return res.json({ success: true, prize: wonPrize });
});

app.post('/api/clerk/redeem', async (req, res) => {
  const { lotteryId } = req.body;
  try {
    await redis.hSet(`lottery:${lotteryId}`, 'status', 'REDEEMED');
  } catch (err) {
    const data = memoryStorage.get(`lottery:${lotteryId}`) || {};
    data.status = 'REDEEMED';
    memoryStorage.set(`lottery:${lotteryId}`, data);
  }
  return res.json({ success: true, message: '核銷成功' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server ready on port ${PORT}`));