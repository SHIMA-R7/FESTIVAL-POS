const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
let ws, storeList = [], editingProducts = [], currentProductStoreId = null, logoStoreId = null;
let currentDay = 1, pendingDay = null;
let adminPassword = sessionStorage.getItem('admin_pw') || '';

// ── WebSocket ──────────────────────────────────────────────────
function connect() {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
        if (adminPassword) {
            ws.send(JSON.stringify({ type: 'REGISTER', role: 'admin', storeId: null, password: adminPassword }));
        } else {
            showLoginGate(false);
        }
    };
    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'AUTH_FAILED') { showLoginGate(true); return; }
        if (msg.type === 'REGISTERED') {
            hideLoginGate();
            if (msg.currentDay) { currentDay = msg.currentDay; updateDayUI(); }
        }
        // STORE_LISTだけでセレクトを更新（選択中の値を保持）
        if (msg.type === 'STORE_LIST') { storeList = msg.stores; renderStoreList(); updateSelects(); }
        if (msg.type === 'DAY_STATE') { currentDay = msg.currentDay; updateDayUI(); }
        if (msg.type === 'STORE_STATE') onStoreState(msg.store);
        if (msg.type === 'STORE_CREATED') toast('✅ 出店を作成しました');
        if (msg.type === 'RESET_STOCK_DONE') toast('🔄 在庫をリセットしました');
        if (msg.type === 'SALES_DATA') renderSales(msg.sales, msg.totalRevenue, msg.currentDay);
        if (msg.type === 'ERROR') alert('エラー: ' + msg.message);
    };
    ws.onclose = () => setTimeout(connect, 2000);
}

// ── パスワードゲート ──────────────────────────────────────────────
function showLoginGate(isError) {
    document.getElementById('admin-app').style.display = 'none';
    document.getElementById('login-gate').style.display = 'flex';
    document.getElementById('login-error').style.display = isError ? 'block' : 'none';
    if (isError) {
        sessionStorage.removeItem('admin_pw');
        adminPassword = '';
        document.getElementById('login-pw-input').value = '';
        document.getElementById('login-pw-input').focus();
    }
}

function hideLoginGate() {
    document.getElementById('login-gate').style.display = 'none';
    document.getElementById('admin-app').style.display = '';
}

function submitLogin() {
    const pw = document.getElementById('login-pw-input').value;
    if (!pw) return;
    adminPassword = pw;
    sessionStorage.setItem('admin_pw', pw);
    ws.send(JSON.stringify({ type: 'REGISTER', role: 'admin', storeId: null, password: adminPassword }));
}

// ── STORE_STATE受信ハンドラ（選択状態を壊さない）──────────────
let pendingStoreStateResolve = null;

function onStoreState(store) {
    // 商品エディタ読み込み中の場合のみ処理
    if (pendingStoreStateResolve) {
        pendingStoreStateResolve(store);
        pendingStoreStateResolve = null;
    }
    // ロゴプレビュー更新（エディタが開いている場合のみ）
    if (logoStoreId) updateLogoPreview(store.logo);
}

function waitForStoreState() {
    return new Promise(resolve => { pendingStoreStateResolve = resolve; });
}

// ── 日切替 ─────────────────────────────────────────────────────
function updateDayUI() {
    const isDay2 = currentDay === 2;
    document.getElementById('day-toggle-input').checked = isDay2;
    document.getElementById('current-day-badge').textContent = isDay2 ? '2日目' : '1日目';
    document.getElementById('current-day-badge').className = 'day-badge ' + (isDay2 ? 'day2' : 'day1');
    document.getElementById('header-day-badge').textContent = isDay2 ? '2日目' : '1日目';
    document.getElementById('header-day-badge').className = 'day-badge ' + (isDay2 ? 'day2' : 'day1');
}

