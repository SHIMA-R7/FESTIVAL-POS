const params = new URLSearchParams(location.search);
const STORE_ID = params.get('store') || 'store1';
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

let ws, salesData = [], pendingRevertIndex = null, numberMode = false;

// 丸数字変換（1〜20）
const CIRCLE_NUMS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩',
    '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];
function toCircle(n) {
    const r = n % 20;
    const idx = r === 0 ? 19 : r - 1;
    return CIRCLE_NUMS[idx];
}
function ticketNum(orderNum) { // 1始まりの注文番号 → %20 の丸数字
    const r = orderNum % 20;
    return r === 0 ? 20 : r;
}

// 時計
setInterval(() => {
    const now = new Date();
    document.getElementById('time').textContent =
        String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
}, 1000);

// ── WebSocket ──────────────────────────────────────────────────
function updateDayBadge(day) {
    const el = document.getElementById('day-badge-hdr');
    if (!el) return;
    el.textContent = day === 2 ? '2日目' : '1日目';
    el.className = 'day-badge-hdr ' + (day === 2 ? 'day2' : 'day1');
}

function toggleOverStock(productId) {
    ws.send(JSON.stringify({ type: 'TOGGLE_OVER_STOCK', storeId: STORE_ID, productId }));
}

function connect() {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'REGISTER', role: 'staff', storeId: STORE_ID }));
    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'REGISTERED') { document.getElementById('connecting').style.display = 'none'; if (msg.currentDay) updateDayBadge(msg.currentDay); }
        if (msg.type === 'STORE_STATE') updateState(msg.store);
        if (msg.type === 'DAY_STATE') { updateDayBadge(msg.currentDay); }
        if (msg.type === 'ERROR') alert('エラー: ' + msg.message);
    };
    ws.onclose = () => {
        document.getElementById('connecting').style.display = 'flex';
        setTimeout(connect, 2000);
    };
}

// ── 状態更新 ──────────────────────────────────────────────────
function updateState(store) {
    if (store.currentDay) updateDayBadge(store.currentDay);
    document.getElementById('store-name').textContent = '🎪 ' + store.name;
    document.getElementById('revenue').textContent = store.totalRevenue.toLocaleString();
    const totalItems = (store.sales || []).reduce(function (sum, s) { return sum + (s.items || []).reduce(function (s2, i) { return s2 + i.qty; }, 0); }, 0);
    document.getElementById('sales-count').textContent = totalItems;

    // numberModeをサーバー側の値に同期
    numberMode = !!store.numberMode;
    countUpMode = !!store.countUpMode;
    currentTheme = store.theme || 'orange';
    // カウントアップモードボタン更新
    const btnCu = document.getElementById('mode-btn-cu');
    if (btnCu) {
        document.getElementById('cu-label').textContent = countUpMode ? 'カウントアップ中（解除）' : 'カウントアップモード';
        btnCu.classList.toggle('active', countUpMode);
    }
    renderThemeBtns();
    const btn = document.getElementById('mode-btn');
    document.getElementById('mode-label').textContent = numberMode ? '番号札モード' : '通常モード';
    btn.classList.toggle('active', numberMode);

    // 在庫
    document.getElementById('stock-list').innerHTML = store.products.map(p => {
        const isOver = p.overStock;
        const showOver = isOver || p.stock <= 0;
        const countClass = isOver ? ' over' : (p.stock <= 5 ? ' low' : '');
        const countText = isOver ? '突破中+' + (p.overCount || 0) : p.stock;
        const overBtn = (p.stock <= 0 || isOver) ?
            '<button class="btn-overstock' + (isOver ? ' active' : '') + '" onclick="toggleOverStock(' + p.id + ')">' +
            (isOver ? '⚡ 突破モード中（解除）' : '⚡ 上限突破モード') + '</button>' : '';
        return '<div class="stock-item" style="flex-direction:column;align-items:stretch;gap:4px;">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;">' +
            '<div><div class="stock-name">' + esc(p.name) + '</div><div class="stock-price">¥' + p.price + '</div></div>' +
            '<div class="stock-count' + countClass + '">' + countText + '</div>' +
            '</div>' + overBtn +
            '</div>';
    }).join('');

    // 決済待ち
    renderPendingArea(store.pendingPayment);

    // 売上ログ
    salesData = store.sales || [];
    renderLog();
}

