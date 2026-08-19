/**
 * 湊單最佳化: 給定「想吃什麼、各要幾份」, 找出總價最低的優惠券組合。
 *
 * 問題形式:
 *   min Σ cost_c · x_c
 *   s.t. Σ x_c · vec_c[i] ≥ demand[i]  對每個品項群組 i
 *        x_c ∈ ℤ≥0
 * 也就是整數覆蓋問題 (允許多拿到沒點的東西)。
 *
 * 四個被真實資料逼出來的細節:
 *  1. 一張券不是「固定一袋東西」, 每個 slot 可以換口味, 各有加價
 *     -> 一張券要展開成多個「變體」, 每個變體是一組口味選擇 + 對應的價格
 *  2. 一個選項不一定只有一份 (「2入原味蛋撻超極酥」是 2 顆), 也可能是複合品
 *     (「4塊上校雞塊+1顆原味蛋撻」) -> 每個選項帶 parts: [{item, qty}]
 *  3. 單點也是候選 (含「咔啦脆雞2塊 $124」這種本身就比買兩份便宜的品項)
 *     -> 保證永遠有解, 且自然產生「用券 + 單點補齊」的真實點法
 *  4. 超額一律 cap 到需求上限, 否則狀態空間會爆炸
 */

/** 一個選項在需求向量上的貢獻。slot 有幾份就乘幾份。 */
function optionVec(option, slotCount, groupOfName, groupCount) {
  const vec = new Array(groupCount).fill(0);
  for (const part of option.parts) {
    const g = groupOfName(part.item);
    if (g >= 0) vec[g] += part.qty * slotCount;
  }
  return vec;
}

/** 展開一張券的所有變體, 已先投影到需求品項上以壓縮組合數。 */
export function couponVariants(coupon, groupOfName, groupCount, maxVariants = 5000) {
  // 每個 slot 只保留「每種需求貢獻中最便宜的那個選項」。
  // 貢獻一樣但比較貴的口味永遠不會比較好, 砍掉不影響最佳解。
  const slotChoices = coupon.slots.map((slot) => {
    const byVec = new Map();
    for (const opt of slot.options) {
      const vec = optionVec(opt, slot.count, groupOfName, groupCount);
      const key = vec.join(',');
      const cur = byVec.get(key);
      if (!cur || opt.add_price < cur.addPrice) {
        byVec.set(key, { vec, addPrice: opt.add_price, name: opt.name, option: opt });
      }
    }
    return [...byVec.values()];
  });

  const total = slotChoices.reduce((n, c) => n * c.length, 1);
  const truncated = total > maxVariants;

  const variants = [];
  const choice = new Array(slotChoices.length);

  const walk = (s) => {
    if (variants.length >= maxVariants) return;
    if (s === slotChoices.length) {
      const vec = new Array(groupCount).fill(0);
      let cost = coupon.price;
      for (let i = 0; i < choice.length; i++) {
        const c = choice[i];
        cost += c.addPrice * coupon.slots[i].count;
        for (let g = 0; g < groupCount; g++) vec[g] += c.vec[g];
      }
      variants.push({ cost, vec, choices: choice.slice() });
      return;
    }
    for (const c of slotChoices[s]) {
      choice[s] = c;
      walk(s + 1);
    }
  };
  walk(0);

  return { variants, truncated };
}

/** 去重與支配剪枝: vec 相同留最便宜; A 涵蓋 B 且不比 B 貴 -> 砍掉 B。 */
export function pruneCandidates(candidates, groupCount) {
  const byVec = new Map();
  for (const cand of candidates) {
    const key = cand.cappedVec.join(',');
    const cur = byVec.get(key);
    if (!cur || cand.cost < cur.cost) byVec.set(key, cand);
  }
  const uniq = [...byVec.values()];

  const kept = [];
  for (let ai = 0; ai < uniq.length; ai++) {
    const a = uniq[ai];
    let dominated = false;
    for (let bi = 0; bi < uniq.length; bi++) {
      if (ai === bi) continue;
      const b = uniq[bi];
      if (b.cost > a.cost) continue;
      let covers = true;
      for (let i = 0; i < groupCount; i++) {
        if (b.cappedVec[i] < a.cappedVec[i]) { covers = false; break; }
      }
      // 完全相等時只留索引小的那個, 避免互相砍到一個都不剩
      if (covers && (b.cost < a.cost || bi < ai)) { dominated = true; break; }
    }
    if (!dominated) kept.push(a);
  }
  return kept;
}

function encodeStrides(demand) {
  const strides = new Array(demand.length);
  let n = 1;
  for (let i = 0; i < demand.length; i++) {
    strides[i] = n;
    n *= demand[i] + 1;
  }
  return { strides, size: n };
}