function onDayToggleChange(input) {
    // 即座に元に戻す（確認後に切替）
    input.checked = currentDay === 2;
    const toDay = currentDay === 1 ? 2 : 1;
    pendingDay = toDay;
    const fromLabel = currentDay + '日目';
    const toLabel = toDay + '日目';
    document.getElementById('day-dialog-icon').textContent = toDay === 2 ? '📅' : '🔙';
    document.getElementById('day-dialog-title').textContent = fromLabel + ' → ' + toLabel + ' に切り替えますか？';
    document.getElementById('day-dialog-desc').textContent =
        '切り替えると、すべての出店・端末の表示が' + toLabel + 'の内容に変わります。' +
        '在庫・商品ラインナップ・売上データはそれぞれ独立しています。';
    document.getElementById('day-dialog-warn').innerHTML =
        '<strong>⚠️ 注意：</strong> 切り替え中の取引は中断されます。<br>' +
        '売上データは日ごとに保存されるため、' + fromLabel + 'のデータは失われません。<br>' +
        '双方向に切り替え可能です（テストも可能）。';
    const confirmBtn = document.getElementById('btn-day-confirm');
    confirmBtn.textContent = toLabel + ' に切り替える';
    confirmBtn.className = 'btn-day-confirm' + (toDay === 2 ? ' to-day2' : '');
    document.getElementById('day-dialog-overlay').classList.add('visible');
}

function closeDayDialog() {
    document.getElementById('day-dialog-overlay').classList.remove('visible');
    pendingDay = null;
}

function executeDaySwitch() {
    if (!pendingDay) return;
    ws.send(JSON.stringify({ type: 'SET_DAY', day: pendingDay }));
    closeDayDialog();
    toast('📅 ' + pendingDay + '日目に切り替えました');
}

// ── 出店一覧 ──────────────────────────────────────────────────
function createStore() {
    const id = document.getElementById('new-store-id').value.trim();
    const name = document.getElementById('new-store-name').value.trim();
    if (!id || !name) { alert('IDと名前を入力してください'); return; }
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) { alert('IDは英数字・_・-のみ使用できます'); return; }
    ws.send(JSON.stringify({ type: 'CREATE_STORE', newStoreId: id, storeName: name }));
    document.getElementById('new-store-id').value = '';
    document.getElementById('new-store-name').value = '';
}

let sortKey = 'id'; // 'id' or 'name'

function sortStores(key) {
    sortKey = key;
    document.getElementById('sort-id').style.fontWeight = key === 'id' ? '900' : '';
    document.getElementById('sort-name').style.fontWeight = key === 'name' ? '900' : '';
    renderStoreList();
}

function confirmResetStock() {
    const storeId = document.getElementById('reset-store-sel').value;
    const day = document.getElementById('reset-day-sel').value;
    const storeName = storeId
        ? (storeList.find(s => s.id === storeId) || {}).name || storeId
        : '全出店';
    const dayLabel = day === 'both' ? '両日' : day + '日目';
    if (!confirm('【' + storeName + '】の ' + dayLabel + ' の在庫を初期値に戻しますか？\n\n売上データも同時にリセットされます。\nこの操作は取り消せません。')) return;
    ws.send(JSON.stringify({ type: 'RESET_STOCK', storeId: storeId || null, day: day === 'both' ? 'both' : parseInt(day) }));
}

