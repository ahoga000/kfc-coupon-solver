"""把 coupons.json 正規化成前端要用的 data/solver_data.json。

要解決三件從真實資料裡冒出來的事:

1. 券裡的品名跟單品菜單對不上 (75 個名字有 41 個對不上)
   例: 券寫「咔啦脆雞(辣)」, 菜單寫「咔啦脆雞」; 券寫「無糖綠茶(小)」, 菜單寫「冰無糖綠茶(小)」

2. 有些選項一份不只一個
   例: 「2入原味蛋撻超極酥」是 2 顆, 「上校雞塊8塊」是 8 塊。當成 1 份會少算。

3. 有些選項根本不是餐點
   例: 「不需刀叉及手套」「響應環保不需湯匙」。這些不該混進「你會多拿到什麼」。

分類一律沿用肯德基自己的 slot Title (炸雞/蛋撻/漢堡/飲料/配餐/主餐/烤雞/其他)
與菜單分類, 不自己發明類別。品名不同的產品也維持不同 —— 「原味蛋撻超極酥」和
「原味蛋撻」是兩個東西, 要不要視為同一類由使用者搜尋時自己決定。

跑法:
    py -3.10 -u scripts/build_taxonomy.py
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from intro_price import reconcile  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data'
IN_PATH = DATA / 'coupons.json'
CAT_PATH = DATA / 'menu_categories.json'
# 輸出放 web/ 讓整個 web 目錄自成一包 (直接丟靜態主機就能跑)
OUT_PATH = ROOT / 'web' / 'solver_data.json'
AUDIT_PATH = DATA / 'taxonomy_audit.txt'

SPICY_RE = re.compile(r'[（(](?:不辣|辣)[）)]\s*$')
LEAD_QTY_RE = re.compile(r'^(\d+)\s*[入顆塊杯份]\s*')
TAIL_QTY_RE = re.compile(r'(\d+)\s*[入顆塊杯份]\s*$')

# 內容無法從名字推斷的組合品, 不放進「可單點」的池子裡, 免得把它當成 1 份主餐低估數量
BUNDLE_WORDS = ('全明星餐', '分享餐', '雙人餐', '買1送1', '套餐', '3人份', '禮盒')

# slot Title 已經是肯德基自己的分類, 這裡只多擋一層明顯的非餐點字樣
NON_FOOD_RE = re.compile(r'刀叉|湯匙|手套|吸管|響應環保|不需|袋子|提袋')


def strip_spicy(name: str) -> str:
    return SPICY_RE.sub('', name).strip()


def _parse_one(chunk: str) -> dict | None:
    """單一品項: 抽出前置或後置的份數, 回傳 {item, qty}。"""
    chunk = chunk.strip()
    if not chunk:
        return None
    # 「升級」是加購動作不是品名的一部分。券裡寫「升級青花椒香麻沾醬(小)」,
    # 單品菜單寫「青花椒香麻沾醬(小)」—— 不剝掉就認不出這兩個是同一個東西,
    # 於是醬料逃過配件判定, 被當成可以拿來充數的「飲料」。
    if chunk.startswith('升級'):
        chunk = chunk[2:].strip()
    qty = 1
    m = LEAD_QTY_RE.match(chunk)
    if m:
        qty = int(m.group(1))
        chunk = LEAD_QTY_RE.sub('', chunk).strip()
    else:
        base = strip_spicy(chunk)
        m = TAIL_QTY_RE.search(base)
        if m:
            qty = int(m.group(1))
            suffix = chunk[len(base):]           # 保留原本的辣度後綴
            chunk = (TAIL_QTY_RE.sub('', base).strip() + suffix).strip()
    return {'item': chunk, 'qty': qty} if chunk else None


def parse_parts(name: str) -> list[dict]:
    """把選項名稱拆成 [{item, qty}]。

    '+' 不能無條件當成分隔符 —— 促銷名稱本身就會用它 ('A+B=$49'、'1原+1青花椒花生')。
    只有在拆出來「每一塊都像個品項」時才採信這個拆法, 否則整串當成單一品項。
    """
    text = name.strip()
    if text.startswith('(') and text.endswith(')'):
        text = text[1:-1].strip()

    whole = _parse_one(text)
    if '+' not in text or '=' in text or '$' in text:
        return [whole] if whole else [{'item': text, 'qty': 1}]

    chunks = [c for c in re.split(r'\s*\+\s*', text) if c.strip()]
    parsed = [_parse_one(c) for c in chunks]
    if len(parsed) >= 2 and all(p and len(p['item']) >= 3 for p in parsed):
        return parsed
    return [whole] if whole else [{'item': text, 'qty': 1}]


SIZE_RE = re.compile(r'[（(][小中大][）)]\s*$')
PACK_RE = re.compile(r'\d+\s*[入顆塊杯份]')


def _safe_container(item: str, candidate: str) -> bool:
    """candidate 能不能拿來當 item 的價格?

    不行的情況:
      - 多出來的字帶了份數:「上校雞塊」配到「上校雞塊4塊」= 拿 4 塊的價當 1 塊
      - 多出來的字是組合餐:「青花椒香麻咔啦雞腿堡」配到「...雙人餐」
      - candidate 本身是組合品:「上校雞塊」配到「點心盒-上校雞塊+香酥脆薯(小) $67」
        —— 那是含薯條的點心盒價, 拿來當一塊雞塊的價, 8 塊就算成 $536 (真值 $133)

    這三種錯都不會報錯, 只會把原價默默灌水, 所以寧可查不到價也不要猜錯。
    """
    if '+' in candidate or '盒' in candidate:
        return False
    rest = candidate.replace(item, '', 1)
    if PACK_RE.search(rest):
        return False
    if any(w in rest for w in BUNDLE_WORDS):
        return False
    return True


def match_price(name: str, singles: dict[str, int]) -> tuple[int | None, str]:
    """回傳 (價格, 比對方法)。方法要記下來, 之後才查得出哪些價格是猜的。"""
    if name in singles:
        return singles[name], 'exact'

    bare = strip_spicy(name)
    if bare in singles:
        return singles[bare], 'strip-spicy'
    for suffix in ('(不辣)', '(辣)'):
        if bare + suffix in singles:
            return singles[bare + suffix], 'add-spicy'

    no_size = SIZE_RE.sub('', bare).strip()
    if no_size != bare and no_size in singles:
        return singles[no_size], 'strip-size'

    if bare:
        contains = sorted(
            (s for s in singles if bare in s and _safe_container(bare, s)), key=len)
        if contains:
            return singles[contains[0]], f'substring:{contains[0]}'

    return None, 'none'


def main() -> int:
    global OUT_PATH
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', help='輸出路徑 (預設 web/solver_data.json)。'
                                  '每日流程會先輸出到暫存檔, 過了 publish_guard 才覆蓋正式檔')
    args = ap.parse_args()
    if args.out:
        OUT_PATH = Path(args.out)

    if not IN_PATH.exists():
        print(f'缺少 {IN_PATH}, 先跑 gather.py')
        return 1
    data = json.loads(IN_PATH.read_text(encoding='utf-8'))
    singles_price: dict[str, int] = data['singles']
    coupons = data['coupons']

    menu_cat: dict[str, str] = {}
    if CAT_PATH.exists():
        menu_cat = json.loads(CAT_PATH.read_text(encoding='utf-8'))['categories']
    else:
        print(f'(沒有 {CAT_PATH.name}, 單品分類會留空 — 先跑 fetch_menu_categories.py)')

    # --- 券: 每個選項補上 parts / accessory ---
    # 分類只採用券裡的 slot Title (炸雞/蛋撻/漢堡/飲料/配餐/主餐/烤雞)。
    #
    # 單品菜單也有分類, 但那是「點心/飲料」這種合併大類, 拿來做關鍵字比對會把
    # 炸雞、薯條、雞塊全算成飲料。而且沒出現在任何券裡的品項本來就影響不了排行
    # (排行是在券上跑的), 讓它們帶著粗分類只會把「理解成這 N 個品項」撐長而已。
    # 這些品項仍然可以用品名搜到。
    slot_categories: dict[str, set] = {}
    all_items: set[str] = set()
    unmatched: dict[str, int] = {}
    out_coupons = []
    # 肯德基在券裡把刀叉、湯匙、沾醬歸在「其他」。同一個東西在單品菜單卻是「點心/飲料」,
    # 不擋掉的話搜「飲料」會把沾醬也算成飲料 (實測就被 $12 沾醬拿去充一杯飲料)。
    accessory_items: set[str] = set()

    for c in coupons:
        # 券價對帳在這裡重算一次: 解析規則改過之後不必為了一個衍生欄位重跑 25 分鐘的抓取
        c = {**c}
        c['price_check'], c['list_price'] = reconcile(c['price'], c.get('intro', ''))
        slots = []
        for slot in c['slots']:
            title = slot.get('title') or ''
            options = []
            for opt in slot['options']:
                name = opt['name']
                accessory = title == '其他' or bool(NON_FOOD_RE.search(name))
                parts = parse_parts(name)
                for p in parts:
                    if accessory:
                        accessory_items.add(p['item'])
                        continue
                    all_items.add(p['item'])
                    if title:
                        # 同時登記去辣度後的名字: 券裡寫「咔啦脆雞(辣)」, 單品菜單寫
                        # 「咔啦脆雞」, 不共用分類的話後者會退回粗分類「點心/飲料」,
                        # 於是搜「飲料」把炸雞也算進去
                        slot_categories.setdefault(p['item'], set()).add(title)
                        slot_categories.setdefault(strip_spicy(p['item']), set()).add(title)
                options.append({
                    'name': name,
                    'add_price': opt['add_price'],
                    'parts': parts,
                    'accessory': accessory,
                })
            slots.append({'title': title, 'count': slot['count'], 'options': options})
        out_coupons.append({**c, 'slots': slots})

    # --- 單品: 也拆 parts, 讓「咔啦脆雞2塊 $124」能贏過「咔啦脆雞 ×2 = $142」---
    purchasable = []
    excluded_bundles = []
    for name, price in sorted(singles_price.items()):
        if any(w in name for w in BUNDLE_WORDS):
            excluded_bundles.append(name)
            continue
        if NON_FOOD_RE.search(name):
            continue
        parts = parse_parts(name)
        if any(p['item'] in accessory_items for p in parts):
            continue
        cat = menu_cat.get(name, '')
        all_items.update(p['item'] for p in parts)
        purchasable.append({'name': name, 'price': price, 'parts': parts, 'category': cat})

    # --- 品項登錄表: 每個 canonical item 的參考單價與分類 ---
    items = {}
    for item in sorted(all_items):
        price, method = match_price(item, singles_price)
        if price is None:
            unmatched[item] = unmatched.get(item, 0) + 1
        # 辣度變體共用分類 (券寫「咔啦脆雞(辣)」, 菜單寫「咔啦脆雞」)
        cats = slot_categories.get(item) or slot_categories.get(strip_spicy(item)) or set()
        items[item] = {
            'price': price,
            'price_method': method,
            'categories': sorted(cats),
        }

    OUT_PATH.write_text(json.dumps({
        'fetched_at': data['fetched_at'],
        'shop_code': data['shop_code'],
        'shop_name': data.get('shop_name'),
        'items': items,
        'singles': purchasable,
        'coupons': out_coupons,
        # 手機要下載這個檔, 不留縮排 (要看內容去讀 data/coupons.json, 那份有排版)
    }, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')

    # --- 稽核報告: 沒對上的一定要看得見, 不可以靜默當成沒事 ---
    exact = sum(1 for v in items.values() if v['price_method'] == 'exact')
    guessed = sorted(
        ((k, v['price_method']) for k, v in items.items() if v['price_method'].startswith('substring')),
        key=lambda kv: kv[0])
    mismatched = [c for c in out_coupons if c['price_check'].startswith('mismatch')]
    lines = [
        f'券總數: {len(out_coupons)}',
        f'  券價兩條路徑一致 : {sum(1 for c in out_coupons if c["price_check"] == "match")}',
        f'  文案沒寫價格     : {sum(1 for c in out_coupons if c["price_check"] == "unparsed")}',
        f'  兩條路徑不一致   : {len(mismatched)}   <-- 有的話要查, 不可以直接採信公式價',
        '',
        f'品項總數: {len(items)}',
        f'  價格精確對上   : {exact}',
        f'  去辣度/尺寸後對上: {sum(1 for v in items.values() if v["price_method"] in ("strip-spicy", "add-spicy", "strip-size"))}',
        f'  用包含關係猜的 : {len(guessed)}   <-- 這些是猜的, 要人眼看過',
        f'  查不到價格     : {len(unmatched)}',
        '',
        f'可單點品項: {len(purchasable)} (排除無法拆解內容的組合品 {len(excluded_bundles)} 個, '
        f'排除肯德基歸在「其他」的配件 {len(accessory_items)} 種)',
        f'  配件: {sorted(accessory_items)}',
        '',
        '--- 用包含關係猜出價格的 (前 40) ---',
    ]
    lines += [f'  {k!r}  ->  {m}' for k, m in guessed[:40]]
    lines += ['', '--- 查不到價格的 (前 40) ---']
    lines += [f'  {k!r}' for k in sorted(unmatched)[:40]]
    lines += ['', '--- 券價兩條路徑不一致的 ---']
    lines += [f'  [{c["code"]}] {c["name"]}: {c["price_check"]}\n      {c["intro"]!r}'
              for c in mismatched]
    lines += ['', '--- 排除的組合品 ---']
    lines += [f'  {n!r}' for n in excluded_bundles]
    AUDIT_PATH.write_text('\n'.join(lines) + '\n', encoding='utf-8')

    print('\n'.join(lines[:9]))
    print(f'\n已寫入 {OUT_PATH}')
    print(f'稽核報告 {AUDIT_PATH}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
