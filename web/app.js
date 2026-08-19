import { rankCouponsForItem, isCouponUsable } from './optimizer.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) if (k != null) n.append(k);
  return n;
};

let DATA = null;
const rows = [];

const TOP_N = 3;      // 主要顯示幾張
const POOL_N = 10;    // 多抓幾張放在「再多看」裡

/**
 * 餐期代碼是從資料本身推出來的, 不是猜的:
 * 436 張券只出現三種組合 —— [1] 16 張、[2,3,4,5] 408 張、全部 12 張。
 * 只有餐期 1 的那 16 張, 內容清一色是燒餅/薯餅/粥/蛋堡; 不含餐期 1 的 408 張
 * 沒有任何一張提到早餐。所以 1 = 早餐時段, 2~5 是早餐以外 (且永遠綁在一起)。
 */
const BREAKFAST = 1;
const NON_BREAKFAST = 2;

/** 常點的四類, 直接做成按鈕免得打字。label 是顯示的字, kw 是拿去比對的關鍵字。 */
const QUICK_ITEMS = [
  { label: '堡', kw: '堡' },
  { label: '炸雞', kw: '炸雞' },
  { label: '蛋撻', kw: '蛋撻' },
  { label: '飲料', kw: '飲料' },
];

/** 打字用的別名: 肯德基菜單寫「蛋撻」, 但很多人打「蛋塔」, 不對應就一筆都找不到。 */
const KEYWORD_ALIASES = { 蛋塔: '蛋撻', 蛋塔類: '蛋撻' };

/**
 * 價格帶刻意互斥。用「以下」會全部重疊 —— 排序本來就是總價升冪, 所以
 * 「$100 以下」「$150 以下」「$200 以下」的前幾名必然是同一批券, 按了跟沒按一樣。
 */
const PRICE_BANDS = [
  { label: '$100 以下', min: null, max: 100 },
  { label: '$101~150', min: 101, max: 150 },
  { label: '$151~200', min: 151, max: 200 },
  { label: '$201 以上', min: 201, max: null },
];
const DEFAULT_BAND = 0;

let activeBand = DEFAULT_BAND;
const activeQuick = new Set();

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const daysBetween = (isoA, isoB) => Math.round((new Date(isoB) - new Date(isoA)) / 86400000);