function exportAllUrls() {
    if (!storeList.length) { alert('出店がありません'); return; }
    const base = location.protocol + '//' + location.host;
    const obj = {};
    storeList.forEach(function (s) {
        obj[s.id] = {
            name: s.name,
            customer: base + '/customer?store=' + s.id,
            staff: base + '/staff?store=' + s.id,
            backyard: base + '/backyard?store=' + s.id
        };
    });
    const json = JSON.stringify(obj, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'store_urls.json';
    a.click();
    toast('📥 store_urls.json をダウンロードしました');
}

function renderStoreList() {
    const grid = document.getElementById('store-grid');
    if (!storeList.length) { grid.innerHTML = '<div class="empty-state">出店がありません</div>'; return; }
    const sorted = storeList.slice().sort(function (a, b) {
        if (sortKey === 'name') return a.name.localeCompare(b.name, 'ja');
        return a.id.localeCompare(b.id);
    });
    const THEME_LABELS = { orange: '🟠 オレンジ', red: '🔴 レッド', blue: '🔵 ブルー', green: '🟢 グリーン', purple: '🟣 パープル', dark: '⚫ ダーク' };
    grid.innerHTML = sorted.map(function (s) {
        const themeOpts = Object.keys(THEME_LABELS).map(function (k) {
            const sel = (s.theme || 'orange') === k ? ' selected' : '';
            return '<option value="' + k + '"' + sel + '>' + THEME_LABELS[k] + '</option>';
        }).join('');
        return '<div class="store-card">' +
            '<div class="sc-head">' +
            '<div class="sc-icon">🏪</div>' +
            '<div class="sc-title" style="flex:1">' +
            '<div style="display:flex;align-items:center;gap:8px;">' +
            '<h3 id="sname-' + s.id + '">' + s.name + '</h3>' +
            '<button class="link-btn" style="background:#EEF0FF;color:#3B4CCA;padding:3px 8px;font-size:0.72rem;" onclick="startRename(\'' + s.id + '\')">✏️ 編集</button>' +
            '</div>' +
            '<div class="sc-id">ID: ' + s.id + '</div>' +
            '</div>' +
            '<button class="link-btn" style="background:#FFF0F0;color:#E53E3E;font-size:0.72rem;" onclick="deleteStore(\'' + s.id + '\',\'' + s.name + '\')">🗑️ 削除</button>' +
            '</div>' +
            '<div style="margin-bottom:10px;display:flex;align-items:center;gap:8px;">' +
            '<span style="font-size:0.78rem;color:var(--text-muted);white-space:nowrap;">客画面テーマ:</span>' +
            '<select class="input" style="flex:1;padding:5px 8px;font-size:0.8rem;" onchange="updateTheme(\'' + s.id + '\',this.value)">' +
            themeOpts +
            '</select>' +
            '</div>' +
            '<div class="sc-links">' +
            '<a class="link-btn link-customer" href="/customer?store=' + s.id + '" target="_blank">👤 客画面</a>' +
            '<a class="link-btn link-staff" href="/staff?store=' + s.id + '" target="_blank">🧑‍💼 店員画面</a>' +
            '<a class="link-btn link-backyard" href="/backyard?store=' + s.id + '" target="_blank">🍳 バックヤード</a>' +
            '<button class="link-btn link-copy" onclick="copyUrls(\'' + s.id + '\')">📋 URLコピー</button>' +
            '</div>' +
            '</div>';
    }).join('');
}

// セレクトを更新するが、現在の選択値を保持する
function updateSelects() {
    // 在庫リセット用セレクト
    const resetSel = document.getElementById('reset-store-sel');
    if (resetSel) {
        const cur = resetSel.value;
        resetSel.innerHTML = '<option value="">全出店</option>';
        storeList.forEach(s => {
            const o = document.createElement('option');
            o.value = s.id; o.textContent = s.name;
            resetSel.appendChild(o);
        });
        if (cur) resetSel.value = cur;
    }
    const opts = storeList.map(s => `<option value="${s.id}">${s.name} (${s.id})</option>`).join('');
    ['product-store-select', 'sales-store-select', 'logo-store-select', 'paypay-store-select'].forEach(id => {
        const el = document.getElementById(id);
        const current = el.value; // 現在の選択値を保存
        el.innerHTML = '<option value="">出店を選択...</option>' + opts;
        if (current) el.value = current; // 選択値を復元
    });
}

function copyUrls(storeId) {
    const text = '【客画面】 http://' + location.host + '/customer?store=' + storeId + '\n【店員画面】 http://' + location.host + '/staff?store=' + storeId + '\n【バックヤード】 http://' + location.host + '/backyard?store=' + storeId;
    navigator.clipboard.writeText(text).then(() => toast('📋 URLをコピーしました'));
}

function startRename(storeId) {
    const el = document.getElementById('sname-' + storeId);
    if (!el) return;
    const current = el.textContent;
    const input = document.createElement('input');
    input.value = current;
    input.style.cssText = 'font-size:0.95rem;font-weight:700;border:2px solid var(--primary);border-radius:6px;padding:2px 8px;font-family:inherit;width:140px;';
    input.onblur = () => {
        const newName = input.value.trim();
        if (newName && newName !== current) {
            ws.send(JSON.stringify({ type: 'RENAME_STORE', storeId, newName }));
            toast('✅ 出店名を変更しました');
        }
        el.textContent = newName || current;
        input.replaceWith(el);
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = current; input.blur(); } };
    el.replaceWith(input);
    input.focus(); input.select();
}

