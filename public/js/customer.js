const params = new URLSearchParams(location.search);
const STORE_ID = params.get('store') || 'store1';
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

let cart = {}, products = [], ws, pendingPayment = null, isWaiting = false, paypayUrl = null, lastLogoUrl = undefined, currentStore = null;

// QRコードは事前生成PNG画像を使用（generate_qr.js参照）

// ── WebSocket ─────────────────────────────────────────────────
function updateDayBadge(day) {
    const el = document.getElementById('day-badge-hdr');
    if (!el) return;
    el.textContent = day === 2 ? '2日目' : '1日目';
    el.className = 'day-badge-hdr ' + (day === 2 ? 'day2' : 'day1');
}

function connect() {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'REGISTER', role: 'customer', storeId: STORE_ID }));
    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'REGISTERED') { document.getElementById('connecting').style.display = 'none'; if (msg.currentDay) updateDayBadge(msg.currentDay); }
        if (msg.type === 'STORE_STATE') updateState(msg.store);
        if (msg.type === 'DAY_STATE') { updateDayBadge(msg.currentDay); }
        if (msg.type === 'ERROR') alert('エラー: ' + msg.message);
    };
    ws.onclose = () => { document.getElementById('connecting').style.display = 'flex'; setTimeout(connect, 2000); };
}

function updateState(store) {
    currentStore = store
    document.getElementById('store-name').textContent = store.name;
    document.getElementById('store-badge').textContent = STORE_ID;
    paypayUrl = store.paypayUrl || null;

    // テーマ適用
    const themes = ['orange', 'red', 'blue', 'green', 'purple', 'dark'];
    document.body.classList.remove(...themes.map(t => 'theme-' + t));
    document.body.classList.add('theme-' + (store.theme || 'orange'));

    // ロゴ（画像URLが変わらない限り再構築しない＝再読み込み防止）
    if (store.logo !== lastLogoUrl) {
        lastLogoUrl = store.logo;
        const wrap = document.getElementById('logo-wrap');
        if (store.logo) {
            const img = document.createElement('img');
            img.className = 'logo-img';
            img.src = store.logo;
            img.onerror = () => { wrap.innerHTML = '<div class="logo-placeholder">🎪</div>'; };
            wrap.innerHTML = '';
            wrap.appendChild(img);
        } else {
            wrap.innerHTML = '<div class="logo-placeholder">🎪</div>';
        }
    }

    products = store.products;
    // バナー表示制御
    const isCountUpMode = !!store.countUpMode;
    const hasOver = (products || []).some(p => p.overStock);
    const hasBurst = isCountUpMode && (products || []).some(p => p.sold >= p.stock);
    const banner = document.getElementById('over-banner');
    if (banner) {
        if (hasBurst) {
            banner.textContent = '⚡ 現在予想売り上げ数を突破中！';
            banner.style.display = 'block';
        } else if (hasOver) {
            banner.textContent = '⚡ 現在予定売り上げ数を突破！';
            banner.style.display = 'block';
        } else {
            banner.style.display = 'none';
        }
    }
    const prev = pendingPayment;
    pendingPayment = store.pendingPayment;
    if (isWaiting && prev && !pendingPayment) { showDone(); return; }
    renderProducts();
}

// ── 商品描画 ──────────────────────────────────────────────────
// 方針: <img>タグは初回構築時に1回だけ作る。以降は在庫・カート数のテキスト/クラスだけを
// 差分更新することで、購入操作のたびに画像が再読み込みされる問題を防ぐ。
const ICONS = ['🍔', '🍕', '🍜', '🍱', '🍰', '🥤', '🍡', '🍪', '🌮', '🍣', '🍦', '🥞'];
let productCardEls = {}; // productId -> { card, badge, stockEl }
let builtProductSignature = null; // 商品リストの構成（id+image+name+price）が変わったかを検知

function productSignature(list) {
    return list.map(p => p.id + '|' + (p.image || '') + '|' + p.name + '|' + p.price).join('::');
}

