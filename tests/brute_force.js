/**
 * 獨立的暴力窮舉 oracle —— 只給測試用, 不進產品程式。
 *
 * 刻意「不」共用 optimizer.js 的任何一行:
 *   - 券變體用完整笛卡兒積展開, 不做需求投影、不做去重、不做支配剪枝
 *   - 用 DFS 窮舉組合, 不用 DP、不做狀態編碼
 * 這樣如果 optimizer 的剪枝或狀態編碼寫錯, 兩邊答案才會不一樣。
 * 兩邊都用同一套邏輯手算期望值 = 互相背書, 證明不了任何事。
 */

/** 完整展開: 每個 slot 每個選項都試, 不做任何壓縮。 */
export function expandAll(coupon) {
  let variants = [{ cost: coupon.price, items: new Map() }];
  for (const slot of coupon.slots) {
    const next = [];
    for (const base of variants) {
      for (const opt of slot.options) {
        const items = new Map(base.items);
        for (const part of opt.parts) {
          items.set(part.item, (items.get(part.item) || 0) + part.qty * slot.count);
        }
        next.push({ cost: base.cost + opt.add_price * slot.count, items });
      }
    }
    variants = next;
  }
  return variants;
}

/**
 * 窮舉最低總價。
 * @param {Array}  coupons
 * @param {Array}  singles  [{ name, price, parts }]
 * @param {Array}  demand   [{ names: string[], count }]
 * @param {number} maxPicks 最多買幾件 (券或單點)
 */
export function bruteForceMinCost(coupons, singles, demand, maxPicks = 4) {
  const k = demand.length;
  if (k === 0) return 0;

  const groupOf = (item) => {
    for (let i = 0; i < k; i++) if (demand[i].names.includes(item)) return i;
    return -1;
  };

  const picks = [];
  for (const coupon of coupons) {
    for (const v of expandAll(coupon)) {
      const vec = new Array(k).fill(0);
      for (const [item, qty] of v.items) {
        const g = groupOf(item);
        if (g >= 0) vec[g] += qty;
      }
      picks.push({ cost: v.cost, vec });
    }
  }
  for (const s of singles) {
    const vec = new Array(k).fill(0);
    for (const part of s.parts) {
      const g = groupOf(part.item);
      if (g >= 0) vec[g] += part.qty;
    }
    if (vec.some((x) => x > 0)) picks.push({ cost: s.price, vec });
  }

  let best = Infinity;
  const satisfied = (got) => demand.every((d, i) => got[i] >= d.count);

  // startIdx 讓組合不重複計算 (多重集合而非排列)
  const dfs = (startIdx, depth, cost, got) => {
    if (cost >= best) return;
    if (satisfied(got)) { best = cost; return; }
    if (depth === maxPicks) return;
    for (let i = startIdx; i < picks.length; i++) {
      const p = picks[i];
      dfs(i, depth + 1, cost + p.cost, got.map((g, j) => g + p.vec[j]));
    }
  };
  dfs(0, 0, 0, new Array(k).fill(0));
  return best;
}