// ② モード切替
function toggleMode() {
    ws.send(JSON.stringify({ type: 'SET_NUMBER_MODE', storeId: STORE_ID, numberMode: !numberMode }));
}

// カウントアップモード切替
function toggleCountUpMode() {
    if (!countUpMode) {
        // オンにする時だけ警告
        if (!confirm(
            'カウントアップモードに切り替えますか？\n\n' +
            '・在庫数は減算されず、売上数をカウントアップします\n' +
            '・目標数を超えると客画面に突破バナーが表示されます\n' +
            '・モードを解除するとカウントはリセットされます'
        )) return;
    }
    ws.send(JSON.stringify({ type: 'SET_COUNT_UP_MODE', storeId: STORE_ID, countUpMode: !countUpMode }));
}

// 設定パネル開閉
function toggleSettings() {
    const panel = document.getElementById('settings-panel');
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
}

// テーマ色定義
const THEMES = {
    orange: '#E94560', red: '#E53E3E', blue: '#3B82F6',
    green: '#10B981', purple: '#8B5CF6', dark: '#374151'
};

function renderThemeBtns() {
    const wrap = document.getElementById('theme-btns');
    if (!wrap) return;
    wrap.innerHTML = Object.entries(THEMES).map(function (e) {
        var key = e[0], color = e[1];
        return '<div class="theme-dot' + (currentTheme === key ? ' selected' : '') + '" style="background:' + color + ';" onclick="setTheme(\'' + key + '\')" title="' + key + '"></div>';
    }).join('');
}

function setTheme(theme) {
    ws.send(JSON.stringify({ type: 'UPDATE_THEME', storeId: STORE_ID, theme }));
}

// ロゴアップロード
function uploadLogo(input) {
    if (!input.files[0]) return;
    const file = input.files[0];
    const formData = new FormData();
    formData.append('storeId', STORE_ID);
    formData.append('field', 'logo');
    formData.append('file', file);
    fetch('/api/upload', { method: 'POST', body: formData })
        .then(r => r.json())
        .then(d => { if (d.url) ws.send(JSON.stringify({ type: 'UPDATE_LOGO', storeId: STORE_ID, logo: d.url })); })
        .catch(e => alert('アップロード失敗: ' + e.message));
}

// ── 決済待ちパネル ────────────────────────────────────────────
function renderPendingArea(pending) {
    const area = document.getElementById('pending-area');
    document.getElementById('pending-idle').style.display = pending ? 'none' : '';
    const old = document.getElementById('payment-panel');
    if (old) old.remove();
    if (!pending) return;

    const methodLabel = pending.method === 'paypay' ? '📱 PayPay' : '💴 現金';
    const methodClass = pending.method === 'paypay' ? 'method-paypay' : 'method-cash';
    const panel = document.createElement('div');
    panel.id = 'payment-panel';
    panel.className = 'payment-panel';
    panel.innerHTML = `
    <div class="payment-panel-header">
      <div class="payment-method-tag ${methodClass}">${methodLabel}</div>
      <div class="waiting-label">決済待ち</div>
      <div class="waiting-dot"></div>
    </div>
    <div class="payment-items">
      ${pending.items.map(i => `
        <div class="payment-item">
          <div><span class="pi-name">${esc(i.name)}</span><span class="pi-qty">× ${i.qty}</span></div>
          <div class="pi-price">¥${(i.price * i.qty).toLocaleString()}</div>
        </div>`).join('')}
    </div>
    <div class="payment-total">
      <span class="pt-label">お会計</span>
      <span class="pt-amount">¥${pending.total.toLocaleString()}</span>
    </div>
    <button class="btn-confirm" onclick="confirmPayment()">✅ 決済が完了した</button>`;
    area.appendChild(panel);
}

function confirmPayment() {
    ws.send(JSON.stringify({ type: 'CONFIRM_PAYMENT', storeId: STORE_ID }));
}

