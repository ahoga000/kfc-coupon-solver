"""把種子代碼打成 data/coupons.json (前端唯一的資料來源)。

價格模型 (由 spike 實測 + 對帳確認):
    券底價 = Original_Price + Σ_slot (預設選項 MListPrice × MinCount)
    換口味 = 該選項的 AddPrice × MinCount   (預設選項的 AddPrice 恆為 0)

同一份資料有兩條獨立路徑可以得到券價 —— 上面的公式, 以及官方文案 Intro 裡的
「=NT$499元(原價$813)」。兩條路徑一律對帳, 不一致就標記出來, 不靜默採信任一邊。

跑法:
    py -3.10 -u scripts/gather.py              # 續跑, 跳過已知無效碼
    py -3.10 -u scripts/gather.py --recheck    # 連無效碼一起重驗
    py -3.10 -u scripts/gather.py --limit 50   # 只跑前 50 個 (煙霧測試)
"""
import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

from intro_price import reconcile
from kfc_api import (
    DEFAULT_SHOP_CODE, ORDER_TYPE, BlockedError, KfcApi, failover_configs, now_iso, today_str,
)

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data'
SEED_PATH = DATA / 'seed_codes.txt'
INVALID_PATH = DATA / 'invalid_codes.txt'
OUT_PATH = DATA / 'coupons.json'

SAVE_EVERY = 25


def read_codes(path: Path) -> list[str]:
    if not path.exists():
        return []
    return [
        line.strip() for line in path.read_text(encoding='utf-8').splitlines()
        if line.strip() and not line.startswith('#')
    ]


def parse_date(dt: str) -> str:
    return datetime.strptime(dt, '%Y/%m/%d %H:%M:%S').strftime('%Y-%m-%d')


def build_coupon(code: str, detail: dict, periods: list[int]) -> dict:
    price = detail['Original_Price']
    slots = []
    for slot in detail['Details']:
        options = slot['MList']
        if not options:
            continue
        count = slot['MinCount']
        price += options[0]['MListPrice'] * count
        slots.append({
            'title': slot.get('Title', ''),
            'count': count,
            'options': [
                {'name': opt['Name'].strip(), 'add_price': opt['AddPrice']}
                for opt in options
            ],
        })

    intro = (detail.get('Intro') or '').strip()
    price_check, list_price = reconcile(price, intro)

    name = detail['Name'].strip()
    if name.startswith(f'{code}-'):
        name = name[len(code) + 1:]

    return {
        'code': code,
        'name': name,
        'price': price,
        'list_price': list_price,
        'price_check': price_check,
        'intro': intro,
        'notes': (detail.get('Nutrition') or '').strip(),
        'start_date': parse_date(detail['StartDate']),
        'end_date': parse_date(detail['EndDate']),
        'meal_periods': periods,
        'slots': slots,
    }


