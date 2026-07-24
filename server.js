const express = require('express');
const cookieParser = require('cookie-parser');
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// 🔒 管理者帳號與密碼設定
const ADMIN_USER = process.env.ADMIN_USER || 'A04729';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Aaa@7654321';
const AUTH_COOKIE_KEY = 'admin_session_auth_token_key';

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
// 1. 管理者登入與控制台 (設定為主網址入口 / )
// -----------------------------------------------------------------------------
const renderAdminPage = async (req, res) => {
  if (req.cookies.admin_auth !== AUTH_COOKIE_KEY) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>管理者登入</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f4f6f9; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
          .card { background: white; padding: 30px; border-radius: 16px; box-shadow: 0 8px 24px rgba(0,0,0,0.08); text-align: center; width: 320px; }
          h2 { margin-top: 0; color: #2c3e50; font-size: 20px; }
          .input-group { margin-bottom: 15px; text-align: left; }
          label { font-size: 13px; color: #666; font-weight: 600; display: block; margin-bottom: 5px; }
          input { width: 100%; padding: 11px; border: 1px solid #ddd; border-radius: 8px; box-sizing: border-box; font-size: 15px; outline: none; }
          input:focus { border-color: #27ae60; }
          button { background: #27ae60; color: white; border: none; padding: 12px; font-size: 16px; border-radius: 8px; cursor: pointer; width: 100%; font-weight: bold; margin-top: 10px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>🔒 管理者系統登入</h2>
          <form action="/admin/login" method="POST">
            <div class="input-group">
              <label>使用者帳號</label>
              <input type="text" name="username" placeholder="請輸入帳號" required autofocus>
            </div>
            <div class="input-group">
              <label>使用者密碼</label>
              <input type="password" name="password" placeholder="請輸入密碼" required>
            </div>
            <button type="submit">登入後台控制台</button>
          </form>
        </div>
      </body>
      </html>
    `);
  }

  const config = await getPrizeConfig();
  let prizes = config.prizes || [];

  while (prizes.length < 5) {
    prizes.push({ name: `五獎：新獎項${prizes.length + 1}`, prob: 0 });
  }

  let prizeRows = prizes.slice(0, 5).map((p, i) => `
    <tr>
      <td><input type="text" name="name_${i}" value="${p.name}" required style="width:100%; padding:6px; border:1px solid #ccc; border-radius:4px;"></td>
      <td style="width:110px;"><input type="number" name="prob_${i}" value="${p.prob}" min="0" max="100" required style="width:65px; padding:6px; border:1px solid #ccc; border-radius:4px;"> %</td>
    </tr>
  `).join('');

  res.send(`
    <html>
      <head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>抽獎後台管理</title></head>
      <body style="font-family:-apple-system, BlinkMacSystemFont, sans-serif; padding:20px; max-width:500px; margin:0 auto; background:#f9fbfd;">
        <h2 style="color:#2c3e50;">⚙️ 抽獎系統 - 後台控制台 (5大獎項)</h2>
        <form action="/admin/save" method="POST" style="background:white; padding:20px; border-radius:12px; box-shadow:0 4px 12px rgba(0,0,0,0.05);">
          <table border="0" cellpadding="8" cellspacing="0" style="width:100%; text-align:left; border-collapse:collapse;">
            <tr style="border-bottom:2px solid #eee;"><th>獎項名稱</th><th>機率 (%)</th></tr>
            ${prizeRows}
          </table>
          <br>
          <button type="submit" style="padding:12px 20px; background:#27ae60; color:white; border:none; border-radius:8px; cursor:pointer; font-weight:bold; width:100%; font-size:16px;">💾 儲存設定</button>
        </form>
      </body>
    </html>
  `);
};

app.get('/', renderAdminPage);
app.get('/admin', renderAdminPage);

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
    res.cookie('admin_auth', AUTH_COOKIE_KEY, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
    return res.redirect('/');
  } else {
    return res.send(`
      <div style="text-align:center; padding:50px; font-family:sans-serif;">
        <h2 style="color:#e74c3c;">❌ 帳號或密碼錯誤！</h2>
        <br>
        <a href="/" style="font-size:18px; color:#2980b9; font-weight:bold;">👉 重新輸入登入資訊</a>
      </div>
    `);
  }
});

app.post('/admin/save', async (req, res) => {
  if (req.cookies.admin_auth !== AUTH_COOKIE_KEY) {
    return res.status(403).send('權限不足');
  }

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
      <a href="/" style="font-size:18px; color:#27ae60; font-weight:bold; text-decoration:none;">👉 返回後台管理控制台</a>
    </div>
  `);
});

// -----------------------------------------------------------------------------
// 2. 店員端 - 動態滾動 QR Code 頁面 (獨立網址 /clerk)
// -----------------------------------------------------------------------------
app.get('/clerk', (req, res) => {
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
      </style>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
    </head>
    <body>
      <div class="card">
        <h2>🎉 門店滿額抽獎</h2>
        <p>請出示此畫面供顧客掃描</p>
        <div id="qrcode"></div>
        <div class="timer-box">🔄 自動換碼倒數：<span id="countdown">10</span> 秒</div>
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
// 4. 顧客掃碼驗證與【高清 Retina 手機端優化大輪盤】頁面
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
    <html lang="zh-TW">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <title>幸運大輪盤</title>
      <style>
        * { box-sizing: border-box; }
        body { 
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; 
          text-align: center; 
          background: #1e293b; 
          color: white; 
          padding: 20px 15px; 
          margin: 0; 
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
        }
        h1 { margin: 10px 0 5px 0; font-size: 24px; letter-spacing: 1px; }
        .sub-title { font-size: 12px; opacity: 0.6; margin-bottom: 20px; }
        
        .wheel-container { 
          position: relative; 
          width: 300px; 
          height: 300px; 
          margin: 10px auto; 
        }
        #wheel { 
          width: 300px; 
          height: 300px; 
          border-radius: 50%; 
          transition: transform 4s cubic-bezier(0.15, 0.99, 0.35, 1); 
        }
        
        /* 頂部立體金屬指標 */
        .pointer { 
          position: absolute; 
          top: -12px; 
          left: 50%; 
          transform: translateX(-50%); 
          width: 0; 
          height: 0; 
          border-left: 14px solid transparent; 
          border-right: 14px solid transparent; 
          border-top: 28px solid #ef4444; 
          filter: drop-shadow(0 3px 5px rgba(0,0,0,0.5));
          z-index: 20; 
        }
        
        .box { 
          background: white; 
          color: #1e293b; 
          padding: 25px 20px; 
          border-radius: 16px; 
          margin-top: 25px; 
          width: 100%;
          max-width: 320px;
          box-shadow: 0 10px 25px rgba(0,0,0,0.3);
        }
        
        .btn-draw { 
          background: linear-gradient(135deg, #10b981, #059669); 
          color: white; 
          border: none; 
          padding: 14px 35px; 
          font-size: 18px; 
          border-radius: 30px; 
          cursor: pointer; 
          font-weight: bold; 
          margin-top: 25px;
          box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4);
          transition: transform 0.2s;
        }
        .btn-draw:active { transform: scale(0.95); }
        .btn-draw:disabled { background: #64748b; box-shadow: none; }
      </style>
    </head>
    <body>
      <h1>🎁 滿額幸運抽獎</h1>
      <div class="sub-title">抽獎編號：${lotteryId.substring(0, 8)}</div>

      ${isRedeemed ? `
        <div class="box">
          <h2 style="color:#ef4444; margin-top:0;">❌ 此獎項已完成現場核銷</h2>
          <p style="font-size:18px;">獲得獎項：<strong>${lotteryData.prize}</strong></p>
        </div>
      ` : hasDrawn ? `
        <div class="box">
          <h2 style="color:#10b981; margin-top:0;">🎉 恭喜抽中</h2>
          <p style="font-size:20px; color:#0f172a; font-weight:bold;">${lotteryData.prize}</p>
          <p style="color:#64748b; font-size:13px; margin-bottom:20px;">⚠️ 請出示此畫面給現場店員點擊核銷</p>
          <button style="background:#f97316; color:white; border:none; padding:12px 25px; font-size:16px; border-radius:20px; cursor:pointer; font-weight:bold; width:100%;" onclick="redeem()">店員點擊現場核銷</button>
        </div>
      ` : `
        <div class="wheel-container">
          <div class="pointer"></div>
          <canvas id="wheel"></canvas>
        </div>
        <button id="drawBtn" class="btn-draw" onclick="startDraw()">開始旋轉抽獎</button>
      `}

      <script>
        const prizes = ${JSON.stringify(config.prizes.map(p => p.name))};
        // 高質感高級配色 (金黃/橘/紅/紫/寶藍)
        const colors = ["#f59e0b", "#f97316", "#ef4444", "#a855f7", "#3b82f6"];
        
        const canvas = document.getElementById('wheel');
        if (canvas) {
          const ctx = canvas.getContext('2d');
          const dpr = window.devicePixelRatio || 1;
          const displaySize = 300;
          
          // 像素級 Retina 高清渲染處理 (防止模糊)
          canvas.width = displaySize * dpr;
          canvas.height = displaySize * dpr;
          canvas.style.width = displaySize + 'px';
          canvas.style.height = displaySize + 'px';
          ctx.scale(dpr, dpr);

          const center = displaySize / 2;
          const radius = displaySize / 2 - 8; // 預留外框空間
          const numPrizes = prizes.length;
          const arcSize = (2 * Math.PI) / numPrizes;

          // 1. 繪製圓盤扇形區塊
          for (let i = 0; i < numPrizes; i++) {
            const angle = i * arcSize;
            ctx.beginPath();
            ctx.fillStyle = colors[i % colors.length];
            ctx.moveTo(center, center);
            ctx.arc(center, center, radius, angle, angle + arcSize);
            ctx.fill();

            // 區塊分割白線
            ctx.strokeStyle = "rgba(255,255,255,0.4)";
            ctx.lineWidth = 2;
            ctx.stroke();

            // 2. 繪製文字 (離外邊距 25px，往內延伸，智慧防重疊)
            ctx.save();
            ctx.translate(center, center);
            ctx.rotate(angle + arcSize / 2);
            ctx.textAlign = "right";
            ctx.fillStyle = "#ffffff";
            
            // 智慧處理文字長度與字體大小
            let rawText = prizes[i];
            let displayText = rawText;
            if (displayText.length > 9) {
              displayText = displayText.substring(0, 8) + '...';
            }
            const fontSize = displayText.length > 7 ? 12 : 13;
            ctx.font = 'bold ' + fontSize + 'px -apple-system, sans-serif';
            ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
            ctx.shadowBlur = 4;
            
            // 將文字放至靠近外圈寬廣處，絕不擠向圓心
            ctx.fillText(displayText, radius - 20, 4);
            ctx.restore();
          }

          // 3. 繪製精美金屬邊框
          ctx.beginPath();
          ctx.arc(center, center, radius, 0, 2 * Math.PI);
          ctx.strokeStyle = "#e2e8f0";
          ctx.lineWidth = 5;
          ctx.stroke();

          // 4. 繪製中央質感白徽章 (完美遮擋圓心尖角交會處)
          ctx.beginPath();
          ctx.arc(center, center, 32, 0, 2 * Math.PI);
          ctx.fillStyle = "#ffffff";
          ctx.shadowColor = "rgba(0,0,0,0.25)";
          ctx.shadowBlur = 8;
          ctx.fill();

          // 中央徽章圖標
          ctx.shadowBlur = 0;
          ctx.font = "20px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("🎁", center, center);
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