// ── 売上ログ描画 ──────────────────────────────────────────────
function renderLog() {
    const body = document.getElementById('log-body');
    document.getElementById('log-count').textContent = salesData.length + '件';

    if (!salesData.length) {
        body.innerHTML = '<div class="log-empty">まだ売上がありません</div>';
        return;
    }

    // 全取引に登場するすべての商品を列として収集（登場順）
    const productMap = {};
    salesData.forEach(s => {
        s.items.forEach(item => {
            if (!(item.id in productMap)) productMap[item.id] = item.name;
        });
    });
    const productIds = Object.keys(productMap);
    const productNames = productIds.map(id => productMap[id]);

    // ヘッダー行構築
    const ticketHeader = numberMode
        ? '<th class="col-ticket">番号札</th><th class="col-delivered">渡</th>'
        : '';
    const headerCells = [
        '<th class="col-fixed col-num">#</th>',
        ticketHeader,
        '<th class="col-fixed col-time">時刻</th>',
        '<th class="col-method">支払</th>',
        ...productNames.map(name => `<th title="${esc(name)}">${esc(name.length > 6 ? name.slice(0, 5) + '…' : name)}</th>`),
        '<th class="col-total">合計</th>',
        '<th class="col-revert"></th>',
    ].join('');

    // データ行構築（新しい順）
    const rows = [...salesData].map((s, i) => ({ ...s, origIndex: i })).reverse();
    const dataRows = rows.map((s, revI) => {
        const num = salesData.length - revI;  // 1始まりの注文番号
        const time = new Date(s.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
        const methodClass = s.method === 'paypay' ? 'paypay' : 'cash';
        const methodLabel = s.method === 'paypay' ? 'PayPay' : '現金';
        const isDelivered = !!s.delivered;

        // ③④ 番号札モード列
        const tn = ticketNum(num);
        const ticketCells = numberMode ? `
      <td class="col-ticket" style="padding:0 2px;">
        <div class="ticket-cell">
          <div class="ticket-order-num">#${num}</div>
          <div class="ticket-circle">${CIRCLE_NUMS[tn - 1]}</div>
        </div>
      </td>
      <td class="col-delivered-td col-delivered" style="text-align:center;vertical-align:middle;">
        <input type="checkbox" class="delivered-cb" ${isDelivered ? 'checked' : ''}
          onchange="toggleDelivered(${s.origIndex})" onclick="event.stopPropagation()">
      </td>` : '';

        // 各商品列のセル
        const qtyCells = productIds.map(pid => {
            const found = s.items.find(i => String(i.id) === String(pid));
            const qty = found ? found.qty : 0;
            return qty > 0
                ? `<td class="qty-pos">${qty}</td>`
                : `<td class="qty-zero">—</td>`;
        }).join('');

        return `<tr id="log-row-${s.origIndex}" class="${isDelivered ? 'is-delivered' : ''}">
      <td class="col-fixed col-num">#${num}</td>
      ${ticketCells}
      <td class="col-fixed col-time">${time}</td>
      <td class="col-method"><span class="log-method ${methodClass}">${methodLabel}</span></td>
      ${qtyCells}
      <td class="col-total">¥${s.total.toLocaleString()}</td>
      <td class="col-revert"><button class="btn-revert" onclick="openDialog(${s.origIndex})">取消</button></td>
    </tr>`;
    }).join('');

    body.innerHTML = `<table class="log-table">
    <thead><tr>${headerCells}</tr></thead>
    <tbody>${dataRows}</tbody>
  </table>`;
}

// ④ 受け渡しチェック
function toggleDelivered(saleIndex) {
    ws.send(JSON.stringify({ type: 'TOGGLE_DELIVERED', storeId: STORE_ID, saleIndex }));
}

// ── 取り消しダイアログ ────────────────────────────────────────
function openDialog(saleIndex) {
    const s = salesData[saleIndex];
    if (!s) return;
    pendingRevertIndex = saleIndex;
    const time = new Date(s.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    document.getElementById('dialog-detail').innerHTML =
        `<strong>時刻:</strong> ${time}<br>` +
        `<strong>支払:</strong> ${s.method === 'paypay' ? 'PayPay' : '現金'}<br>` +
        `<strong>商品:</strong><br>${s.items.map(i => `　${esc(i.name)} × ${i.qty} = ¥${(i.price * i.qty).toLocaleString()}`).join('<br>')}<br>` +
        `<strong>合計: ¥${s.total.toLocaleString()}</strong>`;
    document.getElementById('dialog-overlay').classList.add('visible');
}

function closeDialog() {
    document.getElementById('dialog-overlay').classList.remove('visible');
    pendingRevertIndex = null;
}

function executeRevert() {
    if (pendingRevertIndex === null) return;
    ws.send(JSON.stringify({ type: 'REVERT_SALE', storeId: STORE_ID, saleIndex: pendingRevertIndex }));
    closeDialog();
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

connect();