/**
 * @param {object} p
 * @param {Array}  p.coupons  券清單 (build_taxonomy.py 的格式)
 * @param {Array}  p.singles  可單點品項 [{ name, price, parts }]
 * @param {Array}  p.demand   [{ label, names: string[], count }]
 * @param {Set}    [p.excludeCodes]
 * @param {number} [p.maxStates]
 */
export function solve({
  coupons, singles, demand, excludeCodes = new Set(), maxStates = 500000, _skipBaseline = false,
}) {
  const k = demand.length;
  if (k === 0) return { ok: true, empty: true, solution: null };

  const counts = demand.map((d) => d.count);
  const { strides, size } = encodeStrides(counts);
  if (size > maxStates) return { ok: false, reason: 'too-many-states', states: size };

  // 品項名 -> 需求群組。同一個品名被兩個群組宣告時, 先宣告的優先。
  const nameToGroup = new Map();
  demand.forEach((d, i) => {
    for (const name of d.names) if (!nameToGroup.has(name)) nameToGroup.set(name, i);
  });
  const groupOfName = (name) => (nameToGroup.has(name) ? nameToGroup.get(name) : -1);
  const cap = (vec) => vec.map((v, i) => Math.min(v, counts[i]));

  const candidates = [];
  let anyTruncated = false;

  for (const coupon of coupons) {
    if (excludeCodes.has(coupon.code)) continue;
    const { variants, truncated } = couponVariants(coupon, groupOfName, k);
    if (truncated) anyTruncated = true;
    for (const v of variants) {
      const cappedVec = cap(v.vec);
      if (cappedVec.every((x) => x === 0)) continue;
      candidates.push({ kind: 'coupon', coupon, cost: v.cost, vec: v.vec, cappedVec, choices: v.choices });
    }
  }

  for (const s of singles) {
    const vec = new Array(k).fill(0);
    for (const part of s.parts) {
      const g = groupOfName(part.item);
      if (g >= 0) vec[g] += part.qty;
    }
    const cappedVec = cap(vec);
    if (cappedVec.every((x) => x === 0)) continue;
    candidates.push({ kind: 'single', single: s, cost: s.price, vec, cappedVec, choices: [] });
  }

  const pool = pruneCandidates(candidates, k);

  const INF = Infinity;
  const dp = new Float64Array(size).fill(INF);
  const fromCand = new Int32Array(size).fill(-1);
  const fromPrev = new Int32Array(size).fill(-1);
  dp[0] = 0;

  const rem = new Array(k);
  for (let idx = 1; idx < size; idx++) {
    let t = idx;
    for (let i = 0; i < k; i++) { rem[i] = t % (counts[i] + 1); t = Math.floor(t / (counts[i] + 1)); }

    for (let ci = 0; ci < pool.length; ci++) {
      const cand = pool[ci];
      let prev = 0;
      let useful = false;
      for (let i = 0; i < k; i++) {
        const left = rem[i] - cand.cappedVec[i];
        const r = left > 0 ? left : 0;
        if (r < rem[i]) useful = true;
        prev += r * strides[i];
      }
      if (!useful) continue;
      const c = dp[prev] + cand.cost;
      if (c < dp[idx]) { dp[idx] = c; fromCand[idx] = ci; fromPrev[idx] = prev; }
    }
  }

  const goal = size - 1;
  if (dp[goal] === INF) {
    const reachable = new Array(k).fill(false);
    for (const cand of pool) for (let i = 0; i < k; i++) if (cand.cappedVec[i] > 0) reachable[i] = true;
    return {
      ok: false, reason: 'infeasible',
      missing: demand.filter((_, i) => !reachable[i]).map((d) => d.label),
    };
  }

  // 回溯
  const usage = new Map();
  let idx = goal;
  while (idx !== 0) {
    const cand = pool[fromCand[idx]];
    const key = cand.kind === 'single'
      ? `s:${cand.single.name}`
      : `c:${cand.coupon.code}:${cand.choices.map((c) => c.name).join('|')}`;
    const cur = usage.get(key);
    if (cur) cur.qty += 1;
    else usage.set(key, { cand, qty: 1 });
    idx = fromPrev[idx];
  }

  const picks = [...usage.values()].map(({ cand, qty }) => {
    if (cand.kind === 'single') {
      return {
        kind: 'single', name: cand.single.name, qty,
        unitCost: cand.cost, subtotal: cand.cost * qty, parts: cand.single.parts,
      };
    }
    return {
      kind: 'coupon',
      code: cand.coupon.code,
      name: cand.coupon.name,
      qty,
      unitCost: cand.cost,
      subtotal: cand.cost * qty,
      coupon: cand.coupon,
      items: cand.coupon.slots.map((slot, i) => ({
        slotTitle: slot.title,
        name: cand.choices[i].name,
        count: slot.count * qty,
        accessory: !!cand.choices[i].option.accessory,
        parts: cand.choices[i].option.parts,
        swapped: cand.choices[i].name !== slot.options[0].name,
      })),
    };
  }).sort((a, b) => b.subtotal - a.subtotal);

  // 實際拿到 vs 想要 -> 多拿到什麼 (配件不算)
  const gained = new Map();
  const add = (item, n) => gained.set(item, (gained.get(item) || 0) + n);
  for (const pick of picks) {
    if (pick.kind === 'single') {
      for (const p of pick.parts) add(p.item, p.qty * pick.qty);
    } else {
      for (const it of pick.items) {
        if (it.accessory) continue;
        for (const p of it.parts) add(p.item, p.qty * it.count);
      }
    }
  }

  const left = new Map();
  demand.forEach((d, i) => left.set(i, d.count));
  const extras = [];
  for (const [item, qty] of gained) {
    const g = groupOfName(item);
    if (g < 0) { extras.push({ name: item, count: qty }); continue; }
    const need = left.get(g);
    const used = Math.min(need, qty);
    left.set(g, need - used);
    if (qty - used > 0) extras.push({ name: item, count: qty - used });
  }

  let baselineCost = null;
  if (!_skipBaseline) {
    const base = solve({ coupons: [], singles, demand, maxStates, _skipBaseline: true });
    if (base.ok && base.solution) baselineCost = base.solution.totalCost;
  }

  return {
    ok: true,
    solution: {
      totalCost: dp[goal],
      picks,
      extras: extras.sort((a, b) => b.count - a.count),
      baselineCost,
      saved: baselineCost === null ? null : baselineCost - dp[goal],
      candidatePoolSize: pool.length,
      states: size,
      truncated: anyTruncated,
    },
  };
}

