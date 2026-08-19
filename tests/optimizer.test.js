import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  solve, solveWithAlternatives, couponVariants, isCouponUsable,
  rankCouponsForItem, pickCheapestVariant, couponSignature,
} from '../web/optimizer.js';
import { bruteForceMinCost } from './brute_force.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** [name, addPrice] 或 [name, addPrice, parts] */
const opt = (o) => ({
  name: o[0],
  add_price: o[1],
  parts: o[2] || [{ item: o[0], qty: 1 }],
  accessory: false,
});
const slot = (title, count, options) => ({ title, count, options: options.map(opt) });
const coupon = (code, price, slots) => ({
  code, name: code, price, slots,
  start_date: '2020-01-01', end_date: '2099-12-31', meal_periods: [1, 2, 3, 4, 5],
});
const single = (name, price, parts) => ({ name, price, parts: parts || [{ item: name, qty: 1 }] });

const SINGLES = [single('咔啦脆雞', 79), single('原味蛋撻', 35)];

describe('couponVariants', () => {
  it('同一個需求群組裡較貴的口味砍掉 (選貴的永遠不會比較好)', () => {
    const c = coupon('X', 100, [
      slot('炸雞', 2, [['咔啦脆雞', 0], ['青花椒脆雞', 7], ['爆脆雞', 3]]),
    ]);
    const { variants } = couponVariants(c, (n) => (n.includes('雞') ? 0 : -1), 1);
    expect(variants).toHaveLength(1);
    expect(variants[0].cost).toBe(100);
    expect(variants[0].vec).toEqual([2]);
  });

  it('跨群組的選項各自保留, 加價要乘上份數', () => {
    const c = coupon('X', 100, [slot('主餐', 3, [['咔啦脆雞', 0], ['原味蛋撻', 5]])]);
    const groupOf = (n) => (n === '咔啦脆雞' ? 0 : n === '原味蛋撻' ? 1 : -1);
    const { variants } = couponVariants(c, groupOf, 2);
    expect(variants).toHaveLength(2);
    const tart = variants.find((v) => v.vec[1] > 0);
    expect(tart.cost).toBe(100 + 5 * 3);
    expect(tart.vec).toEqual([0, 3]);
  });

  it('一個選項含多份時要乘進去 (2入原味蛋撻 = 2 顆)', () => {
    const c = coupon('X', 100, [
      slot('蛋撻', 2, [['2入原味蛋撻超極酥', 0, [{ item: '原味蛋撻超極酥', qty: 2 }]]]),
    ]);
    const { variants } = couponVariants(c, (n) => (n === '原味蛋撻超極酥' ? 0 : -1), 1);
    expect(variants[0].vec).toEqual([4]); // 2 顆 × 2 份
  });

  it('複合選項的每個部分都要算到', () => {
    const c = coupon('X', 100, [
      slot('組合', 1, [['4塊上校雞塊+1顆原味蛋撻', 0,
        [{ item: '上校雞塊', qty: 4 }, { item: '原味蛋撻', qty: 1 }]]]),
    ]);
    const groupOf = (n) => (n === '上校雞塊' ? 0 : n === '原味蛋撻' ? 1 : -1);
    const { variants } = couponVariants(c, groupOf, 2);
    expect(variants[0].vec).toEqual([4, 1]);
  });
});

