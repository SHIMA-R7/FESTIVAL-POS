const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const url = require('url');

const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'data', 'stores.json');
const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
const QR_DIR = path.join(__dirname, 'data', 'qr');

if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'));
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(QR_DIR)) fs.mkdirSync(QR_DIR);

let stores = {};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      stores = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      for (const id of Object.keys(stores)) stores[id].pendingPayment = null;
      console.log('💾 データ復元: ' + Object.keys(stores).length + '件の出店');
    }
  } catch (e) { console.error('データ読み込みエラー:', e.message); stores = {}; }
}

function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(stores, null, 2), 'utf8'); }
  catch (e) { console.error('データ保存エラー:', e.message); }
}

function saveAndBroadcast(storeId) { saveData(); broadcastStoreState(storeId); }

loadData();

let clients = new Map();

function defaultStore(name) {
  return {
    name, logo: null,
    products: [
      { id: 1, name: '商品A', price: 200, stock: 50, image: null },
      { id: 2, name: '商品B', price: 300, stock: 30, image: null },
      { id: 3, name: '商品C', price: 150, stock: 100, image: null },
      { id: 4, name: '商品D', price: 500, stock: 20, image: null },
    ],
    sales: [], totalRevenue: 0, pendingPayment: null,
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
  else if (pathname === '/staff') filePath = path.join(__dirname, 'public', 'staff.html');
  else if (pathname === '/customer') filePath = path.join(__dirname, 'public', 'customer.html');
  else if (pathname.startsWith('/data/uploads/')) filePath = path.join(UPLOADS_DIR, path.basename(pathname));
  else if (pathname.startsWith('/data/qr/')) filePath = path.join(__dirname, 'data', 'qr', path.basename(pathname));
  else filePath = path.join(__dirname, 'public', pathname);

  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

function storePayload(storeId) {
  const store = stores[storeId];
  if (!store) return null;
  return {
    type: 'STORE_STATE', store: {
      name: store.name, logo: store.logo, products: store.products,
      totalRevenue: store.totalRevenue, salesCount: store.sales.length, sales: store.sales,
      pendingPayment: store.pendingPayment, paypayUrl: store.paypayUrl || null, theme: store.theme || "orange",
    }
  };
}

function broadcastStoreState(storeId) {
  const payload = storePayload(storeId);
  if (!payload) return;
  const msg = JSON.stringify(payload);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      const c = clients.get(ws);
      if (c && c.storeId === storeId) ws.send(msg);
    }
  });
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
        if (!stores[storeId] && role !== 'admin' && role !== 'admin_product') {
          ws.send(JSON.stringify({ type: 'ERROR', message: '出店が存在しません' })); return;
        }
        clients.set(ws, { type: role, storeId: storeId || null });
        ws.send(JSON.stringify({ type: 'REGISTERED', role, storeId }));
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
        stores[storeId].products = msg.products;
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
          if (!p || p.stock < item.qty) { ws.send(JSON.stringify({ type: 'ERROR', message: item.name + 'の在庫が不足しています' })); return; }
        }
        store.pendingPayment = { items, total, method: msg.method };
        saveAndBroadcast(storeId); break;
      }
      case 'CONFIRM_PAYMENT': {
        const store = stores[storeId]; if (!store || !store.pendingPayment) return;
        const { items, total, method } = store.pendingPayment;
        for (const item of items) { const p = store.products.find(p => p.id === item.id); if (p) p.stock = Math.max(0, p.stock - item.qty); }
        store.sales.push({ items, total, method, time: new Date().toISOString() });
        store.totalRevenue += total; store.pendingPayment = null;
        saveAndBroadcast(storeId); break;
      }
      case 'CANCEL_PAYMENT': {
        const store = stores[storeId]; if (!store) return;
        store.pendingPayment = null; saveAndBroadcast(storeId); break;
      }
      case 'RESET_SALES': {
        const store = stores[storeId]; if (!store) return;
        store.sales = []; store.totalRevenue = 0; store.pendingPayment = null;
        saveAndBroadcast(storeId); break;
      }
      case 'GET_SALES': {
        const store = stores[storeId]; if (!store) return;
        ws.send(JSON.stringify({ type: 'SALES_DATA', sales: store.sales, totalRevenue: store.totalRevenue })); break;
      }
      case 'REVERT_SALE': {
        // 取引index番号で1件取り消し
        const store = stores[storeId]; if (!store) return;
        const idx = msg.saleIndex;
        if (idx < 0 || idx >= store.sales.length) return;
        const sale = store.sales[idx];
        // 在庫を戻す
        for (const item of sale.items) {
          const p = store.products.find(p => p.id === item.id);
          if (p) p.stock += item.qty;
        }
        // 売上を戻す
        store.totalRevenue -= sale.total;
        store.sales.splice(idx, 1);
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
