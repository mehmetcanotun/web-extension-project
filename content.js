// Sahibinden Fiyat Takipçisi - Content Script v2.0
// Gerçek fiyat takibi, sürüklenebilir widget, trend analizi

(function () {
  'use strict';

  // ─── Sahibinden.com Sayfasını Tanıma ─────────────────────────────────────

  function getProductId() {
    // Format: /ilan/kategori-baslik-12345678/detail  veya  /ilan/.../12345678
    const patterns = [
      /\/ilan\/[^/]+-(\d{6,})\/?(?:detail)?/,
      /\/detay\/(\d+)/,
      /[?&]id=(\d+)/
    ];
    for (const re of patterns) {
      const m = window.location.href.match(re);
      if (m) return m[1];
    }
    return null;
  }

  function isProductPage() {
    if (!window.location.hostname.includes('sahibinden.com')) return false;
    const path = window.location.pathname;
    return (
      path.includes('/ilan/') ||
      path.includes('/detay/') ||
      !!getProductId()
    );
  }

  // ─── Fiyat ve Bilgi Çıkarma ───────────────────────────────────────────────

  function extractPrice() {
    // Sahibinden.com'un bilinen class/attribute yapıları
    const selectors = [
      '[data-testid="classified-price-wrapper"]',
      '.classified-detail-price-wrapper .price-value',
      '.classified-detail-price-wrapper',
      '.classifiedInfo h3',
      '.fiyat-bilgi h3',
      '#classifiedPrice',
      '[class*="price-value"]',
      '[class*="classifiedPrice"]'
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const text = el.innerText || el.textContent || '';
      if (text.match(/[\d.,]+\s*TL/i) || text.match(/[\d.,]+\s*₺/)) {
        return parsePrice(text);
      }
    }

    // Fallback: TL/₺ içeren en kısa leaf element'i bul
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim();
      if (t.match(/^[\d.,\s]+TL$/) || t.match(/^[\d.,\s]+₺$/)) {
        return parsePrice(t);
      }
    }

    return null;
  }

  function parsePrice(text) {
    // "1.250.000 TL" veya "1.250.000,00 TL" → number
    const cleaned = text.replace(/[^\d,]/g, '').replace(',', '.');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : Math.round(num);
  }

  function formatPrice(num) {
    return num.toLocaleString('tr-TR') + ' TL';
  }

  function extractTitle() {
    const selectors = [
      'h1.classifiedDetailTitle',
      '.classified-detail-summary h1',
      '[data-testid="classified-detail-header"] h1',
      'h1[class*="title"]',
      'h1'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 3) {
        return el.textContent.trim();
      }
    }
    return document.title.replace(' - Sahibinden.com', '').trim();
  }

  // ─── Veri Saklama ─────────────────────────────────────────────────────────

  const STORAGE_PREFIX = 'sft_';

  function storageKey(id) {
    return STORAGE_PREFIX + id;
  }

  async function loadProductData(id) {
    return new Promise(resolve => {
      chrome.storage.local.get(storageKey(id), result => {
        resolve(result[storageKey(id)] || null);
      });
    });
  }

  async function saveProductData(id, data) {
    return new Promise(resolve => {
      chrome.storage.local.set({ [storageKey(id)]: data }, resolve);
    });
  }

  async function recordPrice(id, title, price) {
    const existing = await loadProductData(id);
    const now = new Date();
    const entry = {
      price,
      ts: now.getTime(),
      date: now.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' }),
      time: now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
    };

    if (!existing) {
      // İlk kayıt
      const data = {
        id,
        title,
        url: window.location.href,
        history: [entry],
        firstSeen: now.getTime(),
        lastSeen: now.getTime()
      };
      await saveProductData(id, data);
      return { data, isNew: true, dropped: false };
    }

    // Güncelleme: son kayıtla aynı günde aynı fiyatsa tekrar ekleme
    const lastEntry = existing.history[existing.history.length - 1];
    const sameDay = lastEntry && lastEntry.date === entry.date;
    const samePrice = lastEntry && lastEntry.price === price;
    let dropped = false;

    if (!sameDay || !samePrice) {
      existing.history.push(entry);
    }

    // Fiyat düştü mü? (önceki kayıttan %1'den fazla)
    if (lastEntry && price < lastEntry.price) {
      const diff = ((lastEntry.price - price) / lastEntry.price * 100).toFixed(1);
      if (parseFloat(diff) >= 1) dropped = { from: lastEntry.price, to: price, pct: diff };
    }

    existing.lastSeen = now.getTime();
    existing.title = title; // başlık güncellenebilir
    existing.url = window.location.href;

    await saveProductData(id, existing);
    return { data: existing, isNew: false, dropped };
  }

  // ─── Trend Hesaplama ──────────────────────────────────────────────────────

  function calcStats(history) {
    if (!history || history.length === 0) return null;
    const prices = history.map(h => h.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const current = prices[prices.length - 1];
    const first = prices[0];
    const change = current - first;
    const changePct = first ? ((change / first) * 100).toFixed(1) : 0;
    const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
    return { min, max, current, first, change, changePct, avg, count: history.length };
  }

  // ─── Canvas Grafik ────────────────────────────────────────────────────────

  function drawChart(canvas, history, theme = 'light') {
    if (!canvas || history.length < 2) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const PAD = { top: 10, right: 10, bottom: 24, left: 8 };

    ctx.clearRect(0, 0, W, H);

    const prices = history.map(h => h.price);
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const range = maxP - minP || 1;

    const toX = i => PAD.left + (i / (prices.length - 1)) * (W - PAD.left - PAD.right);
    const toY = p => PAD.top + (1 - (p - minP) / range) * (H - PAD.top - PAD.bottom);

    // Grid lines
    ctx.strokeStyle = theme === 'dark' ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
    ctx.lineWidth = 1;
    [0.25, 0.5, 0.75].forEach(f => {
      const y = PAD.top + f * (H - PAD.top - PAD.bottom);
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(W - PAD.right, y);
      ctx.stroke();
    });

    // Gradient fill
    const grad = ctx.createLinearGradient(0, PAD.top, 0, H - PAD.bottom);
    grad.addColorStop(0, 'rgba(99,102,241,0.35)');
    grad.addColorStop(1, 'rgba(99,102,241,0.0)');
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(prices[0]));
    prices.forEach((p, i) => {
      if (i === 0) return;
      const x0 = toX(i - 1), y0 = toY(prices[i - 1]);
      const x1 = toX(i), y1 = toY(p);
      const cpx = (x0 + x1) / 2;
      ctx.bezierCurveTo(cpx, y0, cpx, y1, x1, y1);
    });
    ctx.lineTo(toX(prices.length - 1), H - PAD.bottom);
    ctx.lineTo(toX(0), H - PAD.bottom);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.moveTo(toX(0), toY(prices[0]));
    prices.forEach((p, i) => {
      if (i === 0) return;
      const x0 = toX(i - 1), y0 = toY(prices[i - 1]);
      const x1 = toX(i), y1 = toY(p);
      const cpx = (x0 + x1) / 2;
      ctx.bezierCurveTo(cpx, y0, cpx, y1, x1, y1);
    });
    ctx.stroke();

    // Dots: first, last, min, max
    const specialIdx = new Set([0, prices.length - 1,
      prices.indexOf(minP), prices.lastIndexOf(maxP)]);
    specialIdx.forEach(i => {
      const x = toX(i), y = toY(prices[i]);
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, 2 * Math.PI);
      ctx.fillStyle = '#6366f1';
      ctx.fill();
      ctx.strokeStyle = theme === 'dark' ? '#1e1e2e' : '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    // X-axis dates (first and last)
    ctx.fillStyle = theme === 'dark' ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.35)';
    ctx.font = '9px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText(history[0].date, PAD.left, H - 4);
    ctx.textAlign = 'right';
    ctx.fillText(history[history.length - 1].date, W - PAD.right, H - 4);
  }

  // ─── Widget HTML ──────────────────────────────────────────────────────────

  function buildWidget(data, stats) {
    const trend = stats.change > 0 ? '▲' : stats.change < 0 ? '▼' : '─';
    const trendClass = stats.change > 0 ? 'up' : stats.change < 0 ? 'down' : 'flat';
    const trendColor = stats.change > 0 ? '#ef4444' : stats.change < 0 ? '#22c55e' : '#94a3b8';

    const lastFive = data.history.slice(-7).reverse();
    const historyRows = lastFive.map(h => `
      <div class="sft-row">
        <span class="sft-date">${h.date} ${h.time || ''}</span>
        <span class="sft-price">${formatPrice(h.price)}</span>
      </div>
    `).join('');

    return `
      <div class="sft-header" id="sft-drag-handle">
        <div class="sft-header-left">
          <span class="sft-icon">📊</span>
          <span class="sft-title">Fiyat Takipçisi</span>
        </div>
        <div class="sft-header-right">
          <button class="sft-btn-icon" id="sft-toggle" title="Küçült">−</button>
          <button class="sft-btn-icon" id="sft-close" title="Kapat">×</button>
        </div>
      </div>

      <div class="sft-body" id="sft-body">
        <div class="sft-current">
          <div class="sft-current-price">${formatPrice(stats.current)}</div>
          <div class="sft-trend" style="color:${trendColor}">
            ${trend} ${Math.abs(stats.changePct)}% 
            <span class="sft-trend-sub">(${stats.count} kayıt)</span>
          </div>
        </div>

        <div class="sft-stats">
          <div class="sft-stat">
            <span class="sft-stat-label">En Düşük</span>
            <span class="sft-stat-value green">${formatPrice(stats.min)}</span>
          </div>
          <div class="sft-stat">
            <span class="sft-stat-label">Ortalama</span>
            <span class="sft-stat-value">${formatPrice(stats.avg)}</span>
          </div>
          <div class="sft-stat">
            <span class="sft-stat-label">En Yüksek</span>
            <span class="sft-stat-value red">${formatPrice(stats.max)}</span>
          </div>
        </div>

        <div class="sft-chart-wrap">
          <canvas id="sft-canvas" width="310" height="120"></canvas>
          ${data.history.length < 2 ? '<div class="sft-chart-msg">Grafik için daha fazla veri bekleniyor…</div>' : ''}
        </div>

        <div class="sft-history-head">Son Kayıtlar</div>
        <div class="sft-history">${historyRows}</div>
      </div>
    `;
  }

  // ─── Sürükle-Bırak ────────────────────────────────────────────────────────

  function makeDraggable(el) {
    const handle = el.querySelector('#sft-drag-handle');
    let dragging = false, startX, startY, origL, origT;

    handle.addEventListener('mousedown', e => {
      if (e.target.closest('button')) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      origL = rect.left;
      origT = rect.top;
      el.style.transition = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      el.style.left = Math.max(0, origL + dx) + 'px';
      el.style.top = Math.max(0, origT + dy) + 'px';
      el.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => { dragging = false; });
  }

  // ─── Widget Oluştur ve Sayfaya Ekle ──────────────────────────────────────

  let widgetEl = null;

  function injectWidget(data, stats) {
    // Varsa temizle
    const existing = document.getElementById('sft-widget');
    if (existing) existing.remove();

    widgetEl = document.createElement('div');
    widgetEl.id = 'sft-widget';
    widgetEl.innerHTML = buildWidget(data, stats);
    document.body.appendChild(widgetEl);

    // Grafik
    const canvas = widgetEl.querySelector('#sft-canvas');
    if (canvas && data.history.length >= 2) drawChart(canvas, data.history);

    // Toggle (küçült/büyüt)
    const body = widgetEl.querySelector('#sft-body');
    const toggleBtn = widgetEl.querySelector('#sft-toggle');
    toggleBtn.addEventListener('click', () => {
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? 'block' : 'none';
      toggleBtn.textContent = collapsed ? '−' : '+';
    });

    // Kapat
    widgetEl.querySelector('#sft-close').addEventListener('click', () => {
      widgetEl.style.animation = 'sft-slideOut 0.3s ease-in forwards';
      setTimeout(() => widgetEl.remove(), 300);
    });

    makeDraggable(widgetEl);
  }

  // ─── Ana Akış ────────────────────────────────────────────────────────────

  async function main() {
    if (!isProductPage()) return;

    const id = getProductId();
    if (!id) return;

    // Fiyat henüz DOM'a yüklenmemiş olabilir - retry
    let price = null;
    let attempts = 0;
    while (!price && attempts < 10) {
      price = extractPrice();
      if (!price) {
        await new Promise(r => setTimeout(r, 800));
        attempts++;
      }
    }

    if (!price) {
      console.warn('[SFT] Fiyat bulunamadı.');
      return;
    }

    const title = extractTitle();
    const { data, isNew, dropped } = await recordPrice(id, title, price);
    const stats = calcStats(data.history);
    if (!stats) return;

    injectWidget(data, stats);

    // Fiyat düşüşü bildirimi
    if (dropped) {
      chrome.runtime.sendMessage({
        type: 'PRICE_DROP',
        data: {
          title,
          oldPrice: formatPrice(dropped.from),
          newPrice: formatPrice(dropped.to),
          dropPercent: dropped.pct
        }
      });
    }
  }

  // Sayfa tamamen yüklendikten sonra çalıştır
  if (document.readyState === 'complete') {
    main();
  } else {
    window.addEventListener('load', main);
  }

  // SPA navigasyonları için (sahibinden bazen soft-navigate eder)
  let lastHref = window.location.href;
  setInterval(() => {
    if (window.location.href !== lastHref) {
      lastHref = window.location.href;
      setTimeout(main, 1500);
    }
  }, 1000);

})();