describe('solve — 手算得出來的小案例', () => {
  it('沒有券時退化成全部單點', () => {
    const r = solve({
      coupons: [], singles: SINGLES,
      demand: [{ label: '炸雞', names: ['咔啦脆雞'], count: 2 }],
    });
    expect(r.ok).toBe(true);
    expect(r.solution.totalCost).toBe(158);
    expect(r.solution.picks).toHaveLength(1);
    expect(r.solution.picks[0]).toMatchObject({ kind: 'single', name: '咔啦脆雞', qty: 2 });
  });

  it('本身就成組的單品要贏過買兩份 (咔啦脆雞2塊 124 < 79×2)', () => {
    const singles = [...SINGLES, single('咔啦脆雞2塊', 124, [{ item: '咔啦脆雞', qty: 2 }])];
    const r = solve({
      coupons: [], singles,
      demand: [{ label: '炸雞', names: ['咔啦脆雞'], count: 2 }],
    });
    expect(r.solution.totalCost).toBe(124);
  });

  it('券比單點便宜就用券, 並算出多拿到的東西', () => {
    const c = coupon('A', 100, [
      slot('炸雞', 2, [['咔啦脆雞', 0]]),
      slot('蛋撻', 1, [['原味蛋撻', 0]]),
    ]);
    const r = solve({
      coupons: [c], singles: SINGLES,
      demand: [{ label: '炸雞', names: ['咔啦脆雞'], count: 2 }],
    });
    expect(r.solution.totalCost).toBe(100);
    expect(r.solution.extras).toEqual([{ name: '原味蛋撻', count: 1 }]);
    expect(r.solution.baselineCost).toBe(158);
    expect(r.solution.saved).toBe(58);
  });

  it('配件不算進「多拿到什麼」', () => {
    const sauce = { name: '糖醋醬', add_price: 0, parts: [{ item: '糖醋醬', qty: 1 }], accessory: true };
    const c = coupon('A', 100, [
      slot('炸雞', 2, [['咔啦脆雞', 0]]),
      { title: '其他', count: 1, options: [sauce] },
    ]);
    const r = solve({
      coupons: [c], singles: SINGLES,
      demand: [{ label: '炸雞', names: ['咔啦脆雞'], count: 2 }],
    });
    expect(r.solution.extras).toEqual([]);
  });

  it('同一張券可以重複使用', () => {
    const c = coupon('A', 100, [slot('炸雞', 2, [['咔啦脆雞', 0]])]);
    const r = solve({
      coupons: [c], singles: SINGLES,
      demand: [{ label: '炸雞', names: ['咔啦脆雞'], count: 4 }],
    });
    expect(r.solution.totalCost).toBe(200);
    expect(r.solution.picks[0]).toMatchObject({ kind: 'coupon', code: 'A', qty: 2 });
  });

  it('會混用「券 + 單點補齊」', () => {
    const c = coupon('A', 100, [slot('炸雞', 2, [['咔啦脆雞', 0]])]);
    const r = solve({
      coupons: [c], singles: SINGLES,
      demand: [{ label: '炸雞', names: ['咔啦脆雞'], count: 3 }],
    });
    expect(r.solution.totalCost).toBe(179); // 券 100 + 單點 79 < 兩張券 200
    expect(r.solution.picks.map((p) => p.kind).sort()).toEqual(['coupon', 'single']);
  });

  it('需求為空', () => {
    expect(solve({ coupons: [], singles: SINGLES, demand: [] }).empty).toBe(true);
  });

  it('拿不到的品項要明講 infeasible, 不可以假裝算得出來', () => {
    const r = solve({
      coupons: [], singles: [],
      demand: [{ label: '不存在的東西', names: ['XXX'], count: 1 }],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('infeasible');
    expect(r.missing).toEqual(['不存在的東西']);
  });

  it('狀態空間過大時擋下來而不是硬跑', () => {
    const demand = Array.from({ length: 8 }, (_, i) => ({ label: `x${i}`, names: [`x${i}`], count: 9 }));
    const r = solve({ coupons: [], singles: [], demand });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('too-many-states');
  });
});

describe('solve vs 獨立暴力窮舉 (合成資料)', () => {
  let seed = 20260819; // 固定種子, 失敗可重現
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };

  const NAMES = ['咔啦脆雞', '青花椒脆雞', '原味蛋撻', '上校雞塊', '薯條'];
  const singles = [
    single('咔啦脆雞', 79), single('青花椒脆雞', 86), single('原味蛋撻', 35),
    single('上校雞塊', 60), single('薯條', 40),
    single('咔啦脆雞2塊', 124, [{ item: '咔啦脆雞', qty: 2 }]),
  ];

  it('60 組隨機券組, DP 的最低總價要跟窮舉一致', () => {
    for (let t = 0; t < 60; t++) {
      const coupons = [];
      for (let c = 0; c < 3 + rand(3); c++) {
        const slots = [];
        for (let s = 0; s < 1 + rand(3); s++) {
          const opts = [];
          const used = new Set();
          for (let o = 0; o < 1 + rand(3); o++) {
            const name = NAMES[rand(NAMES.length)];
            if (used.has(name)) continue;
            used.add(name);
            // 偶爾生出「一份含兩個」的選項, 把 qty 這條路徑也涵蓋進去
            const qty = rand(4) === 0 ? 2 : 1;
            opts.push([name, o === 0 ? 0 : rand(12), [{ item: name, qty }]]);
          }
          slots.push(slot('s', 1 + rand(3), opts));
        }
        coupons.push(coupon(`C${c}`, 50 + rand(150), slots));
      }

      const demand = [
        { label: '雞', names: ['咔啦脆雞', '青花椒脆雞'], count: 1 + rand(3) },
        { label: '撻', names: ['原味蛋撻'], count: rand(3) },
      ].filter((d) => d.count > 0);

      const dp = solve({ coupons, singles, demand });
      const bf = bruteForceMinCost(coupons, singles, demand, 4);

      expect(dp.ok).toBe(true);
      expect(bf).toBeLessThan(Infinity); // 窮舉必須真的算得出來, 否則這輪什麼都沒驗到
      expect(dp.solution.totalCost, `第 ${t} 組: DP=${dp.solution.totalCost} 窮舉=${bf}`).toBe(bf);
    }
  });
});

describe('solve vs 獨立暴力窮舉 (真實肯德基資料)', () => {
  const dataPath = join(ROOT, 'web', 'solver_data.json');

  it('真實資料存在且非空', () => {
    expect(existsSync(dataPath),
      '缺少 web/solver_data.json — 先跑 gather.py 再跑 build_taxonomy.py').toBe(true);
    const data = JSON.parse(readFileSync(dataPath, 'utf-8'));
    expect(data.coupons.length).toBeGreaterThan(50);
    expect(data.singles.length).toBeGreaterThan(20);
  });

  it('真實券池的最低總價要跟窮舉一致', () => {
    const data = JSON.parse(readFileSync(dataPath, 'utf-8'));

    const pick = (kw) => Object.keys(data.items).filter((n) => n.includes(kw));
    const chicken = pick('脆雞');
    const tart = pick('蛋撻');
    expect(chicken.length).toBeGreaterThan(0);
    expect(tart.length).toBeGreaterThan(0);

    // 窮舉吃不下上百張券, 也吃不了太深 -> 縮小券池與需求, 讓兩邊都算得完
    const demand = [
      { label: '炸雞', names: chicken, count: 2 },
      { label: '蛋撻', names: tart, count: 1 },
    ];
    const wanted = new Set([...chicken, ...tart]);
    const relevant = data.coupons.filter((c) => c.slots.some((s) => s.options.some(
      (o) => o.parts.some((p) => wanted.has(p.item))))).slice(0, 8);
    const singles = data.singles.filter((s) => s.parts.some((p) => wanted.has(p.item)));

    expect(relevant.length).toBeGreaterThan(3);
    expect(singles.length).toBeGreaterThan(0);

    const dp = solve({ coupons: relevant, singles, demand });
    const bf = bruteForceMinCost(relevant, singles, demand, 3);

    expect(dp.ok).toBe(true);
    expect(bf).toBeLessThan(Infinity);
    expect(dp.solution.totalCost, `DP=${dp.solution.totalCost} 窮舉=${bf}`).toBe(bf);
  });
});

describe('solveWithAlternatives', () => {
  it('替代方案不會跟最佳解重複, 且都比較貴或相等', () => {
    const coupons = [
      coupon('A', 100, [slot('炸雞', 2, [['咔啦脆雞', 0]])]),
      coupon('B', 110, [slot('炸雞', 2, [['咔啦脆雞', 0]])]),
      coupon('C', 130, [slot('炸雞', 3, [['咔啦脆雞', 0]])]),
    ];
    const r = solveWithAlternatives({
      coupons, singles: SINGLES,
      demand: [{ label: '炸雞', names: ['咔啦脆雞'], count: 2 }],
    });
    expect(r.solution.totalCost).toBe(100);
    expect(r.alternatives.length).toBeGreaterThan(0);
    for (const alt of r.alternatives) {
      expect(alt.totalCost).toBeGreaterThanOrEqual(r.solution.totalCost);
      expect(alt.picks.some((p) => p.code === alt.withoutCode)).toBe(false);
    }
  });
});

describe('rankCouponsForItem — 單品項排行 (UI 現在用的)', () => {
  const CHICKEN = ['咔啦脆雞', '青花椒脆雞'];
  const TODAY = '2026-08-19'; // 一律注入, 絕不讀真實時鐘

  const rank = (coupons, opts = {}) => rankCouponsForItem({
    coupons, itemNames: CHICKEN, date: TODAY, ...opts,
  });

  it('依總價排序, 不是依每份單價', () => {
    // 每份單價會把多人份大套餐推到前面 (B 的 $52/塊最便宜), 但一個人點餐要的是 A
    const coupons = [
      coupon('A', 100, [slot('炸雞', 1, [['咔啦脆雞', 0]])]),   // $100 總價 / $100 一塊
      coupon('B', 260, [slot('炸雞', 5, [['咔啦脆雞', 0]])]),   // $260 總價 / $52 一塊
      coupon('C', 130, [slot('炸雞', 2, [['咔啦脆雞', 0]])]),   // $130 總價 / $65 一塊
    ];
    expect(rank(coupons).map((r) => r.code)).toEqual(['A', 'C', 'B']);
    expect(rank(coupons)[0].cost).toBe(100);
    expect(rank(coupons)[0].unitPrice).toBe(100);
  });

  it('總價相同時份數多的排前面', () => {
    const coupons = [
      coupon('少', 120, [slot('炸雞', 1, [['咔啦脆雞', 0]])]),
      coupon('多', 120, [slot('炸雞', 3, [['咔啦脆雞', 0]])]),
    ];
    expect(rank(coupons).map((r) => r.code)).toEqual(['多', '少']);
  });

  describe('預算上限', () => {
    const coupons = [
      coupon('A', 54, [slot('炸雞', 1, [['咔啦脆雞', 0]])]),
      coupon('B', 199, [slot('炸雞', 2, [['咔啦脆雞', 0]])]),
      coupon('C', 233, [slot('炸雞', 5, [['咔啦脆雞', 0]])]),
    ];

    it('超過預算的濾掉', () => {
      expect(rank(coupons, { maxPrice: 200 }).map((r) => r.code)).toEqual(['A', 'B']);
    });

    it('剛好等於預算的留著', () => {
      expect(rank(coupons, { maxPrice: 199 }).map((r) => r.code)).toEqual(['A', 'B']);
      expect(rank(coupons, { maxPrice: 198 }).map((r) => r.code)).toEqual(['A']);
    });

    it('沒設預算就不濾', () => {
      expect(rank(coupons).map((r) => r.code)).toEqual(['A', 'B', 'C']);
      expect(rank(coupons, { maxPrice: null }).map((r) => r.code)).toEqual(['A', 'B', 'C']);
    });

    it('價格下限: 「$200 以上」要濾掉便宜的', () => {
      expect(rank(coupons, { minPrice: 200 }).map((r) => r.code)).toEqual(['C']);
      expect(rank(coupons, { minPrice: 199 }).map((r) => r.code)).toEqual(['B', 'C']);
    });

    it('上下限可以同時用', () => {
      expect(rank(coupons, { minPrice: 100, maxPrice: 200 }).map((r) => r.code)).toEqual(['B']);
    });

    it('比的是實付金額, 不是券的底價', () => {
      // 底價 190, 但唯一含炸雞的選項要加價 20 -> 實付 210, 預算 200 應該擋下來
      const swap = coupon('SWAP', 190, [
        slot('主餐', 1, [['原味蛋撻', 0], ['咔啦脆雞', 20]]),
      ]);
      expect(rank([swap])[0].cost).toBe(210);
      expect(rank([swap], { maxPrice: 200 })).toHaveLength(0);
      expect(rank([swap], { maxPrice: 210 })).toHaveLength(1);
    });
  });

  it('不含該品項的券要排除, 不是排最後', () => {
    const coupons = [
      coupon('A', 100, [slot('炸雞', 1, [['咔啦脆雞', 0]])]),
      coupon('B', 30, [slot('蛋撻', 1, [['原味蛋撻', 0]])]),
    ];
    expect(rank(coupons).map((r) => r.code)).toEqual(['A']);
  });

  it('換口味的加價要算進總價與單價', () => {
    // 這張券預設是蛋撻, 換成炸雞要加 20 元 -> 總價 100 + 20×2 = 140, 單價 70
    const c = coupon('A', 100, [
      slot('主餐', 2, [['原味蛋撻', 0], ['咔啦脆雞', 20]]),
    ]);
    const [row] = rank([c]);
    expect(row.cost).toBe(140);
    expect(row.unitPrice).toBe(70);
    expect(row.addPrice).toBe(40);
  });

  it('口味組合取「含該品項且總價最低」那組, 不是單價最低那組', () => {
    // slot1 固定給 1 塊炸雞; slot2 可以再加 30 元多換 1 塊炸雞。
    // 單價最低是換 (130/2 = 65 < 100), 但總價最低是不換 (100)。
    // 排序主軸是總價 -> 要選不換那組, 卡片上的兩個數字才會描述同一種點法。
    const c = coupon('A', 100, [
      slot('炸雞', 1, [['咔啦脆雞', 0]]),
      slot('配餐', 1, [['原味蛋撻', 0], ['咔啦脆雞', 30]]),
    ]);
    const best = pickCheapestVariant(c, ['咔啦脆雞']);
    expect(best.cost).toBe(100);
    expect(best.count).toBe(1);
    expect(best.unitPrice).toBe(100);

    const [row] = rank([c]);
    expect(row.cost).toBe(100);
    expect(row.unitPrice).toBe(100);
    expect(row.extras).toEqual([{ name: '原味蛋撻', count: 1 }]);
  });

  it('總價相同時的口味組合取份數多的', () => {
    const c = coupon('A', 100, [
      slot('主餐', 1, [['原味蛋撻', 0], ['咔啦脆雞', 0]]),
      slot('配餐', 2, [['咔啦脆雞', 0]]),
    ]);
    const best = pickCheapestVariant(c, ['咔啦脆雞']);
    expect(best.cost).toBe(100);
    expect(best.count).toBe(3); // 兩個 slot 都拿炸雞, 不加價
  });

  it('一個選項含多份時單價要除對', () => {
    // 2 入裝 × slot 2 份 = 4 塊, $200 -> $50/塊
    const c = coupon('A', 200, [
      slot('炸雞', 2, [['2塊咔啦脆雞', 0, [{ item: '咔啦脆雞', qty: 2 }]]]),
    ]);
    const [row] = rank([c]);
    expect(row.count).toBe(4);
    expect(row.unitPrice).toBe(50);
  });

  it('內容相同的券只留總價最低的, 其餘變成備用代碼', () => {
    const mk = (code, price) => coupon(code, price, [slot('炸雞', 2, [['咔啦脆雞', 0]])]);
    const rows = rank([mk('A', 130), mk('B', 120), mk('C', 140)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe('B');
    expect(rows[0].sameCodes.map((s) => s.code)).toEqual(['A', 'C']); // 依價格排
    expect(rows[0].sameCodes.map((s) => s.price)).toEqual([130, 140]);
  });

  it('內容不同就不合併', () => {
    const rows = rank([
      coupon('A', 130, [slot('炸雞', 2, [['咔啦脆雞', 0]])]),
      coupon('B', 130, [slot('炸雞', 2, [['咔啦脆雞', 0]]), slot('蛋撻', 1, [['原味蛋撻', 0]])]),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.sameCodes.length === 0)).toBe(true);
  });

  it('分出「想要的」與「順便附的」, 配件不算', () => {
    const sauce = { name: '糖醋醬', add_price: 0, parts: [{ item: '糖醋醬', qty: 1 }], accessory: true };
    const c = coupon('A', 200, [
      slot('炸雞', 2, [['咔啦脆雞', 0]]),
      slot('蛋撻', 3, [['原味蛋撻', 0]]),
      { title: '其他', count: 1, options: [sauce] },
    ]);
    const [row] = rank([c]);
    expect(row.wantedItems).toEqual([{ name: '咔啦脆雞', count: 2 }]);
    expect(row.extras).toEqual([{ name: '原味蛋撻', count: 3 }]);
  });

  it('折扣率用文案原價算, 沒有原價就是 null 不用猜的', () => {
    const withList = { ...coupon('A', 75, [slot('炸雞', 1, [['咔啦脆雞', 0]])]), list_price: 100 };
    const noList = coupon('B', 75, [slot('炸雞', 1, [['咔啦脆雞', 0]])]);
    expect(rank([withList])[0].discount).toBeCloseTo(0.25);
    expect(rank([noList])[0].discount).toBeNull();
  });

  describe('只列當天可用的券', () => {
    const dated = (code, start, end) => ({
      ...coupon(code, 100, [slot('炸雞', 1, [['咔啦脆雞', 0]])]),
      start_date: start, end_date: end,
    });

    it('已過期的排除', () => {
      const rows = rank([dated('OLD', '2026-01-01', '2026-08-18')]);
      expect(rows).toHaveLength(0);
    });

    it('還沒開賣的排除', () => {
      const rows = rank([dated('SOON', '2026-08-20', '2026-12-31')]);
      expect(rows).toHaveLength(0);
    });

    it('到期當天仍然算可用', () => {
      const rows = rank([dated('LAST', '2026-01-01', '2026-08-19')]);
      expect(rows.map((r) => r.code)).toEqual(['LAST']);
    });

    it('餐期不符的排除', () => {
      const breakfast = {
        ...coupon('BF', 100, [slot('炸雞', 1, [['咔啦脆雞', 0]])]),
        meal_periods: [1],
      };
      expect(rank([breakfast], { mealPeriod: 2 })).toHaveLength(0);
      expect(rank([breakfast], { mealPeriod: 1 }).map((r) => r.code)).toEqual(['BF']);
      expect(rank([breakfast], { mealPeriod: null }).map((r) => r.code)).toEqual(['BF']);
    });
  });

  it('limit 生效', () => {
    // 內容要各不相同, 否則會先被去重合併掉 (那是另一條規則)
    const coupons = [1, 2, 3, 4, 5].map((i) =>
      coupon(`C${i}`, 100 * i, [slot('炸雞', i, [['咔啦脆雞', 0]])]));
    expect(rank(coupons)).toHaveLength(5);
    expect(rank(coupons, { limit: 3 })).toHaveLength(3);
  });

  it('關鍵字對不到任何品項時回空陣列', () => {
    const c = coupon('A', 100, [slot('炸雞', 1, [['咔啦脆雞', 0]])]);
    expect(rankCouponsForItem({ coupons: [c], itemNames: [], date: TODAY })).toEqual([]);
  });
});

describe('rankCouponsForItem — 真實肯德基資料', () => {
  const dataPath = join(ROOT, 'web', 'solver_data.json');

  const DATE = '2026-08-19';

  it('炸雞排行的每一筆都要自洽', () => {
    const data = JSON.parse(readFileSync(dataPath, 'utf-8'));
    const chicken = Object.keys(data.items).filter((n) => n.includes('脆雞'));
    expect(chicken.length).toBeGreaterThan(3);

    const rows = rankCouponsForItem({
      coupons: data.coupons, itemNames: chicken, date: DATE, mealPeriod: 2,
      maxPrice: 200, limit: 10,
    });
    expect(rows.length).toBeGreaterThan(3);

    const seenSig = new Set();
    let prev = -Infinity;
    for (const r of rows) {
      expect(r.count).toBeGreaterThan(0);
      expect(r.unitPrice).toBeCloseTo(r.cost / r.count);   // 單價確實是總價除份數
      expect(r.cost).toBeGreaterThanOrEqual(prev);         // 總價遞增排序
      prev = r.cost;
      expect(r.cost).toBeLessThanOrEqual(200);             // 預算內
      expect(r.endDate >= DATE).toBe(true);                // 沒有過期的
      expect(r.coupon.meal_periods).toContain(2);          // 餐期符合
      expect(r.wantedItems.length).toBeGreaterThan(0);     // 真的含炸雞
      const sig = couponSignature(r.coupon);
      expect(seenSig.has(sig)).toBe(false);                // 內容不重複
      seenSig.add(sig);
      if (r.listPrice) expect(r.listPrice).toBeGreaterThan(0);
    }
  });

  it('四段價格帶互斥, 每段給的是不同的券', () => {
    const data = JSON.parse(readFileSync(dataPath, 'utf-8'));
    const bands = [
      { label: '$100 以下', min: null, max: 100 },
      { label: '$101~150', min: 101, max: 150 },
      { label: '$151~200', min: 151, max: 200 },
      { label: '$201 以上', min: 201, max: null },
    ];
    const match = (kw) => Object.entries(data.items)
      .filter(([n, v]) => n.includes(kw) || (v.categories || []).some((c) => c.includes(kw)))
      .map(([n]) => n);

    for (const kw of ['堡', '炸雞', '蛋撻', '飲料']) {
      const names = match(kw);
      const seen = new Set();
      for (const b of bands) {
        const rows = rankCouponsForItem({
          coupons: data.coupons, itemNames: names, date: DATE, mealPeriod: 2,
          minPrice: b.min, maxPrice: b.max, limit: 3,
        });
        expect(rows.length, `「${kw}」${b.label} 沒有任何券`).toBeGreaterThan(0);
        for (const r of rows) {
          if (b.min != null) expect(r.cost).toBeGreaterThanOrEqual(b.min);
          if (b.max != null) expect(r.cost).toBeLessThanOrEqual(b.max);
          // 互斥 -> 同一張券不可能出現在兩段裡
          expect(seen.has(r.code), `${r.code} 同時出現在兩個價格帶`).toBe(false);
          seen.add(r.code);
        }
      }
    }
  });

  it('多選是聯集: 含堡或炸雞的券排在同一張榜, 而且真的混在一起', () => {
    const data = JSON.parse(readFileSync(dataPath, 'utf-8'));
    const match = (kw) => new Set(Object.entries(data.items)
      .filter(([n, v]) => n.includes(kw) || (v.categories || []).some((c) => c.includes(kw)))
      .map(([n]) => n));
    const burger = match('堡');
    const chicken = match('炸雞');

    const rows = rankCouponsForItem({
      coupons: data.coupons, itemNames: [...new Set([...burger, ...chicken])],
      date: DATE, mealPeriod: 2, maxPrice: 100, limit: 6,
    });
    expect(rows.length).toBeGreaterThan(3);

    const hit = (r, set) => r.wantedItems.some((i) => set.has(i.name));
    expect(rows.some((r) => hit(r, burger)), '榜上沒有任何堡').toBe(true);
    expect(rows.some((r) => hit(r, chicken)), '榜上沒有任何炸雞').toBe(true);
    // 每一筆至少命中一組, 不會有莫名其妙混進來的
    for (const r of rows) expect(hit(r, burger) || hit(r, chicken)).toBe(true);
  });

  it('預算會真的改變結果, 不是裝飾', () => {
    const data = JSON.parse(readFileSync(dataPath, 'utf-8'));
    const chicken = Object.keys(data.items).filter((n) => n.includes('脆雞'));
    const q = (maxPrice) => rankCouponsForItem({
      coupons: data.coupons, itemNames: chicken, date: DATE, mealPeriod: 2, maxPrice, limit: 3,
    });
    const tight = q(200);
    const loose = q(null);
    expect(tight[0].cost).toBeLessThanOrEqual(200);
    expect(loose.length).toBeGreaterThan(0);
    // 不設上限時最便宜的那張仍然是同一張 (總價排序), 但券池變大
    expect(loose[0].code).toBe(tight[0].code);
    expect(q(30)).toHaveLength(0); // 低到不可能有券
  });

  it('四個快捷關鍵字都要對得到品項, 而且分類要乾淨', () => {
    const data = JSON.parse(readFileSync(dataPath, 'utf-8'));
    // 跟 web/app.js 的 matchItems 同一套規則
    const match = (kw) => Object.entries(data.items)
      .filter(([n, v]) => n.includes(kw) || (v.categories || []).some((c) => c.includes(kw)))
      .map(([n]) => n);

    for (const kw of ['堡', '炸雞', '蛋撻', '飲料']) {
      const hits = match(kw);
      expect(hits.length, `「${kw}」一個品項都對不到`).toBeGreaterThan(0);
      const rows = rankCouponsForItem({
        coupons: data.coupons, itemNames: hits, date: DATE, mealPeriod: 2, maxPrice: 200, limit: 3,
      });
      expect(rows.length, `「${kw}」$200 以內找不到券`).toBeGreaterThan(0);
    }

    // 單品菜單有「點心/飲料」這種合併大類, 用它做比對會把炸雞、雞塊算成飲料
    const drinks = match('飲料');
    for (const bad of ['咔啦脆雞', '上校雞塊', '青花椒雞塊', '雞汁風味飯']) {
      expect(drinks, `「飲料」不該對到 ${bad}`).not.toContain(bad);
    }
  });

  it('pickCheapestVariant 對已知的券算出已知的數字', () => {
    const data = JSON.parse(readFileSync(dataPath, 'utf-8'));
    // 16453 開學季26A: 官方文案「2塊咔啦脆雞+【點心盒E:2顆原味蛋撻】=NT$147元」
    const c = data.coupons.find((x) => x.code === '16453');
    expect(c, '資料裡找不到 16453，換一張已知的券').toBeTruthy();
    expect(c.price).toBe(147);

    const chicken = Object.keys(data.items).filter((n) => n.includes('咔啦脆雞'));
    const best = pickCheapestVariant(c, chicken);
    expect(best.cost).toBe(147);
    expect(best.count).toBe(2);                 // 2 塊咔啦脆雞
    expect(best.unitPrice).toBeCloseTo(73.5);   // 147 / 2

    const tart = Object.keys(data.items).filter((n) => n.includes('蛋撻'));
    const bestTart = pickCheapestVariant(c, tart);
    expect(bestTart.count).toBe(2);             // 點心盒 E 是 2 顆, 不是 1 份
    expect(bestTart.unitPrice).toBeCloseTo(73.5);
  });
});

describe('isCouponUsable — 日期一律注入, 絕不讀真實時鐘', () => {
  const c = { code: 'A', start_date: '2026-07-22', end_date: '2026-09-30', meal_periods: [2, 3] };

  it('效期內', () => expect(isCouponUsable(c, { date: '2026-08-19' })).toBe(true));
  it('開始前一天', () => expect(isCouponUsable(c, { date: '2026-07-21' })).toBe(false));
  it('開始當天', () => expect(isCouponUsable(c, { date: '2026-07-22' })).toBe(true));
  it('結束當天', () => expect(isCouponUsable(c, { date: '2026-09-30' })).toBe(true));
  it('結束隔天', () => expect(isCouponUsable(c, { date: '2026-10-01' })).toBe(false));
  it('餐期不符', () => expect(isCouponUsable(c, { date: '2026-08-19', mealPeriod: 1 })).toBe(false));
  it('餐期相符', () => expect(isCouponUsable(c, { date: '2026-08-19', mealPeriod: 3 })).toBe(true));
});
