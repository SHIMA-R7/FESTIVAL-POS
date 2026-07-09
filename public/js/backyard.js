const params = new URLSearchParams(location.search);
const STORE_ID = params.get('store') || 'store1';
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

let ws, salesData = [], numberMode = false;

const CIRCLE_NUMS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩',
    '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];
function ticketNum(orderNum) {
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

function connect() {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'REGISTER', role: 'backyard', storeId: STORE_ID }));
    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'REGISTERED') { document.getElementById('connecting').style.display = 'none'; if (msg.currentDay) updateDayBadge(msg.currentDay); }
        if (msg.type === 'STORE_STATE') updateState(msg.store);
        if (msg.type === 'DAY_STATE') { updateDayBadge(msg.currentDay); }
        if (msg.type === 'STORE_DELETED') location.reload();
    };
    ws.onclose = () => {
        document.getElementById('connecting').style.display = 'flex';
        setTimeout(connect, 2000);
    };
}

// ── 状態更新 ──────────────────────────────────────────────────
function updateState(store) {
    if (store.currentDay) updateDayBadge(store.currentDay);
    document.getElementById('store-name').textContent = '🍳 ' + store.name;
    document.getElementById('revenue').textContent = store.totalRevenue.toLocaleString();
    document.getElementById('sales-count').textContent = store.salesCount;

    numberMode = !!store.numberMode;
    const ind = document.getElementById('mode-indicator');
    document.getElementById('mode-label').textContent = numberMode ? '番号札モード' : '通常モード';
    ind.classList.toggle('active', numberMode);

    document.getElementById('stock-list').innerHTML = store.products.map(p => `
    <div class="stock-item">
      <div><div class="stock-name">${esc(p.name)}</div><div class="stock-price">¥${p.price}</div></div>
      <div class="stock-count${p.stock <= 5 ? ' low' : ''}">${p.stock}</div>
    </div>`).join('');

    salesData = store.sales || [];
    renderLog();
}

// ── 売上ログ描画 ──────────────────────────────────────────────
function renderLog() {
    const body = document.getElementById('log-body');
    document.getElementById('log-count').textContent = salesData.length + '件';

    if (!salesData.length) {
        body.innerHTML = '<div class="log-empty">まだ売上がありません</div>';
        return;
    }

    const productMap = {};
    salesData.forEach(s => {
        s.items.forEach(item => {
            if (!(item.id in productMap)) productMap[item.id] = item.name;
        });
    });
    const productIds = Object.keys(productMap);
    const productNames = productIds.map(id => productMap[id]);

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
        // ⑤ 取消列なし
    ].join('');

    const rows = [...salesData].map((s, i) => ({ ...s, origIndex: i })).reverse();
    const dataRows = rows.map((s, revI) => {
        const num = salesData.length - revI;
        const time = new Date(s.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
        const methodClass = s.method === 'paypay' ? 'paypay' : 'cash';
        const methodLabel = s.method === 'paypay' ? 'PayPay' : '現金';
        const isDelivered = !!s.delivered;
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
    </tr>`;
    }).join('');

    body.innerHTML = `<table class="log-table">
    <thead><tr>${headerCells}</tr></thead>
    <tbody>${dataRows}</tbody>
  </table>`;
}

// ④ バックヤードからもチェックボックス操作可能
function toggleDelivered(saleIndex) {
    ws.send(JSON.stringify({ type: 'TOGGLE_DELIVERED', storeId: STORE_ID, saleIndex }));
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

connect();