/**
 * 最佳解 + 替代方案。最佳解常有實務障礙 (餐期不對、店員不熟這張券), 所以要給備案。
 * 作法: 逐一禁用最佳解裡用到的券, 重跑一次, 收集不同的解。
 */
export function solveWithAlternatives(params, maxAlternatives = 4) {
  const first = solve(params);
  if (!first.ok || !first.solution) return { ...first, alternatives: [] };

  const signature = (sol) => sol.picks
    .map((p) => `${p.kind}:${p.code || p.name}:${p.qty}`).sort().join('|');

  const seen = new Set([signature(first.solution)]);
  const alternatives = [];

  const usedCodes = first.solution.picks.filter((p) => p.kind === 'coupon').map((p) => p.code);
  for (const code of usedCodes) {
    if (alternatives.length >= maxAlternatives) break;
    const exclude = new Set([...(params.excludeCodes || []), code]);
    const alt = solve({ ...params, excludeCodes: exclude });
    if (!alt.ok || !alt.solution) continue;
    const sig = signature(alt.solution);
    if (seen.has(sig)) continue;
    seen.add(sig);
    alternatives.push({ ...alt.solution, withoutCode: code });
  }

  alternatives.sort((a, b) => a.totalCost - b.totalCost);
  return { ok: true, solution: first.solution, alternatives };
}

// ---------------------------------------------------------------------------
// 單品項排行榜 —— 目前 UI 用的就是這一段。
// 上面的 solve()/solveWithAlternatives() 是可疊多張券的湊單最佳化, 功能仍然完整
// 且有測試, 只是 UI 沒有露出 (疊券在實際點餐時體驗未確認)。
// ---------------------------------------------------------------------------

/** 券的內容簽章 (不含價格)。內容一樣的券要合併, 否則 Top 3 會被同一個優惠洗版。 */
export function couponSignature(coupon) {
  return coupon.slots
    .map((s) => `${s.title}|${s.count}|${s.options.map((o) => o.name).join('/')}`)
    .sort()
    .join('||');
}

/**
 * 這張券要拿到 itemNames 裡的東西, 最便宜的點法是哪一種口味組合?
 * 直接沿用 couponVariants() 展開口味組合 —— 換口味的加價要算進成本, 份數也要跟著算。
 *
 * 取「總價最低」而不是「每份單價最低」: 排序主軸是總價, 卡片上的總價與每份單價
 * 必須描述同一種點法, 否則使用者照著點會發現數字對不起來。同總價時取份數多的。
 * 回傳 null 表示這張券不含該品項。
 */
export function pickCheapestVariant(coupon, itemNames) {
  const wanted = itemNames instanceof Set ? itemNames : new Set(itemNames);
  const { variants } = couponVariants(coupon, (n) => (wanted.has(n) ? 0 : -1), 1);

  let best = null;
  for (const v of variants) {
    const count = v.vec[0];
    if (count <= 0) continue;
    if (!best || v.cost < best.cost || (v.cost === best.cost && count > best.count)) {
      best = { unitPrice: v.cost / count, count, cost: v.cost, choices: v.choices };
    }
  }
  return best;
}