function renderProducts() {
    const area = document.getElementById('products-area');

    if (!products.length) {
        area.innerHTML = '<div style="color:#ccc;text-align:center;padding:40px;grid-column:1/-1">商品がありません</div>';
        productCardEls = {}; builtProductSignature = null;
        return;
    }

    const sig = productSignature(products);

    // 商品構成（画像・名前・価格・並び順）が変わった場合のみ全体を再構築
    if (sig !== builtProductSignature) {
        area.innerHTML = '';
        productCardEls = {};

        products.forEach((p, i) => {
            const card = document.createElement('div');
            card.className = 'product-card';
            card.onclick = () => addToCart(p.id);

            const badge = document.createElement('div');
            badge.className = 'cart-badge';
            badge.textContent = '0';

            let imgEl;
            if (p.image) {
                imgEl = document.createElement('img');
                imgEl.className = 'product-img';
                imgEl.loading = 'lazy';
                imgEl.src = p.image;
                imgEl.onerror = () => {
                    const ph = document.createElement('div');
                    ph.className = 'product-img-placeholder';
                    ph.textContent = ICONS[i % ICONS.length];
                    imgEl.replaceWith(ph);
                };
            } else {
                imgEl = document.createElement('div');
                imgEl.className = 'product-img-placeholder';
                imgEl.textContent = ICONS[i % ICONS.length];
            }

            const info = document.createElement('div');
            info.className = 'product-info';

            const nameEl = document.createElement('div');
            nameEl.className = 'product-name';
            nameEl.textContent = p.name;

            const priceEl = document.createElement('div');
            priceEl.className = 'product-price';
            priceEl.innerHTML = '<span>¥</span>' + p.price.toLocaleString();

            const stockEl = document.createElement('div');
            stockEl.className = 'product-stock';

            info.appendChild(nameEl);
            info.appendChild(priceEl);
            info.appendChild(stockEl);

            card.appendChild(badge);
            card.appendChild(imgEl);
            card.appendChild(info);
            area.appendChild(card);

            productCardEls[p.id] = { card, badge, stockEl };
        });

        builtProductSignature = sig;
    }

    // 在庫・カート状態の差分更新（画像には触れない）
    products.forEach(p => {
        const els = productCardEls[p.id];
        if (!els) return;
        const isOver = !!p.overStock;
        const isCU = !!currentStore.countUpMode;
        const inCart = cart[p.id] && cart[p.id].qty > 0;
        const qty = inCart ? cart[p.id].qty : 0;
        const oos = !isOver && !isCU && p.stock <= 0;
        const low = !isOver && !isCU && p.stock > 0 && p.stock <= 5;
        const cuBurst = isCU && (p.sold || 0) >= p.stock; // カウントアップで目標超過

        els.card.classList.toggle('in-cart', !!inCart);
        els.card.classList.toggle('out-of-stock', oos);
        els.card.onclick = oos ? null : () => addToCart(p.id);

        els.badge.textContent = qty;
        els.badge.classList.toggle('visible', !!inCart);

        if (isCU) {
            // カウントアップモード: 売れた数/目標数を表示
            els.stockEl.textContent = cuBurst ? ('目標達成+' + ((p.sold || 0) - p.stock) + '個') : ('販売中 ' + (p.sold || 0) + '/' + p.stock + '個');
            els.stockEl.className = 'product-stock' + (cuBurst ? ' over-mode' : '');
        } else if (isOver) {
            els.stockEl.textContent = '⚡ 突破中';
            els.stockEl.className = 'product-stock over-mode';
        } else {
            els.stockEl.textContent = oos ? '売切れ' : (low ? '残り' + p.stock + '個' : '残' + p.stock + '個');
            els.stockEl.classList.toggle('low', low);
        }
    });
}

function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function addToCart(id) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    const isCU = currentStore && currentStore.countUpMode;
    if (!p.overStock && !isCU && p.stock <= 0) return;
    if (!p.overStock && !isCU && cart[id] && cart[id].qty >= p.stock) { alert('在庫以上は追加できません'); return; }
    if (!cart[id]) cart[id] = { name: p.name, price: p.price, qty: 0 };
    cart[id].qty++;
    renderCart(); renderProducts();
}

function changeQty(id, delta) {
    if (!cart[id]) return;
    cart[id].qty += delta;
    if (cart[id].qty <= 0) delete cart[id];
    renderCart(); renderProducts();
}

