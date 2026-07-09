const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
let ws, allSales = [], filteredSales = [], currentDay = 1;
let adminPassword = sessionStorage.getItem('admin_pw') || '';

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    if (adminPassword) {
      ws.send(JSON.stringify({ type:'REGISTER', role:'admin', storeId:null, password: adminPassword }));
    } else {
      showLogin(false);
    }
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'AUTH_FAILED') { showLogin(true); return; }
    if (msg.type === 'REGISTERED') {
      hideLogin();
      loadSales();
    }
    if (msg.type === 'ALL_SALES_DATA') {
      allSales = msg.sales || [];
      currentDay = msg.currentDay;
      updateDayBtns();
      buildStoreFilter(msg.storeList || []);
      applyFilter();
    }
  };
  ws.onclose = () => setTimeout(connect, 2000);
}

function showLogin(isError) {
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-gate').style.display = 'flex';
  document.getElementById('login-error').style.display = isError ? 'block' : 'none';
  if (isError) { sessionStorage.removeItem('admin_pw'); adminPassword = ''; document.getElementById('login-pw-input').value = ''; }
}
function hideLogin() {
  document.getElementById('login-gate').style.display = 'none';
  document.getElementById('app').style.display = '';
}
function submitLogin() {
  const pw = document.getElementById('login-pw-input').value;
  if (!pw) return;
  adminPassword = pw;
  sessionStorage.setItem('admin_pw', pw);
  ws.send(JSON.stringify({ type:'REGISTER', role:'admin', storeId:null, password: adminPassword }));
}

function loadSales() {
  ws.send(JSON.stringify({ type:'GET_ALL_SALES', day: currentDay }));
}

function setDay(day) {
  currentDay = day;
  updateDayBtns();
  ws.send(JSON.stringify({ type:'GET_ALL_SALES', day }));
}

function updateDayBtns() {
  document.getElementById('btn-day1').className = 'day-btn' + (currentDay === 1 ? ' active day1' : '');
  document.getElementById('btn-day2').className = 'day-btn' + (currentDay === 2 ? ' active day2' : '');
}

function buildStoreFilter(storeList) {
  const sel = document.getElementById('store-filter');
  const cur = sel.value;
  sel.innerHTML = '<option value="">全出店</option>';
  storeList.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    sel.appendChild(opt);
  });
  if (cur) sel.value = cur;
}

function applyFilter() {
  const storeId = document.getElementById('store-filter').value;
  const method = document.getElementById('method-filter').value;
  filteredSales = allSales.filter(s => {
    if (storeId && s.storeId !== storeId) return false;
    if (method && s.method !== method) return false;
    return true;
  });
  renderSummary();
  renderTable();
}

function renderSummary() {
  const total = filteredSales.reduce((s, r) => s + r.total, 0);
  const cash = filteredSales.filter(r => r.method === 'cash').reduce((s, r) => s + r.total, 0);
  const paypay = filteredSales.filter(r => r.method === 'paypay').reduce((s, r) => s + r.total, 0);
  document.getElementById('summary-bar').innerHTML =
    sumCard('取引件数', filteredSales.length + '件', '') +
    sumCard('売上合計', '¥' + total.toLocaleString(), 'green') +
    sumCard('現金', '¥' + cash.toLocaleString(), '') +
    sumCard('PayPay', '¥' + paypay.toLocaleString(), '');
}
function sumCard(label, value, cls) {
  return '<div class="sum-card"><div class="sum-label">' + label + '</div><div class="sum-value ' + cls + '">' + value + '</div></div>';
}

function renderTable() {
  const tbody = document.getElementById('log-tbody');
  if (!filteredSales.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">売上データがありません</td></tr>';
    return;
  }
  tbody.innerHTML = filteredSales.map((s, i) => {
    const dt = new Date(s.time);
    // UTC→JST
    const jst = new Date(dt.getTime() + 9 * 3600 * 1000);
    const timeStr = jst.toISOString().slice(11, 16);
    const methodClass = s.method === 'paypay' ? 'method-paypay' : 'method-cash';
    const methodLabel = s.method === 'paypay' ? 'PayPay' : '現金';
    const items = (s.items || []).map(item =>
      '<div class="item-row">' + esc(item.name) + '<span class="item-qty">× ' + item.qty + ' ¥' + (item.price * item.qty).toLocaleString() + '</span></div>'
    ).join('');
    return '<tr>' +
      '<td class="col-no">' + (i + 1) + '</td>' +
      '<td class="col-time">' + timeStr + '</td>' +
      '<td class="col-store">' + esc(s.storeName) + '</td>' +
      '<td class="col-items"><div class="item-list">' + items + '</div></td>' +
      '<td class="col-method"><span class="method-badge ' + methodClass + '">' + methodLabel + '</span></td>' +
      '<td class="col-total">¥' + s.total.toLocaleString() + '</td>' +
    '</tr>';
  }).join('');
}

function exportCSV() {
  if (!filteredSales.length) { alert('データがありません'); return; }
  const rows = [['No', '日時(JST)', '出店ID', '出店名', '商品', '個数', '単価', '小計', '支払方法', '合計']];
  filteredSales.forEach((s, i) => {
    const dt = new Date(s.time);
    const jst = new Date(dt.getTime() + 9 * 3600 * 1000);
    const dateStr = jst.toISOString().slice(0, 16).replace('T', ' ');
    (s.items || []).forEach((item, j) => {
      rows.push([
        j === 0 ? i + 1 : '',
        j === 0 ? dateStr : '',
        j === 0 ? s.storeId : '',
        j === 0 ? s.storeName : '',
        item.name,
        item.qty,
        item.price,
        item.price * item.qty,
        j === 0 ? (s.method === 'paypay' ? 'PayPay' : '現金') : '',
        j === 0 ? s.total : '',
      ]);
    });
  });
  const csv = '\uFEFF' + rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const dayLabel = currentDay === 1 ? '1日目' : '2日目';
  a.download = '売上ログ_' + dayLabel + '_' + new Date().toISOString().slice(0,10) + '.csv';
  a.click();
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

connect();