const money = (n) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(1)}`);

function currentMealPeriod() {
  const raw = $('#period').value;
  return raw === '' ? null : Number(raw);
}

const currentBand = () => PRICE_BANDS[activeBand];

function usableToday() {
  const date = todayISO();
  const mealPeriod = currentMealPeriod();
  return DATA.coupons.filter((c) => isCouponUsable(c, { date, mealPeriod }));
}

function updatePeriodHint() {
  $('#periodHint').textContent = `${usableToday().length} 張可用`;
}

// ---------- 關鍵字 -> 品項 ----------

/** 品名含關鍵字, 或肯德基自己的分類名稱含關鍵字 (炸雞/蛋撻/漢堡/飲料/配餐/主餐/烤雞) */
function matchItems(keyword) {
  const raw = keyword.trim();
  if (!raw) return [];
  const kw = KEYWORD_ALIASES[raw] || raw;
  const out = [];
  for (const [name, info] of Object.entries(DATA.items)) {
    if (name.includes(kw) || (info.categories || []).some((c) => c.includes(kw))) out.push(name);
  }
  return out.sort((a, b) => a.length - b.length);
}

// ---------- 想吃什麼 ----------

function addRow(keyword = '') {
  const kwInput = el('input', { type: 'text', value: keyword, placeholder: '例如 炸雞、蛋撻、雞塊' });
  const del = el('button', { className: 'icon-btn', textContent: '✕', title: '刪掉這列' });
  // 空的 <details> 瀏覽器會自己補一個「詳細資料」出來, 沒內容時要整個藏起來
  const matches = el('details', { className: 'matches', hidden: true });

  const row = { kwInput, matches, selected: new Set() };
  rows.push(row);

  const refresh = () => {
    const found = matchItems(kwInput.value);
    row.selected = new Set(found);
    matches.replaceChildren();
    matches.hidden = !kwInput.value.trim();
    if (matches.hidden) return;

    if (!found.length) {
      // 一定要放在 <summary> 裡 —— 塞成子元素的話會被 details 摺起來,
      // 使用者只會看到瀏覽器預設的「詳細資料」四個字, 看不到錯誤訊息
      matches.append(el('summary', {
        className: 'nomatch', textContent: `找不到含「${kwInput.value.trim()}」的品項`,
      }));
      return;
    }

    const label = () => `理解成這 ${row.selected.size} 個品項（點開可取消不要的）`;
    const summary = el('summary', { textContent: label() });
    const chips = el('div', { className: 'chips' });
    for (const name of found) {
      const cb = el('input', { type: 'checkbox', checked: true });
      const chip = el('label', { className: 'chip' }, [cb, document.createTextNode(name)]);
      cb.addEventListener('change', () => {
        chip.classList.toggle('off', !cb.checked);
        if (cb.checked) row.selected.add(name); else row.selected.delete(name);
        summary.textContent = label();
      });
      chips.append(chip);
    }
    matches.append(summary, chips);
  };

  kwInput.addEventListener('input', refresh);
  kwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') rank(); });
  del.addEventListener('click', () => {
    rows.splice(rows.indexOf(row), 1);
    wrapper.remove();
  });

  const wrapper = el('div', {}, [el('div', { className: 'row' }, [kwInput, del]), matches]);
  $('#rows').append(wrapper);
  if (keyword) refresh();
}

// ---------- 排行卡片 ----------

function renderCard(r, place, today, tags = []) {
  const head = el('div', { className: 'rank-head' }, [
    el('span', { className: 'rank-no', textContent: String(place) }),
    el('span', { className: 'code', textContent: r.code }),
    el('span', { className: 'pick-name', textContent: r.name }),
  ]);
  // 同時選了多類時, 標出這張券是因為哪一類上榜的
  for (const t of tags) head.append(el('span', { className: 'tag', textContent: t }));
  const mp = r.coupon.meal_periods || [];
  if (mp.length && !mp.includes(NON_BREAKFAST)) {
    head.append(el('span', { className: 'badge', textContent: '限早餐時段' }));
  } else if (mp.length && !mp.includes(BREAKFAST)) {
    head.append(el('span', { className: 'badge', textContent: '早餐時段不適用' }));
  }

  const card = el('div', { className: 'rank-card' }, [head]);

  // 標題數字是總價 —— 一個人點餐時真正要付的錢
  card.append(el('div', { className: 'unit', textContent: money(r.cost) }));

  // 次要那行: 每份單價 + 原價/折扣率 (原價只有官方文案寫了才顯示, 沒有就誠實留白)
  const priceLine = el('div', { className: 'price-line' });
  priceLine.append(el('span', { textContent: `每份 ${money(r.unitPrice)}` }));
  if (r.addPrice > 0) {
    priceLine.append(el('span', { className: 'dim', textContent: `（含換口味加價 $${r.addPrice}）` }));
  }
  if (r.listPrice) {
    priceLine.append(el('span', { textContent: `・原價 $${r.listPrice}・` }));
    priceLine.append(el('span', {
      className: 'saved', textContent: `省 ${Math.round(r.discount * 100)}%`,
    }));
  } else {
    priceLine.append(el('span', { className: 'dim', textContent: '・原價未提供' }));
  }
  card.append(priceLine);

  card.append(el('div', {
    className: 'got',
    textContent: `共 ${r.wantedItems.map((i) => `${i.name} ×${i.count}`).join('、')}`,
  }));
  if (r.extras.length) {
    card.append(el('div', {
      className: 'extra',
      textContent: `還附：${r.extras.map((i) => `${i.name} ×${i.count}`).join('、')}`,
    }));
  }

  const left = daysBetween(today, r.endDate);
  card.append(el('div', {
    className: left <= 7 ? 'expiry soon' : 'expiry',
    textContent: `到期 ${r.endDate}（剩 ${left} 天）`,
  }));

  if (r.sameCodes.length) {
    card.append(el('div', {
      className: 'same',
      textContent: `另有 ${r.sameCodes.length} 組代碼內容相同（店家不收時可換）：`
        + r.sameCodes.map((s) => `${s.code} ${money(s.price)}`).join('、'),
    }));
  }

  if (r.coupon.notes) {
    card.append(el('details', { className: 'notes' }, [
      el('summary', { textContent: '券的原始說明' }),
      el('div', { className: 'note', textContent: r.coupon.notes }),
    ]));
  }
  return card;
}

function renderSection(label, results, today, { band, fallback, groups = [] } = {}) {
  const box = el('section');
  box.append(el('h2', { textContent: `${label}　${band.label}最便宜的券` }));

  if (!results.length) {
    // 只說「沒有」沒用 —— 要告訴使用者最接近的是什麼, 他才知道要不要換價格帶
    const msg = fallback
      ? `${band.label}沒有含「${label}」的券。其他價格帶裡最便宜的是 $${fallback.cost}`
        + `（${fallback.code} ${fallback.name}）。`
      : `目前沒有含「${label}」而且今天可用的券。`;
    box.append(el('div', { className: 'card' }, [el('div', { className: 'nomatch', textContent: msg })]));
    return box;
  }

  const card = (r, i) => renderCard(r, i, today, tagsFor(r, groups));
  results.slice(0, TOP_N).forEach((r, i) => box.append(card(r, i + 1)));

  const rest = results.slice(TOP_N);
  if (rest.length) {
    const more = el('details', { className: 'more' });
    more.append(el('summary', { textContent: `再多看 ${rest.length} 張` }));
    rest.forEach((r, i) => more.append(card(r, TOP_N + i + 1)));
    box.append(more);
  }
  return box;
}

/**
 * 快捷按鈕選的 + 自己打字的, 各自是一組。
 * 選了多組時是「或」—— 含任一組的券排在同一張榜上, 卡片再標它命中哪一組。
 */
function buildGroups() {
  const groups = [];
  for (const q of QUICK_ITEMS) {
    if (activeQuick.has(q.kw)) groups.push({ label: q.label, names: new Set(matchItems(q.kw)) });
  }
  for (const row of rows) {
    if (row.kwInput.value.trim() && row.selected.size) {
      groups.push({ label: row.kwInput.value.trim(), names: new Set(row.selected) });
    }
  }
  return groups.filter((g) => g.names.size);
}

/** 這張券命中哪幾組。只有選了兩組以上才需要標。 */
function tagsFor(row, groups) {
  if (groups.length < 2) return [];
  return groups
    .filter((g) => row.wantedItems.some((i) => g.names.has(i.name)))
    .map((g) => g.label);
}

/**
 * @param {boolean} auto 由按鈕自動觸發的。什麼都沒選時只清空結果, 不跳提示
 *                       —— 使用者剛把最後一個按鈕取消掉, 不該被當成操作錯誤。
 */
function rank(auto = false) {
  const out = $('#out');
  out.replaceChildren();

  const groups = buildGroups();
  if (!groups.length) {
    if (!auto) {
      out.append(el('div', { className: 'card' }, [
        el('div', { className: 'nomatch', textContent: '先選想吃什麼（上面的按鈕，或自己打字）。' }),
      ]));
    }
    return;
  }

  const today = todayISO();
  const mealPeriod = currentMealPeriod();
  const band = currentBand();
  const pool = usableToday().length;

  // 多組時取聯集 ——「含堡或炸雞」的券排在同一張榜上
  const names = [...new Set(groups.flatMap((g) => [...g.names]))];
  const base = { coupons: DATA.coupons, itemNames: names, date: today, mealPeriod };
  const results = rankCouponsForItem({
    ...base, minPrice: band.min, maxPrice: band.max, limit: POOL_N,
  });

  // 這個價格帶沒有時, 再查一次不限價格, 好告訴使用者最接近的是什麼
  let fallback = null;
  if (!results.length) [fallback] = rankCouponsForItem({ ...base, limit: 1 });

  const label = groups.map((g) => g.label).join('、');
  out.append(renderSection(label, results, today, { band, fallback, groups }));

  out.append(el('div', {
    className: 'meta',
    textContent: `從 ${pool} 張今天可用的券中挑出，只看${band.label}`,
  }));
}

// ---------- 快捷按鈕 ----------

function buildQuickItems() {
  const box = $('#quickItems');
  for (const q of QUICK_ITEMS) {
    const btn = el('button', { type: 'button', textContent: q.label });
    btn.setAttribute('aria-pressed', String(activeQuick.has(q.kw)));
    btn.addEventListener('click', () => {
      if (activeQuick.has(q.kw)) activeQuick.delete(q.kw);
      else activeQuick.add(q.kw);
      btn.setAttribute('aria-pressed', String(activeQuick.has(q.kw)));
      rank(true);   // 按了就直接出結果, 不用再按一次「找」
    });
    box.append(btn);
  }
}

function buildQuickBands() {
  const box = $('#quickBands');
  PRICE_BANDS.forEach((b, i) => {
    const btn = el('button', { type: 'button', textContent: b.label });
    btn.setAttribute('aria-pressed', String(i === activeBand));
    btn.addEventListener('click', () => {
      activeBand = i;
      // 價格帶是單選, 其餘按鈕要一起取消
      [...box.children].forEach((el2, j) => el2.setAttribute('aria-pressed', String(j === i)));
      rank(true);
    });
    box.append(btn);
  });
}

// ---------- 啟動 ----------

async function boot() {
  try {
    const resp = await fetch('./solver_data.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    DATA = await resp.json();
  } catch (e) {
    $('#meta').textContent = `讀不到券資料（${e.message}）— 要用 http 開，不能直接點開檔案`;
    $('#meta').classList.add('stale');
    return;
  }

  const today = todayISO();
  const inDate = DATA.coupons.filter((c) => isCouponUsable(c, { date: today }));

  // 早餐收攤時間各店不同, 這裡只是預設值, 使用者可以自己改
  const now = new Date();
  $('#period').value = (now.getHours() * 60 + now.getMinutes()) < 10 * 60 + 30
    ? String(BREAKFAST) : String(NON_BREAKFAST);

  const age = daysBetween(DATA.fetched_at.slice(0, 10), today);
  const expiringSoon = inDate.filter((c) => daysBetween(today, c.end_date) <= 7).length;
  const meta = $('#meta');
  meta.textContent =
    `${inDate.length} 張今天有效的券・資料抓取於 ${DATA.fetched_at.slice(0, 10)}`
    + (age > 0 ? `（${age} 天前）` : '（今天）');
  // 正常每天自動更新一次, 所以隔了 2 天以上就代表有一次更新失敗了。
  // 這種時候寧可講得明顯一點 —— 使用者拿過期代碼到櫃檯很尷尬。
  if (age >= 2) {
    meta.classList.add('stale');
    meta.textContent += `　⚠ 已 ${age} 天沒更新，可能有券下架或新券未收錄，請以店內公告為準`;
  } else if (expiringSoon) {
    meta.textContent += `・${expiringSoon} 張 7 天內到期`;
  }
  $('#shop').textContent = DATA.shop_name || DATA.shop_code;

  updatePeriodHint();
  buildQuickItems();
  buildQuickBands();
  addRow();
}

$('#addRow').addEventListener('click', () => addRow());
$('#calc').addEventListener('click', rank);
$('#period').addEventListener('change', () => { updatePeriodHint(); rank(true); });
boot();
