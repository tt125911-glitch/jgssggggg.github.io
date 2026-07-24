// -----------------------------------------------------------------------------
// 店員端 - 動態滾動 QR Code 頁面 (直接由 Render 提供)
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