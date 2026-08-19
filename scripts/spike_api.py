"""P0 kill-switch spike: 確認台灣肯德基 API 不帶登入就拿得到優惠券內容。

跑法:
    py -3.10 -u scripts/spike_api.py 16521

驗收標準寫在 plan 裡: 抓到的券價與品項要對得上外部懶人包網站的敘述。
對不上就是整個專案沒有基礎, 停下來回報, 不要繼續往下做。
"""
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

API = 'https://olo-api.kfcclub.com.tw'
SHOP_CODE = 'TWI104'  # 台北雙連餐廳; 券內容全台大致通用, 價格可能因店而異
ORDER_TYPE = '2'
TPE = timezone(timedelta(hours=8))

OUT_DIR = Path(__file__).resolve().parent.parent / 'data' / 'raw'


def make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'origin': 'https://www.kfcclub.com.tw',
        'referer': 'https://www.kfcclub.com.tw/',
    })
    return s


def post(session: requests.Session, path: str, body: dict) -> dict:
    resp = session.post(f'{API}{path}', json=body, timeout=30)
    resp.raise_for_status()
    return resp.json()


def main(coupon_code: str) -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    session = make_session()
    today = datetime.now(TPE).strftime('%Y/%m/%d')

    # 1. 門市資訊 — 順便確認 shopCode 有效
    shop = post(session, '/menu/v1/QueryDeliveryShops',
                {'shopCode': SHOP_CODE, 'orderType': ORDER_TYPE, 'platform': '1'})
    print(f"[1] QueryDeliveryShops Success={shop.get('Success')} Message={shop.get('Message')!r}")
    if not shop.get('Success'):
        print('    門市查詢失敗, 後面都不用試了')
        return 1
    d = shop.get('Data') or {}
    print(f"    店號 {d.get('ShopCode')} / {d.get('ShopName')} / {d.get('Addr')}")

    # 2. 券 -> productCode
    voucher = post(session, '/customer/v1/getEVoucherAPI', {
        'voucherNo': coupon_code, 'phone': '', 'memberId': '',
        'orderType': ORDER_TYPE, 'mealPeriod': '3', 'shopCode': SHOP_CODE,
    })
    print(f"[2] getEVoucherAPI Success={voucher.get('Success')} Message={voucher.get('Message')!r}")
    print(f"    Data={json.dumps(voucher.get('Data'), ensure_ascii=False)}")
    if not voucher.get('Success'):
        print(f'    券 {coupon_code} 查不到 (可能已過期或代碼有誤)')
        return 1
    product_code = (voucher.get('Data') or {}).get('productCode')
    if not product_code:
        print('    回應裡沒有 productCode')
        return 1

    # 3. 各餐期有效性 (1=早餐 ... 5, 實際對應待確認)
    periods = []
    for period in range(1, 6):
        r = post(session, '/customer/v1/checkCouponProduct', {
            'orderDate': today, 'orderType': ORDER_TYPE, 'mealPeriod': str(period),
            'shopCode': SHOP_CODE, 'couponCode': coupon_code, 'memberId': '',
        })
        ok = r.get('Success') is True and r.get('Message') == 'OK'
        print(f"[3] checkCouponProduct period={period} -> {ok} ({r.get('Message')!r})")
        if ok:
            periods.append(period)
        time.sleep(0.3)
    if not periods:
        print('    所有餐期都無效')
        return 1

    # 4. 券內容
    food = None
    for period in periods:
        r = post(session, '/menu/v1/GetQueryFoodDetail', {
            'shopcode': SHOP_CODE, 'fcode': product_code, 'menuid': '',
            'mealperiod': str(period), 'ordertype': ORDER_TYPE, 'orderdate': today,
        })
        if r.get('Success') and r.get('Data'):
            food = r['Data']
            print(f"[4] GetQueryFoodDetail period={period} -> 拿到內容")
            break
        time.sleep(0.3)
    if not food:
        print('[4] 所有有效餐期都拿不到 FoodDetail')
        return 1

    raw_path = OUT_DIR / f'spike_{coupon_code}.json'
    raw_path.write_text(json.dumps(food, ensure_ascii=False, indent=2), encoding='utf-8')

    # 5. 人眼驗收用的攤平輸出
    detail = food['FoodDetail'][0]
    price = detail['Original_Price']
    print()
    print('=' * 60)
    print(f"券名   : {detail['Name']}")
    print(f"代碼   : {coupon_code}   商品碼: {detail['Fcode']}")
    print(f"效期   : {detail['StartDate']} ~ {detail['EndDate']}")
    print(f"有效餐期: {periods}")
    print(f"Original_Price = {detail['Original_Price']}")
    print('內容:')
    for i, slot in enumerate(detail['Details']):
        opts = slot['MList']
        main = opts[0]
        price += main['MListPrice'] * slot['MinCount']
        print(f"  slot{i}: x{slot['MinCount']}  主選項={main['Name']} "
              f"(MListPrice={main['MListPrice']}, AddPrice={main['AddPrice']})")
        for alt in opts[1:]:
            print(f"          可換 -> {alt['Name']} (AddPrice={alt['AddPrice']})")
    print(f"合計券價 = {price}")
    print('=' * 60)
    print(f'原始 JSON 已存到 {raw_path}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else '16521'))
