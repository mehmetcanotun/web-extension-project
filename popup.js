// popup.js - Sahibinden Fiyat Takipçisi v2.0

const STORAGE_PREFIX = 'sft_';

// ─── Yardımcı ──────────────────────────────────────────────────────────────

function formatPrice(num) {
  return num.toLocaleString('tr-TR') + ' TL';
}

function calcChange(history) {
  if (!history || history.length < 2) return null;
  const first = history[0].price;
  const last = history[history.length - 1].price;
  const pct = ((last - first) / first * 100).toFixed(1);
  return { pct: parseFloat(pct), dir: pct < 0 ? 'down' : pct > 0 ? 'up' : 'flat' };
}

function timeSince(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}dk önce`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}sa önce`;
  return `${Math.floor(hrs / 24)}g önce`;
}

// ─── Depodan Ürünleri Yükle ───────────────────────────────────────────────

function loadAllProducts() {
  return new Promise(resolve => {
    chrome.storage.local.get(null, data => {
      const products = Object.entries(data)
        .filter(([k]) => k.startsWith(STORAGE_PREFIX))
        .map(([, v]) => v)
        .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      resolve(products);
    });
  });
}

// ─── Popup Durumunu Güncelle ──────────────────────────────────────────────

function setStatus(dot, text, cls) {
  document.getElementById('status-dot').className = `status-dot ${cls}`;
  document.getElementById('status-text').textContent = text;
}

function checkCurrentTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab) return;
    const url = tab.url || '';

    if (!url.includes('sahibinden.com')) {
      setStatus(null, 'Sahibinden.com\'a gidin', 'inactive');
      document.getElementById('open-btn').textContent = 'Sahibinden\'i Aç';
      document.getElementById('open-btn').onclick = () =>
        chrome.tabs.create({ url: 'https://www.sahibinden.com' });
      return;
    }

    // URL'de ilan ID'si var mı?
    const m = url.match(/\/ilan\/[^/]+-(\d{6,})\/?/) ||
              url.match(/\/detay\/(\d+)/) ||
              url.match(/[?&]id=(\d+)/);

    if (m) {
      const id = m[1];
      chrome.storage.local.get('sft_' + id, result => {
        const data = result['sft_' + id];
        if (data) {
          setStatus(null, `Aktif — ${data.history.length} kayıt`, 'active');
        } else {
          setStatus(null, 'Yeni ilan — takip başladı', 'standby');
        }
      });
      document.getElementById('open-btn').textContent = 'Sekmeye Git';
      document.getElementById('open-btn').onclick = () =>
        chrome.tabs.update(tab.id, { active: true });
    } else {
      setStatus(null, 'İlan sayfasına gidin', 'standby');
      document.getElementById('open-btn').textContent = 'Arama Yap';
      document.getElementById('open-btn').onclick = () =>
        chrome.tabs.update(tab.id, { active: true });
    }
  });
}

// ─── Ürün Listesi Render ──────────────────────────────────────────────────

function renderProducts(products) {
  const container = document.getElementById('product-list');

  // İstatistikler
  let totalRecords = 0;
  let droppedCount = 0;
  products.forEach(p => {
    totalRecords += (p.history || []).length;
    const ch = calcChange(p.history);
    if (ch && ch.dir === 'down') droppedCount++;
  });

  document.getElementById('count-tracked').textContent = products.length;
  document.getElementById('count-dropped').textContent = droppedCount;
  document.getElementById('count-records').textContent = totalRecords;

  if (products.length === 0) {
    container.innerHTML = `
      <div class="empty">
        <div class="empty-icon">🔍</div>
        <h3>Henüz takip edilen ilan yok</h3>
        <p>Sahibinden.com'da herhangi bir ilan sayfasını ziyaret ettiğinizde<br>fiyat otomatik kaydedilir.</p>
      </div>`;
    return;
  }

  container.innerHTML = '';
  products.forEach(p => {
    if (!p || !p.history || p.history.length === 0) return;
    const last = p.history[p.history.length - 1];
    const ch = calcChange(p.history);
    const changeLabel = ch
      ? `${ch.dir === 'down' ? '▼' : ch.dir === 'up' ? '▲' : '─'} ${Math.abs(ch.pct)}%`
      : '─';

    const card = document.createElement('a');
    card.className = 'product-card';
    card.href = p.url || '#';
    card.target = '_blank';
    card.innerHTML = `
      <div class="product-name" title="${p.title}">${p.title}</div>
      <div class="product-meta">
        <span class="product-price">${formatPrice(last.price)}</span>
        <span class="product-change ${ch ? ch.dir : 'flat'}">${changeLabel}</span>
        <span class="product-date">${timeSince(p.lastSeen)}</span>
      </div>`;
    container.appendChild(card);
  });
}

// ─── CSV Export ───────────────────────────────────────────────────────────

function exportCSV(products) {
  const rows = [['Başlık', 'URL', 'Tarih', 'Saat', 'Fiyat (TL)']];
  products.forEach(p => {
    (p.history || []).forEach(h => {
      rows.push([
        `"${(p.title || '').replace(/"/g, '""')}"`,
        p.url || '',
        h.date || '',
        h.time || '',
        h.price
      ]);
    });
  });
  const csv = rows.map(r => r.join(';')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sahibinden-fiyat-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Tümünü Sil ───────────────────────────────────────────────────────────

function clearAll() {
  if (!confirm('Tüm fiyat geçmişi silinecek. Emin misiniz?')) return;
  chrome.storage.local.get(null, data => {
    const keys = Object.keys(data).filter(k => k.startsWith(STORAGE_PREFIX));
    chrome.storage.local.remove(keys, () => {
      renderProducts([]);
      document.getElementById('last-update').textContent = 'Temizlendi';
    });
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  checkCurrentTab();

  const products = await loadAllProducts();
  renderProducts(products);

  if (products.length > 0) {
    const latest = Math.max(...products.map(p => p.lastSeen || 0));
    document.getElementById('last-update').textContent = 'Son güncelleme: ' + timeSince(latest);
  }

  document.getElementById('export-btn').addEventListener('click', async () => {
    const all = await loadAllProducts();
    exportCSV(all);
  });

  document.getElementById('clear-btn').addEventListener('click', clearAll);
});