function renderCart() {
    const items = Object.entries(cart);
    const total = items.reduce((s, [, v]) => s + v.price * v.qty, 0);
    const count = items.reduce((s, [, v]) => s + v.qty, 0);
    document.getElementById('cart-count').textContent = count;
    document.getElementById('total-display').textContent = total.toLocaleString();
    document.getElementById('btn-pay').disabled = items.length === 0;
    const container = document.getElementById('cart-items');
    if (!items.length) { container.innerHTML = '<div class="cart-empty"><span class="cart-empty-icon">🛍️</span>商品を選んでください</div>'; return; }
    container.innerHTML = items.map(([id, item]) =>
        '<div class="cart-item">' +
        '<div><div class="cart-item-name">' + escHtml(item.name) + '</div>' +
        '<div class="cart-item-price">¥' + item.price + ' × ' + item.qty + ' = ¥' + (item.price * item.qty).toLocaleString() + '</div></div>' +
        '<div class="qty-controls">' +
        '<button class="qty-btn minus" onclick="changeQty(' + id + ',-1)">−</button>' +
        '<span class="qty-num">' + item.qty + '</span>' +
        '<button class="qty-btn" onclick="changeQty(' + id + ',1)">＋</button>' +
        '</div></div>'
    ).join('');
}

function openPayModal() {
    const total = Object.entries(cart).reduce((s, [, v]) => s + v.price * v.qty, 0);
    document.getElementById('modal-total').textContent = total.toLocaleString();
    showScreen('method');
    document.getElementById('modal-overlay').classList.add('visible');
}

function selectPayment(method) {
    const items = Object.entries(cart).map(([id, v]) => ({ id: parseInt(id), name: v.name, price: v.price, qty: v.qty }));
    const total = items.reduce((s, i) => s + i.price * i.qty, 0);
    ws.send(JSON.stringify({ type: 'SELECT_PAYMENT', storeId: STORE_ID, items, method }));
    isWaiting = true;

    if (method === 'paypay') {
        document.getElementById('qr-amount').textContent = total.toLocaleString();
        document.getElementById('qr-amount2').textContent = total.toLocaleString();

        const img = document.getElementById('qr-img');
        const fallback = document.getElementById('qr-fallback');
        const warn = document.getElementById('qr-warn');

        // 金額に関係なく常に同じQR画像を表示（客が金額を手入力して送金する運用）
        img.style.display = 'none';
        fallback.style.display = 'block';
        fallback.textContent = 'QR読み込み中...';
        warn.style.display = 'none';

        const qrUrl = '/data/qr/' + STORE_ID + '.png';
        img.onload = () => {
            fallback.style.display = 'none';
            img.style.display = 'block';
            warn.style.display = 'none';
        };
        img.onerror = () => {
            fallback.style.display = 'block';
            fallback.textContent = 'QR未設定\nQRコード生成.bat を\n実行してください';
            img.style.display = 'none';
            warn.style.display = 'block';
            warn.textContent = '⚠️ QR画像が見つかりません。\n管理画面でPayPay URLを設定後、\nQRコード生成.bat を実行してください。';
        };
        img.src = qrUrl + '?t=' + Date.now(); // キャッシュ防止

        showScreen('paypay');
    } else {
        document.getElementById('cash-amount').textContent = total.toLocaleString();
        showScreen('cash');
    }
}

function showScreen(name) {
    document.getElementById('method-select-screen').style.display = name === 'method' ? '' : 'none';
    document.getElementById('paypay-screen').className = 'qr-screen' + (name === 'paypay' ? ' active' : '');
    document.getElementById('cash-screen').className = 'cash-screen' + (name === 'cash' ? ' active' : '');
}

function cancelPayment() {
    ws.send(JSON.stringify({ type: 'CANCEL_PAYMENT', storeId: STORE_ID }));
    isWaiting = false;
    document.getElementById('modal-overlay').classList.remove('visible');
}

function showDone() {
    isWaiting = false; cart = {};
    document.getElementById('modal-overlay').classList.remove('visible');
    document.getElementById('done-overlay').classList.add('visible');
    renderCart(); renderProducts();
    setTimeout(() => document.getElementById('done-overlay').classList.remove('visible'), 3000);
}

document.getElementById('btn-pay').addEventListener('click', openPayModal);
connect();