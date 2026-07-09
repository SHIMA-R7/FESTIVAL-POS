const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const url = require('url');

const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'data', 'stores.json');
const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
const QR_DIR = path.join(__dirname, 'data', 'qr');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const MASTER_FILE = path.join(__dirname, 'data', 'stores_master.json');

// config.json から管理画面パスワードを読み込み（なければデフォルト作成）
let CONFIG = { adminPassword: 'festival2026' };
try {
  if (fs.existsSync(CONFIG_FILE)) {
    CONFIG = Object.assign(CONFIG, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG, null, 2), 'utf8');
    console.log('⚙️  config.json を作成しました（初期パスワード: ' + CONFIG.adminPassword + '）');
  }
} catch (e) {
  console.error('config.json 読み込みエラー:', e.message);
}
const ADMIN_PASSWORD = CONFIG.adminPassword;

if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'));
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(QR_DIR)) fs.mkdirSync(QR_DIR);

let stores = {};
let currentDay = 1; // 1 or 2

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      currentDay = raw.__currentDay || 1;
      delete raw.__currentDay;
      stores = raw;
      for (const id of Object.keys(stores)) {
        stores[id].pendingPayment = null;
        // 旧形式(stock)→新形式(stock1/stock2)の移行
        stores[id].products = (stores[id].products || []).map(p => ({
          ...p,
          stock1: p.stock1 !== undefined ? p.stock1 : (p.stock || 0),
          stock2: p.stock2 !== undefined ? p.stock2 : (p.stock || 0),
          active1: p.active1 !== undefined ? p.active1 : true,
          active2: p.active2 !== undefined ? p.active2 : true,
          overStock: p.overStock || false,
          overCount1: p.overCount1 || 0,
          overCount2: p.overCount2 || 0,
          sold1: p.sold1 || 0,
          sold2: p.sold2 || 0,
        }));
        // 旧形式sales→sales1の移行
        if (stores[id].sales && !stores[id].sales1) {
          stores[id].sales1 = stores[id].sales || [];
          stores[id].totalRevenue1 = stores[id].totalRevenue || 0;
        }
        if (!stores[id].sales2) { stores[id].sales2 = []; stores[id].totalRevenue2 = 0; }
        delete stores[id].sales; delete stores[id].totalRevenue;
      }
      console.log('💾 データ復元: ' + Object.keys(stores).length + '件の出店, ' + currentDay + '日目');
    }
  } catch (e) { console.error('データ読み込みエラー:', e.message); stores = {}; }
}

function saveData() {
  try {
    const data = Object.assign({ __currentDay: currentDay }, stores);
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  }
  catch (e) { console.error('データ保存エラー:', e.message); }
}

function saveAndBroadcast(storeId) { saveData(); broadcastStoreState(storeId); }

loadData();

let clients = new Map();

