const express = require('express');
const cookieParser = require('cookie-parser');
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// 記憶體資料庫 (預設 5 個獎項)
let memoryConfig = {
  prizes: [
    { name: "頭獎：這餐香香雞請你吃", prob: 5 },
    { name: "二獎：現折20元", prob: 15 },
    { name: "三獎：下次消費贈紅茶", prob: 20 },
    { name: "四獎：下次消費9折券", prob: 30 },
    { name: "五獎：精美特製小禮", prob: 30 }
  ]
};
const memoryStorage = new Map();

// 初始化 Redis
const redis = createClient({
  url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  socket: { connectTimeout: 1000, reconnectStrategy: false }
});
redis.on('error', () => {});
redis.connect().catch(() => {});

// 安全讀取設定
async function getPrizeConfig() {
  if (!redis.isOpen) return memoryConfig;
  try {
    const timeout = new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 500));
    const config = await Promise.race([redis.get('lottery_config'), timeout]);
    return config ? JSON.parse(config) : memoryConfig;
  } catch (err) {
    return memoryConfig;
  }
}

// -----------------------------------------------------------------------------
// 1. 店員端 - 動態滾動 QR Code 頁面 (預設首頁)
// -----------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="zh-TW">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>門店專用 - 動態抽獎 QR Code</title>
      <style>
        body { margin: 0; padding: 20px; display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 100vh; font-family: sans-serif; background-color: #f4f6f9; box-sizing: border-box; }
        .card { background: #ffffff; padding: 30px; border-radius: 20px; box-shadow: 0 10px 25px rgba(0,0,0,0.08); text-align: center; max-width: 340px; width: 100%; }
        h2 { margin-top: 0; color: #1a1a1a; font-size: 1.5rem; }
        p { color: #666; font-size: 0.95rem; margin-bottom: 20px; }
        #qrcode { display: flex; justify-content: center; align-items: center; margin: 20px 0; min-height: 220px; }
        .timer-box { background-color: #fff3cd; color: #856404; padding: 10px 15px; border-radius: 50px; font-weight: bold; font-size: 0.95rem; display: inline-block; margin-top: 10px; }
        .footer-link { margin-top: 25px; font-size: 12px; }
        .footer-link a { color: #999; text-decoration: none; }
      </style>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
    </head>
    <body>
      <div class="card">
        <h2>🎉 門店滿額抽獎</h2>
        <p>請出示此畫面供顧客掃描</p>
        <div id="qrcode"></div>
        <div class="timer-box">🔄 自動換碼倒數：<span id="countdown">10</span> 秒</div>
        <div class="footer-link">
          <a href="/admin">⚙️ 進入管理者後台</a>
        </div>
      </div>
      <script>
        let countdown = 10;
        async function fetchNewQRCode() {
          try {
            const response = await fetch('/api/clerk/generate-qr');
            const data = await response.json();
            if (data.success) {
              const qrcodeDiv = document.getElementById("qrcode");
              qrcodeDiv.innerHTML = "";
              new QRCode(qrcodeDiv, {
                text: data.qrUrl,
                width: 220,
                height: 220,
                colorDark: "#000000",
                colorLight: "#ffffff",
                correctLevel: QRCode.CorrectLevel.H
              });
            }
          } catch (err) {
            console.error("無法取得動態 QR Code...", err);
          }
        }
        fetchNewQRCode();
        setInterval(() => {
          countdown--;
          if (countdown <= 0) {
            countdown = 10;
            fetchNewQRCode();
          }
          document.getElementById("countdown").textContent = countdown;
        }, 1000);
      </script>
    </body>
    </html>
  `);
});

app.get('/clerk', (req, res) => res.redirect('/'));

// -----------------------------------------------------------------------------
// 2. 後台管理控制台 (強制補齊顯示 5 個欄位)
// -----------------------------------------------------------------------------
app.get('/admin', async (req, res) => {
  const config = await getPrizeConfig();
  let prizes = config.prizes || [];

  // 強制補齊至 5 個獎項欄位
  while (prizes.length < 5) {
    prizes.push({ name: `五獎：新獎項${prizes.length + 1}`, prob: 0 });
  }

  let prizeRows = prizes.slice(0, 5).map((p, i) => `
    <tr>
      <td><input type="text" name="name_${i}" value="${p.name}" required></td>
      <td><input type="number" name="prob_${i}" value="${p.prob}" min="0" max="100" required> %</td>
    </tr>
  `).join('');

  res.send(`
    <html>
      <head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>抽獎後台管理</title></head>
      <body style="font-family:sans-serif; padding:20px; max-width:500px; margin:0 auto;">
        <h2>⚙️ 抽獎系統 - 後台控制台 (固定5大獎項)</h2>
        <form action="/admin/save" method="POST">
          <table border="1" cellpadding="8" cellspacing="0" style="width:100%; text-align:left;">
            <tr><th>獎項名稱</th><th>中獎機率 (%)</th></tr>
            ${prizeRows}
          </table>
          <br>
          <button type="submit" style="padding:10px 20px; background:#27ae60; color:white; border:none; border-radius:5px; cursor:pointer; font-weight:bold;">💾 儲存設定</button>
        </form>
        <br>
        <p><a href="/" style="color:#2980b9;">📱 返回門店店員畫面</a></p>
      </body>
    </html>
  `);
});

app.post('/admin/save', async (req, res) => {
  const prizes = [];
  for (let i = 0; i < 5; i++) {
    if (req.body[`name_${i}`]) {
      prizes.push({
        name: req.body[`name_${i}`],
        prob: parseInt(req.body[`prob_${i}`] || 0)
      });
    }
  }
  memoryConfig = { prizes };

  if (redis.isOpen) {
    redis.set('lottery_config', JSON.stringify({ prizes })).catch(() => {});
  }

  res.send(`
    <div style="text-align:center; padding:50px; font-family:sans-serif;">
      <h1>✅ 5 個獎項設定已成功儲存！</h1>
      <br>
      <a href="/admin" style="font-size:18px; color:#27ae60; font-weight:bold; text-decoration:none;">👉 返回後台管理控制台</a> | 
      <a href="/" style="font-size:18px; color:#2980b9; font-weight:bold; text-decoration:none;">📱 開啟店員畫面</a>
    </div>
  `);
});

// -----------------------------------------------------------------------------
// 3. 店員滾動 QR Code API
// -----------------------------------------------------------------------------
app.get('/api/clerk/generate-qr', async (req, res) => {
  try {
    const token = uuidv4();
    memoryStorage.set(`qr_token:${token}`, 'active');
    setTimeout(() => memoryStorage.delete(`qr_token:${token}`), 15000);

    if (redis.isOpen) {
      redis.set(`qr_token:${token}`, 'active', { EX: 15 }).catch(() => {});
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
// 4. 顧客掃碼驗證與 5 扇形大輪盤抽獎頁面
// -----------------------------------------------------------------------------
app.get('/lottery/scan', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('<h1>⚠️ 連結無效</h1>');

  let tokenStatus = memoryStorage.get(`qr_token:${token}`);
  memoryStorage.delete(`qr_token:${token}`);

  if (!tokenStatus && redis.isOpen) {
    try {
      tokenStatus = await redis.getDel(`qr_token:${token}`);
    } catch (e) {}
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
  memoryStorage.set(`lottery:${lotteryId}`, data);

  if (redis.isOpen) {
    redis.hSet(`lottery:${lotteryId}`, data).catch(() => {});
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

  let lotteryData = memoryStorage.get(`lottery:${lotteryId}`) || {};

  if (!lotteryData.sessionId && redis.isOpen) {
    try {
      lotteryData = await redis.hGetAll(`lottery:${lotteryId}`);
    } catch (err) {}
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
        const colors = ["#f1c40f", "#e67e22", "#e74c3c", "#9b59b6", "#3498db"];
        
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

  let lotteryData = memoryStorage.get(`lottery:${lotteryId}`) || {};

  if (!lotteryData.sessionId && redis.isOpen) {
    try {
      lotteryData = await redis.hGetAll(`lottery:${lotteryId}`);
    } catch (err) {}
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

  lotteryData.status = 'DRAWN';
  lotteryData.prize = wonPrize;
  memoryStorage.set(`lottery:${lotteryId}`, lotteryData);

  if (redis.isOpen) {
    redis.hSet(`lottery:${lotteryId}`, { status: 'DRAWN', prize: wonPrize }).catch(() => {});
  }

  return res.json({ success: true, prize: wonPrize });
});

app.post('/api/clerk/redeem', async (req, res) => {
  const { lotteryId } = req.body;
  const data = memoryStorage.get(`lottery:${lotteryId}`) || {};
  data.status = 'REDEEMED';
  memoryStorage.set(`lottery:${lotteryId}`, data);

  if (redis.isOpen) {
    redis.hSet(`lottery:${lotteryId}`, 'status', 'REDEEMED').catch(() => {});
  }

  return res.json({ success: true, message: '核銷成功' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server ready on port ${PORT}`));