/** 這個變體會拿到的東西, 拆成「想要的」與「順便附的」。配件 (刀叉/沾醬) 不算。 */
function splitItems(coupon, choices, wanted) {
  const want = new Map();
  const extra = new Map();
  coupon.slots.forEach((slot, i) => {
    const opt = choices[i].option;
    if (opt.accessory) return;
    for (const p of opt.parts) {
      const target = wanted.has(p.item) ? want : extra;
      target.set(p.item, (target.get(p.item) || 0) + p.qty * slot.count);
    }
  });
  const toList = (m) => [...m].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  return { wantedItems: toList(want), extras: toList(extra) };
}

/**
 * 依「總價」由低到高排出券。不疊券 —— 每一筆就是單獨一張券。
 *
 * 排總價而不是每份單價, 是因為每份單價會把多人份大套餐推到前面
 * (5 塊裝 $233 的每份單價贏過 1 塊裝 $54), 但一個人點餐時真正的決策數字是總價。
 *
 * @param {object}   p
 * @param {Array}    p.coupons
 * @param {string[]} p.itemNames    這個關鍵字對應到的品項名
 * @param {string}   p.date         'YYYY-MM-DD'，一律由呼叫端傳入, 不在這裡讀時鐘
 * @param {?number}  [p.mealPeriod] 1=早餐, 2=早餐以外, null=不限
 * @param {?number}  [p.minPrice]   價格下限 (含), null = 不限。給「$200 以上」這種價格帶用
 * @param {?number}  [p.maxPrice]   價格上限 (含), null = 不限
 * @param {number}   [p.limit]
 */
export function rankCouponsForItem({
  coupons, itemNames, date, mealPeriod = null, minPrice = null, maxPrice = null, limit = 10,
}) {
  const wanted = new Set(itemNames);
  if (!wanted.size) return [];

  const rows = [];
  for (const coupon of coupons) {
    if (!isCouponUsable(coupon, { date, mealPeriod })) continue;
    const best = pickCheapestVariant(coupon, wanted);
    if (!best) continue;
    // 價格帶比的是實付金額 (含換口味加價), 不是券的底價 —— 使用者看到多少就用多少篩
    if (maxPrice != null && best.cost > maxPrice) continue;
    if (minPrice != null && best.cost < minPrice) continue;

    const { wantedItems, extras } = splitItems(coupon, best.choices, wanted);
    const listPrice = coupon.list_price || null;
    rows.push({
      coupon,
      code: coupon.code,
      name: coupon.name,
      unitPrice: best.unitPrice,
      count: best.count,
      // 顯示用的券價含換口味的加價; 折扣率用券的原價 (文案的原價講的是預設組合)
      cost: best.cost,
      addPrice: best.cost - coupon.price,
      basePrice: coupon.price,
      listPrice,
      discount: listPrice ? (listPrice - coupon.price) / listPrice : null,
      endDate: coupon.end_date,
      wantedItems,
      extras,
      sameCodes: [],
    });
  }

  // 內容相同的合併, 留總價最低的那張, 其餘當備用代碼
  const bySig = new Map();
  for (const row of rows) {
    const sig = couponSignature(row.coupon);
    const cur = bySig.get(sig);
    if (!cur) { bySig.set(sig, row); continue; }
    const [keep, drop] = row.cost < cur.cost ? [row, cur] : [cur, row];
    keep.sameCodes = [...keep.sameCodes, ...drop.sameCodes,
      { code: drop.code, name: drop.name, price: drop.cost }];
    bySig.set(sig, keep);
  }

  const out = [...bySig.values()].sort((a, b) => (
    a.cost - b.cost
    || a.unitPrice - b.unitPrice          // 同價時份數多的排前面
    || (b.discount ?? -1) - (a.discount ?? -1)
    || a.code.localeCompare(b.code)
  ));
  for (const row of out) row.sameCodes.sort((x, y) => x.price - y.price);
  return out.slice(0, limit);
}

/** 券在指定日期與餐期是否可用。日期一律由呼叫端傳入, 絕不在這裡讀時鐘。 */
export function isCouponUsable(coupon, { date, mealPeriod } = {}) {
  if (date) {
    if (coupon.start_date && date < coupon.start_date) return false;
    if (coupon.end_date && date > coupon.end_date) return false;
  }
  if (mealPeriod != null && Array.isArray(coupon.meal_periods) && coupon.meal_periods.length) {
    if (!coupon.meal_periods.includes(mealPeriod)) return false;
  }
  return true;
}