function defaultStore(name) {
  return {
    name, logo: null,
    products: [
      { id: 1, name: '商品A', price: 200, stock1: 50, stock2: 50, active1: true, active2: true, image: null },
      { id: 2, name: '商品B', price: 300, stock1: 30, stock2: 30, active1: true, active2: true, image: null },
      { id: 3, name: '商品C', price: 150, stock1: 100, stock2: 100, active1: true, active2: true, image: null },
      { id: 4, name: '商品D', price: 500, stock1: 20, stock2: 20, active1: true, active2: true, image: null },
    ],
    sales1: [], sales2: [], totalRevenue1: 0, totalRevenue2: 0, pendingPayment: null,
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.json': 'application/json',
};

function parseMultipart(buffer, boundary) {
  const results = [];
  const boundaryBuf = Buffer.from('--' + boundary);
  const parts = [];
  let start = 0;
  while (true) {
    const idx = buffer.indexOf(boundaryBuf, start);
    if (idx === -1) break;
    if (start > 0) parts.push(buffer.slice(start, idx - 2));
    start = idx + boundaryBuf.length + 2;
    if (buffer.slice(idx + boundaryBuf.length, idx + boundaryBuf.length + 2).toString() === '--') break;
  }
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headerStr = part.slice(0, headerEnd).toString();
    const body = part.slice(headerEnd + 4);
    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const ctMatch = headerStr.match(/Content-Type:\s*(\S+)/i);
    results.push({
      name: nameMatch ? nameMatch[1] : null,
      filename: filenameMatch ? filenameMatch[1] : null,
      contentType: ctMatch ? ctMatch[1] : 'text/plain',
      data: body,
    });
  }
  return results;
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'POST' && pathname === '/api/upload') {
    const ct = req.headers['content-type'] || '';
    const boundaryMatch = ct.match(/boundary=(.+)/);
    if (!boundaryMatch) { res.writeHead(400); res.end('No boundary'); return; }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const parts = parseMultipart(buffer, boundaryMatch[1]);
      let storeId = null, field = null, productId = null, fileData = null, fileExt = '';
      for (const part of parts) {
        if (part.name === 'storeId') storeId = part.data.toString().trim();
        else if (part.name === 'field') field = part.data.toString().trim();
        else if (part.name === 'productId') productId = parseInt(part.data.toString().trim());
        else if (part.name === 'file' && part.filename) {
          fileData = part.data;
          fileExt = path.extname(part.filename).toLowerCase() || '.jpg';
        }
      }
      if (!storeId || !stores[storeId] || !fileData) { res.writeHead(400); res.end('Invalid'); return; }
      const fname = storeId + '_' + field + (field === 'product' ? '_' + productId : '') + '_' + Date.now() + fileExt;
      fs.writeFileSync(path.join(UPLOADS_DIR, fname), fileData);
      const imageUrl = '/data/uploads/' + fname;
      if (field === 'logo') {
        stores[storeId].logo = imageUrl;
      } else if (field === 'product' && productId != null) {
        const p = stores[storeId].products.find(p => p.id === productId);
        if (p) p.image = imageUrl;
      }
      saveData(); broadcastStoreState(storeId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: imageUrl }));
    });
    return;
  }

  let filePath;
  if (pathname === '/' || pathname === '/admin') filePath = path.join(__dirname, 'public', 'admin.html');
  else if (pathname === '/admin/log') filePath = path.join(__dirname, 'public', 'admin_log.html');
  else if (pathname === '/staff') filePath = path.join(__dirname, 'public', 'staff.html');
  else if (pathname === '/customer') filePath = path.join(__dirname, 'public', 'customer.html');
  else if (pathname === '/backyard') filePath = path.join(__dirname, 'public', 'backyard.html');
  else if (pathname.startsWith('/data/uploads/')) filePath = path.join(UPLOADS_DIR, path.basename(pathname));
  else if (pathname.startsWith('/data/qr/')) filePath = path.join(__dirname, 'data', 'qr', path.basename(pathname));
  else filePath = path.join(__dirname, 'public', pathname);

  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (ext === '.html') {
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
      headers['Pragma'] = 'no-cache';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

function storePayload(storeId) {
  const store = stores[storeId];
  if (!store) return null;
  const day = currentDay;
  // 現在の日に応じた商品リスト（activeフラグでフィルタ、stockを現在日のものに）
  const products = store.products
    .filter(p => day === 1 ? p.active1 !== false : p.active2 !== false)
    .map(p => ({
      id: p.id, name: p.name, price: p.price, image: p.image,
      stock: day === 1 ? (p.stock1 || 0) : (p.stock2 || 0),
      stock1: p.stock1, stock2: p.stock2, active1: p.active1, active2: p.active2,
      overStock: p.overStock || false,
      overCount: day === 1 ? (p.overCount1 || 0) : (p.overCount2 || 0),
      sold: day === 1 ? (p.sold1 || 0) : (p.sold2 || 0),
    }));
  const sales = day === 1 ? (store.sales1 || []) : (store.sales2 || []);
  const revenue = day === 1 ? (store.totalRevenue1 || 0) : (store.totalRevenue2 || 0);
  return {
    type: 'STORE_STATE', store: {
      name: store.name, logo: store.logo, products,
      totalRevenue: revenue, salesCount: sales.length, sales,
      pendingPayment: store.pendingPayment, paypayUrl: store.paypayUrl || null, theme: store.theme || "orange",
      numberMode: store.numberMode || false, currentDay: day,
      countUpMode: store.countUpMode || false,
    }
  };
}

function broadcastStoreState(storeId) {
  const payload = storePayload(storeId);
  if (!payload) return;
  const msg = JSON.stringify(payload);
  console.log(msg);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      const c = clients.get(ws);
      if (c && c.storeId === storeId) ws.send(msg);
    }
  });
}

function broadcastDayState() {
  broadcastAll({ type: 'DAY_STATE', currentDay });
  // 全出店の状態を再送
  Object.keys(stores).forEach(id => broadcastStoreState(id));
}

