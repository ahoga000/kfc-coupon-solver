"""偵察: 找出可用的備援門市, 並確認換門市/換 orderType 會不會影響券的內容。

這是一次性的調查腳本, 不進每日流程。目的是回答三個問題:
  1. 有哪些店號可以用 (主店掛掉時要切哪一個)
  2. 換一間店抓到的券一不一樣 (不一樣的話「備援門市」就不是單純的備援)
  3. orderType 1/2/3 有沒有差

跑法:
    py -3.10 -u scripts/probe_shops.py            # 掃店號
    py -3.10 -u scripts/probe_shops.py --compare  # 比對門市與 orderType
"""
import argparse
import json
import sys
from pathlib import Path

from kfc_api import KfcApi, today_str

OUT = Path(__file__).resolve().parent.parent / 'data' / 'shops.json'


def scan(prefix: str, lo: int, hi: int) -> list[dict]:
    api = KfcApi()
    found = []
    for n in range(lo, hi + 1):
        code = f'{prefix}{n:03d}'
        api.shop_code = code
        try:
            info = api.shop_info()
        except Exception as e:
            print(f'  ! {code} {type(e).__name__}: {e}')
            continue
        if info:
            found.append({
                'code': info.get('ShopCode'),
                'name': info.get('ShopName'),
                'city': info.get('CityName'),
                'area': info.get('AreaName'),
                'breakfast': info.get('IsBreakfast'),
                'opening': info.get('OpeningTime'),
            })
            print(f'  ✓ {code}  {info.get("CityName")}{info.get("AreaName")}  {info.get("ShopName")}')
        if n % 25 == 0:
            print(f'  --- {code} 掃到這, 有效 {len(found)} 間, API {api.calls} 次 ---')
    return found


def coupon_fingerprint(api: KfcApi, codes: list[str]) -> dict:
    """在指定門市抓幾張券, 回傳 {代碼: (券價, 品項字串)} 當指紋。"""
    date = today_str()
    out = {}
    for code in codes:
        try:
            product_code, msg = api.voucher_product_code(code)
            if not product_code:
                out[code] = ('無效', msg)
                continue
            periods = api.valid_meal_periods(code, date)
            if not periods:
                out[code] = ('無效', '所有餐期都不行')
                continue
            detail, usable = api.food_detail(product_code, periods, date)
            if not detail:
                out[code] = ('無效', '拿不到內容')
                continue
            fd = detail['FoodDetail'][0]
            price = fd['Original_Price']
            items = []
            for slot in fd['Details']:
                m = slot['MList'][0]
                price += m['MListPrice'] * slot['MinCount']
                items.append(f'{m["Name"]}x{slot["MinCount"]}')
            out[code] = (price, '、'.join(items))
        except Exception as e:
            out[code] = ('錯誤', f'{type(e).__name__}: {e}')
    return out


def compare(shop_codes: list[str], coupon_codes: list[str]) -> None:
    print('=== 不同門市抓到的券一不一樣 ===')
    results = {}
    for shop in shop_codes:
        api = KfcApi(shop_code=shop)
        info = api.shop_info()
        if not info:
            print(f'  {shop}: 門市無效, 跳過')
            continue
        print(f'\n  [{shop}] {info.get("ShopName")}')
        results[shop] = coupon_fingerprint(api, coupon_codes)
        for c, (price, items) in results[shop].items():
            print(f'    {c}: {price}  {items[:70]}')

    if len(results) >= 2:
        shops = list(results)
        base = results[shops[0]]
        print('\n  --- 與第一間比對 ---')
        for other in shops[1:]:
            diff = [c for c in coupon_codes
                    if base.get(c) != results[other].get(c)]
            print(f'    {shops[0]} vs {other}: '
                  + (f'{len(diff)} 張不同 -> {diff}' if diff else '完全相同'))

    print('\n=== orderType 1/2/3 有沒有差 (用第一間門市) ===')
    # orderType 一定要用建構子參數傳 —— 改模組全域是沒用的 (預設值在函式定義時就綁死了),
    # 那樣會變成同一個 orderType 測三次還顯示成功
    for ot in ('1', '2', '3'):
        api = KfcApi(shop_code=shop_codes[0], order_type=ot)
        fp = coupon_fingerprint(api, coupon_codes[:2])
        print(f'  orderType={ot}: ' + ' | '.join(f'{c}={v[0]}' for c, v in fp.items()))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--compare', action='store_true')
    ap.add_argument('--prefix', default='TWI')
    ap.add_argument('--lo', type=int, default=1)
    ap.add_argument('--hi', type=int, default=250)
    args = ap.parse_args()

    if args.compare:
        if not OUT.exists():
            print(f'先跑一次掃描產生 {OUT}')
            return 1
        shops = json.loads(OUT.read_text(encoding='utf-8'))['shops']
        # 挑三間不同縣市的來比
        picked, seen_city = [], set()
        for s in shops:
            if s['city'] not in seen_city:
                picked.append(s['code'])
                seen_city.add(s['city'])
            if len(picked) == 3:
                break
        print(f'比對門市: {picked}\n')
        compare(picked, ['16218', '16453', '16270', '26551'])
        return 0

    print(f'掃描 {args.prefix}{args.lo:03d} ~ {args.prefix}{args.hi:03d}')
    found = scan(args.prefix, args.lo, args.hi)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({'shops': found}, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'\n有效門市 {len(found)} 間, 已寫入 {OUT}')
    by_city = {}
    for s in found:
        by_city.setdefault(s['city'], []).append(s['code'])
    for city, codes in sorted(by_city.items()):
        print(f'  {city}: {len(codes)} 間')
    return 0


if __name__ == '__main__':
    sys.exit(main())