def fetch_singles(api: KfcApi) -> dict[str, int]:
    """單品原價表, 給「單點當虛擬券」與省錢基準用。"""
    singles: dict[str, int] = {}
    for menu_id, title in api.menu_ids():
        foods = api.menu_foods(menu_id)
        for food in foods:
            if '套餐' in (food.get('Title') or ''):
                continue
            for d in food.get('Details', []):
                name = (d.get('Name') or '').strip()
                price = d.get('Upa_Group')
                if name and isinstance(price, int) and price > 0:
                    singles.setdefault(name, price)
        print(f'  菜單 {menu_id} {title!r} -> 累計 {len(singles)} 個單品')
    return singles


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--recheck', action='store_true', help='連已知無效碼一起重驗')
    ap.add_argument('--limit', type=int, default=0, help='只跑前 N 個候選碼')
    ap.add_argument('--codes', default='', help='只驗指定代碼 (逗號分隔), 用來反驗管線')
    args = ap.parse_args()

    if args.codes:
        seeds = [c.strip() for c in args.codes.split(',') if c.strip()]
    else:
        seeds = read_codes(SEED_PATH)
    if not seeds:
        print(f'{SEED_PATH} 是空的, 先跑 collect_seeds.py')
        return 1

    invalid = set() if (args.recheck or args.codes) else set(read_codes(INVALID_PATH))
    todo = [c for c in seeds if c not in invalid]
    if args.limit:
        todo = todo[:args.limit]

    print(f'候選 {len(seeds)} 個, 已知無效 {len(invalid)} 個, 這次要驗 {len(todo)} 個')

    # 依序試 (門市, orderType), 第一個查得到門市資訊的就用
    api = shop = None
    for shop_code, order_type in failover_configs():
        candidate = KfcApi(shop_code=shop_code, order_type=order_type)
        try:
            info = candidate.shop_info()
        except BlockedError as e:
            print(f'被擋了: {e}')
            print('換門市救不了 IP 層級的封鎖 —— 放棄本次抓取, 保留既有資料')
            return 2
        except Exception as e:
            print(f'  {shop_code}/orderType={order_type} 失敗: {type(e).__name__}: {e}')
            continue
        if info:
            api, shop = candidate, info
            break
        print(f'  {shop_code}/orderType={order_type} 查不到門市, 換下一組')

    if not api:
        print('所有備援門市都試過了還是不行, 中止')
        return 1
    tag = '' if api.shop_code == DEFAULT_SHOP_CODE and api.order_type == ORDER_TYPE else '  <-- 用的是備援'
    print(f"門市: {shop.get('ShopCode')} {shop.get('ShopName')}  orderType={api.order_type}{tag}")

    print('\n抓單品原價表...')
    singles = fetch_singles(api)
    print(f'單品共 {len(singles)} 項')

    order_date = today_str()
    coupons: list[dict] = []
    new_invalid: list[str] = []

    def save():
        OUT_PATH.write_text(json.dumps({
            'fetched_at': now_iso(),
            'shop_code': api.shop_code,
            'shop_name': shop.get('ShopName'),
            'order_type': api.order_type,
            'singles': singles,
            'coupons': sorted(coupons, key=lambda c: c['price']),
        }, ensure_ascii=False, indent=1), encoding='utf-8')
        if new_invalid and not args.codes:  # 反驗模式不要污染無效碼清單
            # 合併去重後整份重寫, 不能用 append —— --recheck 會把既有的無效碼
            # 再驗一次再寫一次, 每跑一輪檔案就長一倍
            merged = sorted(set(read_codes(INVALID_PATH)) | set(new_invalid))
            INVALID_PATH.write_text('\n'.join(merged) + '\n', encoding='utf-8')
            new_invalid.clear()

    print(f'\n開始驗證 {len(todo)} 個代碼...')
    for i, code in enumerate(todo, 1):
        try:
            product_code, msg = api.voucher_product_code(code)
            if not product_code:
                new_invalid.append(code)
                continue

            periods = api.valid_meal_periods(code, order_date)
            if not periods:
                new_invalid.append(code)
                continue

            detail_data, usable = api.food_detail(product_code, periods, order_date)
            if not detail_data or not usable:
                new_invalid.append(code)
                continue

            fd = detail_data.get('FoodDetail') or []
            if len(fd) != 1:
                print(f'  [{code}] FoodDetail 格式非預期 (len={len(fd)}), 跳過')
                new_invalid.append(code)
                continue

            coupon = build_coupon(code, fd[0], usable)
            coupons.append(coupon)
            flag = '' if coupon['price_check'] == 'match' else f"  <-- {coupon['price_check']}"
            print(f"  ✓ [{code}] ${coupon['price']:<5} {coupon['name']}{flag}")

        except BlockedError as e:
            # 被擋了就別再打了 —— 繼續打只會讓情況更糟, 而且抓到的資料也不完整
            print(f'\n!! 被擋: {e}')
            print(f'!! 已驗 {i}/{len(todo)} 個, 有效 {len(coupons)} 張。中止本次抓取。')
            save()
            return 2
        except Exception as e:
            print(f'  ! [{code}] {type(e).__name__}: {e}')

        if i % SAVE_EVERY == 0:
            save()
            print(f'  --- 進度 {i}/{len(todo)}, 有效 {len(coupons)} 張, API 呼叫 {api.calls} 次 ---')

    save()

    mismatches = [c for c in coupons if c['price_check'].startswith('mismatch')]
    unparsed = [c for c in coupons if c['price_check'] == 'unparsed']
    print(f'\n完成: 有效券 {len(coupons)} 張, API 呼叫 {api.calls} 次')
    print(f'價格對帳: 一致 {len(coupons) - len(mismatches) - len(unparsed)} / '
          f'不一致 {len(mismatches)} / 文案無價格 {len(unparsed)}')
    for c in mismatches[:10]:
        print(f'  不一致 [{c["code"]}] {c["name"]}: {c["price_check"]}')
    print(f'已寫入 {OUT_PATH}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