function deleteStore(storeId, storeName) {
    if (!confirm('「' + storeName + '」を削除しますか？\n売上・商品データもすべて消えます。')) return;
    ws.send(JSON.stringify({ type: 'DELETE_STORE', storeId }));
    toast('🗑️ 出店を削除しました');
}

function updateTheme(storeId, theme) {
    ws.send(JSON.stringify({ type: 'UPDATE_THEME', storeId, theme }));
    toast('🎨 テーマを変更しました');
}

// ── ロゴ管理 ──────────────────────────────────────────────────
function loadLogoEditor() {
    logoStoreId = document.getElementById('logo-store-select').value;
    if (!logoStoreId) { alert('出店を選択してください'); return; }
    // storeStateを取得してロゴを表示
    const p = waitForStoreState();
    ws.send(JSON.stringify({ type: 'REGISTER', role: 'admin_product', storeId: logoStoreId, password: adminPassword }));
    p.then(store => {
        const logoUrl = store.logo;
        const previewHtml = logoUrl
            ? `<img class="logo-preview" id="logo-preview-wrap" src="${logoUrl}?${Date.now()}">`
            : `<div class="logo-preview-placeholder" id="logo-preview-wrap">🏪</div>`;
        document.getElementById('logo-editor').innerHTML = `
      <div class="logo-upload-area">
        ${previewHtml}
        <div>
          <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:12px;">推奨: 正方形の画像（PNG/JPG/WebP）</p>
          <input type="file" id="logo-file-input" accept="image/*" onchange="uploadLogo(this)">
          <button class="btn btn-primary btn-sm" onclick="document.getElementById('logo-file-input').click()">📁 ロゴ画像を選択</button>
          <button class="btn btn-ghost btn-sm" onclick="removeLogo()" style="margin-left:6px;">削除</button>
        </div>
      </div>`;
    });
}

function updateLogoPreview(logoUrl) {
    const wrap = document.getElementById('logo-preview-wrap');
    if (!wrap) return;
    if (logoUrl) {
        const img = document.createElement('img');
        img.className = 'logo-preview'; img.id = 'logo-preview-wrap';
        img.src = logoUrl + '?' + Date.now();
        wrap.replaceWith(img);
    } else {
        const div = document.createElement('div');
        div.className = 'logo-preview-placeholder'; div.id = 'logo-preview-wrap';
        div.textContent = '🏪'; wrap.replaceWith(div);
    }
}

async function uploadLogo(input) {
    if (!input.files[0] || !logoStoreId) return;
    const fd = new FormData();
    fd.append('storeId', logoStoreId); fd.append('field', 'logo'); fd.append('file', input.files[0]);
    try {
        const res = await fetch('/api/upload', { method: 'POST', body: fd });
        const data = await res.json();
        if (data.url) { updateLogoPreview(data.url); toast('✅ ロゴを更新しました'); }
        else toast('❌ アップロード失敗');
    } catch (e) { toast('❌ エラー: ' + e.message); }
}

function removeLogo() {
    if (!logoStoreId) return;
    ws.send(JSON.stringify({ type: 'UPDATE_LOGO', storeId: logoStoreId, logo: null }));
    updateLogoPreview(null); toast('🗑️ ロゴを削除しました');
}

// ── 商品管理 ──────────────────────────────────────────────────
async function loadProductEditor() {
    const storeId = document.getElementById('product-store-select').value;
    if (!storeId) { alert('出店を選択してください'); return; }
    currentProductStoreId = storeId;

    const p = waitForStoreState();
    ws.send(JSON.stringify({ type: 'REGISTER', role: 'admin_product', storeId, password: adminPassword }));
    const store = await p;
    editingProducts = store.products.map(p => ({ ...p }));
    renderProductEditor();
}

let editingDay = 1; // 商品エディタで編集中の日