function broadcastAll(message) {
  const msg = JSON.stringify(message);
  wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

wss.on('connection', (ws) => {
  clients.set(ws, { type: null, storeId: null });
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { type, storeId } = msg;
    switch (type) {
      case 'REGISTER': {
        const role = msg.role;
        if (!stores[storeId] && role !== 'admin' && role !== 'admin_product' && role !== 'backyard') {
          ws.send(JSON.stringify({ type: 'ERROR', message: '出店が存在しません' })); return;
        }
        // 管理画面ロールはパスワード認証が必要
        if ((role === 'admin' || role === 'admin_product') && msg.password !== ADMIN_PASSWORD) {
          ws.send(JSON.stringify({ type: 'AUTH_FAILED', message: 'パスワードが違います' })); return;
        }
        clients.set(ws, { type: role, storeId: storeId || null });
        ws.send(JSON.stringify({ type: 'REGISTERED', role, storeId, currentDay }));
        if (storeId && stores[storeId]) ws.send(JSON.stringify(storePayload(storeId)));
        if (role === 'admin' || role === 'admin_product')
          ws.send(JSON.stringify({ type: 'STORE_LIST', stores: Object.keys(stores).map(id => ({ id, name: stores[id].name, theme: stores[id].theme || 'orange' })) }));
        break;
      }
      case 'CREATE_STORE': {
        if (stores[msg.newStoreId]) { ws.send(JSON.stringify({ type: 'ERROR', message: 'すでに存在するIDです' })); return; }
        stores[msg.newStoreId] = defaultStore(msg.storeName);
        saveData();
        ws.send(JSON.stringify({ type: 'STORE_CREATED', storeId: msg.newStoreId }));
        broadcastAll({ type: 'STORE_LIST', stores: Object.keys(stores).map(id => ({ id, name: stores[id].name, theme: stores[id].theme || 'orange' })) });
        break;
      }
      case 'UPDATE_PRODUCTS': {
        if (!stores[storeId]) return;
        // 既存商品にstock1/stock2がない場合は移行
        stores[storeId].products = msg.products.map(p => ({
          id: p.id, name: p.name, price: p.price, image: p.image || null,
          stock1: p.stock1 !== undefined ? p.stock1 : (p.stock || 0),
          stock2: p.stock2 !== undefined ? p.stock2 : (p.stock || 0),
          active1: p.active1 !== undefined ? p.active1 : true,
          active2: p.active2 !== undefined ? p.active2 : true,
          overStock: p.overStock || false,
          overCount1: p.overCount1 || 0,
          overCount2: p.overCount2 || 0,
          sold1: p.sold1 || 0,
          sold2: p.sold2 || 0,
        }));
        saveAndBroadcast(storeId); break;
      }
      case 'UPDATE_PAYPAY_URL': {
        if (!stores[storeId]) return;
        stores[storeId].paypayUrl = msg.paypayUrl || null;
        saveAndBroadcast(storeId); break;
      }
      case 'UPDATE_LOGO': {
        if (!stores[storeId]) return;
        stores[storeId].logo = msg.logo || null;
        saveAndBroadcast(storeId); break;
      }
      case 'SELECT_PAYMENT': {
        const store = stores[storeId]; if (!store) return;
        const items = msg.items;
        const total = items.reduce((s, i) => s + i.price * i.qty, 0);
        for (const item of items) {
          const p = store.products.find(p => p.id === item.id);
          const stock = p ? (currentDay === 1 ? (p.stock1 || 0) : (p.stock2 || 0)) : 0;
          const isOver = p && p.overStock;
          const isCU = stores[storeId] && stores[storeId].countUpMode;
          if (!p || (!isOver && !isCU && stock < item.qty)) { ws.send(JSON.stringify({ type: 'ERROR', message: item.name + 'の在庫が不足しています' })); return; }
        }
        store.pendingPayment = { items, total, method: msg.method };
        saveAndBroadcast(storeId); break;
      }
      case 'CONFIRM_PAYMENT': {
        const store = stores[storeId]; if (!store || !store.pendingPayment) return;
        const { items, total, method } = store.pendingPayment;
        for (const item of items) {
          const p = store.products.find(p => p.id === item.id);
          if (p) {
            const store2 = stores[storeId];
            if (store2 && store2.countUpMode) {
              // カウントアップモード: sold数をインクリメント（stock減算なし）
              if (currentDay === 1) p.sold1 = (p.sold1 || 0) + item.qty;
              else p.sold2 = (p.sold2 || 0) + item.qty;
            } else if (p.overStock) {
              if (currentDay === 1) p.overCount1 = (p.overCount1 || 0) + item.qty;
              else p.overCount2 = (p.overCount2 || 0) + item.qty;
            } else {
              if (currentDay === 1) p.stock1 = Math.max(0, (p.stock1 || 0) - item.qty);
              else p.stock2 = Math.max(0, (p.stock2 || 0) - item.qty);
            }
          }
        }
        if (currentDay === 1) {
          if (!store.sales1) store.sales1 = [];
          store.sales1.push({ items, total, method, time: new Date().toISOString(), delivered: false });
          store.totalRevenue1 = (store.totalRevenue1 || 0) + total;
        } else {
          if (!store.sales2) store.sales2 = [];
          store.sales2.push({ items, total, method, time: new Date().toISOString(), delivered: false });
          store.totalRevenue2 = (store.totalRevenue2 || 0) + total;
        }
        store.pendingPayment = null;
        saveAndBroadcast(storeId); break;
      }
      case 'CANCEL_PAYMENT': {
        const store = stores[storeId]; if (!store) return;
        store.pendingPayment = null; saveAndBroadcast(storeId); break;
      }
      case 'RESET_SALES': {
        const store = stores[storeId]; if (!store) return;
        if (currentDay === 1) { store.sales1 = []; store.totalRevenue1 = 0; }
        else { store.sales2 = []; store.totalRevenue2 = 0; }
        store.pendingPayment = null;
        saveAndBroadcast(storeId); break;
      }
      case 'GET_ALL_SALES': {
        // 全出店の売上ログを一括返却（ログページ用）
        const reqDay = (msg.day === 1 || msg.day === 2) ? msg.day : currentDay;
        const allSales = [];
        for (const [sid, store] of Object.entries(stores)) {
          const sales = reqDay === 1 ? (store.sales1 || []) : (store.sales2 || []);
          sales.forEach((sale, idx) => {
            allSales.push({
              storeId: sid,
              storeName: store.name,
              saleIndex: idx,
              ...sale,
            });
          });
        }
        // 時刻順にソート
        allSales.sort((a, b) => new Date(a.time) - new Date(b.time));
        ws.send(JSON.stringify({ type: 'ALL_SALES_DATA', sales: allSales, currentDay: reqDay, storeList: Object.keys(stores).map(id => ({ id, name: stores[id].name })) }));
        break;
      }
      case 'GET_SALES': {
        const store = stores[storeId]; if (!store) return;
        // adminから日指定がある場合はその日を、なければcurrentDayを使う
        const reqDay = (msg.day === 1 || msg.day === 2) ? msg.day : currentDay;
        const sales = reqDay === 1 ? (store.sales1 || []) : (store.sales2 || []);
        const revenue = reqDay === 1 ? (store.totalRevenue1 || 0) : (store.totalRevenue2 || 0);
        ws.send(JSON.stringify({ type: 'SALES_DATA', sales, totalRevenue: revenue, currentDay: reqDay })); break;
      }
      case 'REVERT_SALE': {
        const store = stores[storeId]; if (!store) return;
        const idx = msg.saleIndex;
        const sales = currentDay === 1 ? store.sales1 : store.sales2;
        if (!sales || idx < 0 || idx >= sales.length) return;
        const sale = sales[idx];
        for (const item of sale.items) {
          const p = store.products.find(p => p.id === item.id);
          if (p) {
            if (p.overStock) {
              if (currentDay === 1) p.overCount1 = Math.max(0, (p.overCount1 || 0) - item.qty);
              else p.overCount2 = Math.max(0, (p.overCount2 || 0) - item.qty);
            } else {
              if (currentDay === 1) p.stock1 = (p.stock1 || 0) + item.qty;
              else p.stock2 = (p.stock2 || 0) + item.qty;
            }
          }
        }
        if (currentDay === 1) { store.totalRevenue1 = (store.totalRevenue1 || 0) - sale.total; store.sales1.splice(idx, 1); }
        else { store.totalRevenue2 = (store.totalRevenue2 || 0) - sale.total; store.sales2.splice(idx, 1); }
        saveAndBroadcast(storeId); break;
      }
      case 'RENAME_STORE': {
        if (!stores[storeId]) return;
        stores[storeId].name = msg.newName;
        saveData();
        broadcastAll({ type: 'STORE_LIST', stores: Object.keys(stores).map(id => ({ id, name: stores[id].name, theme: stores[id].theme || 'orange' })) });
        broadcastStoreState(storeId); break;
      }
      case 'DELETE_STORE': {
        if (!stores[storeId]) return;
        delete stores[storeId];
        saveData();
        broadcastAll({ type: 'STORE_LIST', stores: Object.keys(stores).map(id => ({ id, name: stores[id].name, theme: stores[id].theme || 'orange' })) });
        // 接続中のクライアントに削除を通知
        wss.clients.forEach(c => {
          if (c.readyState === WebSocket.OPEN) {
            const ci = clients.get(c);
            if (ci && ci.storeId === storeId) c.send(JSON.stringify({ type: 'STORE_DELETED' }));
          }
        }); break;
      }
      case 'RESET_STOCK': {
        const reqDay = msg.day; // 1, 2, or 'both'
        const targetId = msg.storeId;
        const targets = targetId ? [targetId] : Object.keys(stores);
        // masterから初期在庫を読み込む
        let master = {};
        try { master = JSON.parse(require('fs').readFileSync(MASTER_FILE, 'utf8')); } catch (e) { console.error('master読込失敗:', e.message); }
        for (const sid of targets) {
          const store = stores[sid];
          if (!store) continue;
          const masterProds = {};
          if (master[sid]) master[sid].products.forEach(p => masterProds[p.id] = p);
          store.products = store.products.map(p => {
            const mp = masterProds[p.id];
            const np = { ...p };
            if (reqDay === 1 || reqDay === 'both') {
              np.stock1 = mp ? mp.stock1 : p.stock1;
              np.active1 = mp ? mp.active1 : p.active1;
              np.overCount1 = 0;
            }
            if (reqDay === 2 || reqDay === 'both') {
              np.stock2 = mp ? mp.stock2 : p.stock2;
              np.active2 = mp ? mp.active2 : p.active2;
              np.overCount2 = 0;
            }
            np.overStock = false;
            return np;
          });
          if (reqDay === 1 || reqDay === 'both') { store.sales1 = []; store.totalRevenue1 = 0; }
          if (reqDay === 2 || reqDay === 'both') { store.sales2 = []; store.totalRevenue2 = 0; }
          store.pendingPayment = null;
          broadcastStoreState(sid);
        }
        saveData();
        ws.send(JSON.stringify({ type: 'RESET_STOCK_DONE', day: reqDay, storeId: targetId }));
        break;
      }
      case 'TOGGLE_OVER_STOCK': {
        const store = stores[storeId]; if (!store) return;
        const pid = msg.productId;
        const p = store.products.find(p => p.id === pid);
        if (!p) return;
        p.overStock = !p.overStock;
        // 突破モードOFF時はoverCountをリセットしない（集計のため保持）
        saveAndBroadcast(storeId); break;
      }
      case 'TOGGLE_DELIVERED': {
        const store = stores[storeId]; if (!store) return;
        const idx = msg.saleIndex;
        const sales = currentDay === 1 ? store.sales1 : store.sales2;
        if (!sales || idx < 0 || idx >= sales.length) return;
        sales[idx].delivered = !sales[idx].delivered;
        saveAndBroadcast(storeId); break;
      }
      case 'SET_DAY': {
        const newDay = msg.day === 2 ? 2 : 1;
        currentDay = newDay;
        saveData();
        broadcastDayState();
        break;
      }
      case 'SET_COUNT_UP_MODE': {
        if (!stores[storeId]) return;
        stores[storeId].countUpMode = !!msg.countUpMode;
        // カウントアップモードOFF時はsold数をリセット
        if (!msg.countUpMode) {
          stores[storeId].products.forEach(p => { p.sold1 = 0; p.sold2 = 0; });
        }
        saveAndBroadcast(storeId); break;
      }
      case 'SET_NUMBER_MODE': {
        if (!stores[storeId]) return;
        stores[storeId].numberMode = !!msg.numberMode;
        saveAndBroadcast(storeId); break;
      }
      case 'UPDATE_THEME': {
        if (!stores[storeId]) return;
        stores[storeId].theme = msg.theme;
        saveAndBroadcast(storeId); break;
      }
    }
  });
  ws.on('close', () => clients.delete(ws));
});

process.on('SIGINT', () => { saveData(); console.log('\n💾 データ保存完了。終了します。'); process.exit(0); });
process.on('SIGTERM', () => { saveData(); process.exit(0); });
process.on('uncaughtException', (e) => { console.error('予期せぬエラー:', e); saveData(); process.exit(1); });

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n🎪 学校祭POSシステム起動完了');
  console.log('📡 http://localhost:' + PORT + '/admin');
  console.log('💾 データ保存先: ' + DATA_FILE + '\n');
});