function renderProductEditor() {
    if (!currentProductStoreId) return;
    const d1 = editingDay === 1;
    document.getElementById('product-editor').innerHTML =
        '<div style="display:flex;gap:8px;margin-bottom:14px;">' +
        '<button class="btn btn-sm ' + (d1 ? 'btn-primary' : 'btn-ghost') + '" onclick="switchEditDay(1)">📅 1日目</button>' +
        '<button class="btn btn-sm ' + (!d1 ? 'btn-danger' : 'btn-ghost') + '" onclick="switchEditDay(2)">📅 2日目</button>' +
        '<span style="font-size:0.78rem;color:var(--text-muted);align-self:center;margin-left:6px;">表示チェックを外すとその日は非表示になります</span>' +
        '</div>' +
        '<table class="product-editor-table">' +
        '<thead><tr><th>画像</th><th>商品名</th><th>価格(¥)</th><th>在庫数</th><th>表示</th><th></th></tr></thead>' +
        '<tbody id="product-tbody"></tbody>' +
        '</table>';
    renderProductRows();
}

function switchEditDay(day) {
    editingDay = day;
    renderProductEditor();
}

function renderProductRows() {
    const tbody = document.getElementById('product-tbody');
    if (!tbody || !currentProductStoreId) return;
    const d = editingDay;
    tbody.innerHTML = editingProducts.map(function (p, i) {
        const imgHtml = p.image
            ? '<img class="product-thumb" src="' + p.image + '?' + Date.now() + '">'
            : '<div class="product-thumb-placeholder">📦</div>';
        const stock = d === 1 ? (p.stock1 !== undefined ? p.stock1 : 0) : (p.stock2 !== undefined ? p.stock2 : 0);
        const active = d === 1 ? (p.active1 !== false) : (p.active2 !== false);
        const stockField = d === 1 ? 'stock1' : 'stock2';
        const activeField = d === 1 ? 'active1' : 'active2';
        return '<tr style="' + (!active ? 'opacity:0.5;' : '') + '">' +
            '<td><div class="img-upload-cell">' +
            imgHtml +
            '<input type="file" id="pimg-' + p.id + '" accept="image/*" onchange="uploadProductImage(this,' + p.id + ')">' +
            '<button class="img-upload-btn" onclick="document.getElementById(\'pimg-' + p.id + '\').click()">画像変更</button>' +
            '</div></td>' +
            '<td><input type="text" value="' + escHtml(p.name) + '" oninput="editingProducts[' + i + '].name=this.value"></td>' +
            '<td><input type="number" value="' + p.price + '" min="0" oninput="editingProducts[' + i + '].price=+this.value" style="width:80px"></td>' +
            '<td><input type="number" value="' + stock + '" min="0" oninput="editingProducts[' + i + '].' + stockField + '=+this.value" style="width:70px"></td>' +
            '<td style="text-align:center;"><input type="checkbox" ' + (active ? 'checked' : '') + ' onchange="editingProducts[' + i + '].' + activeField + '=this.checked;renderProductRows()" style="width:18px;height:18px;cursor:pointer;"></td>' +
            '<td><button class="btn btn-danger btn-sm" onclick="removeProduct(' + i + ')">削除</button></td>' +
            '</tr>';
    }).join('');
}

function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

function removeProduct(idx) { editingProducts.splice(idx, 1); renderProductRows(); }

function addProduct() {
    if (!currentProductStoreId) { alert('まず出店を選択・読み込みしてください'); return; }
    const maxId = editingProducts.reduce((m, p) => Math.max(m, p.id), 0);
    editingProducts.push({ id: maxId + 1, name: '新商品', price: 100, stock1: 50, stock2: 50, active1: true, active2: true, image: null });
    renderProductRows();
}

function saveProducts() {
    if (!currentProductStoreId) { alert('出店を選択・読み込みしてください'); return; }
    ws.send(JSON.stringify({ type: 'UPDATE_PRODUCTS', storeId: currentProductStoreId, products: editingProducts }));
    toast('✅ 商品を保存しました');
}

async function uploadProductImage(input, productId) {
    if (!input.files[0] || !currentProductStoreId) return;
    const fd = new FormData();
    fd.append('storeId', currentProductStoreId); fd.append('field', 'product');
    fd.append('productId', productId); fd.append('file', input.files[0]);
    try {
        const res = await fetch('/api/upload', { method: 'POST', body: fd });
        const data = await res.json();
        if (data.url) {
            const p = editingProducts.find(p => p.id === productId);
            if (p) p.image = data.url;
            renderProductRows(); toast('✅ 商品画像を更新しました');
        } else toast('❌ アップロード失敗');
    } catch (e) { toast('❌ エラー: ' + e.message); }
}

// ── PayPay URL設定 ─────────────────────────────────────────────
function savePaypayUrl() {
    const storeId = document.getElementById('paypay-store-select').value;
    const url = document.getElementById('paypay-url').value.trim();
    if (!storeId) { alert('出店を選択してください'); return; }
    ws.send(JSON.stringify({ type: 'UPDATE_PAYPAY_URL', storeId, paypayUrl: url }));
    toast('✅ PayPay URLを保存しました');
}

// ── 売上 ──────────────────────────────────────────────────────
let viewingSalesDay = 1;
function setSalesDay(day) {
    viewingSalesDay = day;
    document.getElementById('sales-day1-btn').style.fontWeight = day === 1 ? '900' : '';
    document.getElementById('sales-day2-btn').style.fontWeight = day === 2 ? '900' : '';
    loadSales();
}

function loadSales() {
    const storeId = document.getElementById('sales-store-select').value;
    if (!storeId) { alert('出店を選択してください'); return; }
    ws.send(JSON.stringify({ type: 'GET_SALES', storeId, day: viewingSalesDay }));
}

function renderSales(sales, totalRevenue, day) {
    const panel = document.getElementById('sales-panel');
    const cashRev = sales.filter(s => s.method === 'cash').reduce((s, x) => s + x.total, 0);
    const dayLabel = (day || viewingSalesDay) === 2 ? '2日目' : '1日目';
    panel.innerHTML =
        '<div style="margin-bottom:12px;display:flex;align-items:center;gap:8px;">' +
        '<span class="day-badge ' + ((day || viewingSalesDay) === 2 ? 'day2' : 'day1') + '">' + dayLabel + '</span>' +
        '<span style="font-size:0.78rem;color:var(--text-muted);">の売上データ</span>' +
        '</div>' +
        `<div class="summary-grid">
      <div class="summary-card"><span class="s-label">売上合計</span><div class="s-value">¥${totalRevenue.toLocaleString()}</div></div>
      <div class="summary-card"><span class="s-label">件数</span><div class="s-value">${sales.length}件</div></div>
      <div class="summary-card"><span class="s-label">現金</span><div class="s-value">¥${cashRev.toLocaleString()}</div></div>
      <div class="summary-card"><span class="s-label">PayPay</span><div class="s-value">¥${(totalRevenue - cashRev).toLocaleString()}</div></div>
    </div>
    ${sales.length === 0 ? '<div class="empty-state">まだ売上がありません</div>' : `
    <table class="sales-table">
      <thead><tr><th>時刻</th><th>方法</th><th>商品</th><th>合計</th></tr></thead>
      <tbody>${[...sales].reverse().map(s => `
        <tr>
          <td>${new Date(s.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</td>
          <td><span class="method-tag method-${s.method}">${s.method === 'paypay' ? 'PayPay' : '現金'}</span></td>
          <td>${s.items.map(i => escHtml(i.name) + '×' + i.qty).join(', ')}</td>
          <td><strong>¥${s.total.toLocaleString()}</strong></td>
        </tr>`).join('')}
      </tbody>
    </table>`}`;
}

function resetSales() {
    const storeId = document.getElementById('sales-store-select').value;
    if (!storeId) { alert('出店を選択してください'); return; }
    if (!confirm(storeId + ' の売上をリセットしますか？')) return;
    ws.send(JSON.stringify({ type: 'RESET_SALES', storeId }));
    toast('🗑️ 売上をリセットしました');
    setTimeout(loadSales, 400);
}

function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg; el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2500);
}

connect();