"""台灣肯德基線上訂餐 API 的最小封裝。

這是逆向出來的非公開 API, 隨時可能改格式或擋 IP。
所有呼叫都刻意保守: 有 sleep、有 502 退避重試、失敗就往上拋不吞掉。
"""
import os
import time
from datetime import datetime, timedelta, timezone

import requests

API = 'https://olo-api.kfcclub.com.tw'
TPE = timezone(timedelta(hours=8))

# 主用台北雙連, 後面是備援。實測過台南/台北/板橋三間店抓到的券完全相同
# (價格與內容一字不差), 所以換店是乾淨的替補, 不會改變使用者看到的東西。
# 完整清單見 data/shops.json (scripts/probe_shops.py 掃出來的)。
DEFAULT_SHOP_CODE = 'TWI104'
FALLBACK_SHOP_CODES = ['TWI103', 'TWI105', 'TWI100', 'TWI149', 'TWI159']

# 實測 orderType=1 (外送) 一張券都拿不到 —— 券多半註明不適用外送。2 和 3 都可以。
ORDER_TYPE = '2'
FALLBACK_ORDER_TYPES = ['3']

# 這些狀態碼代表「對方在擋我們」, 跟單純的伺服器忙碌不同, 要往上報而不是硬retry
BLOCKED_STATUS = (401, 403, 451)

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')

# 對別人的伺服器客氣一點。每天自動跑的那輪會用更保守的值 (見 workflow 的
# KFC_REQUEST_INTERVAL) —— 手動偶爾跑一次跟每天固定打幾千次，該有的分寸不一樣。
REQUEST_INTERVAL = float(os.environ.get('KFC_REQUEST_INTERVAL', '0.25'))


def today_str() -> str:
    return datetime.now(TPE).strftime('%Y/%m/%d')


def now_iso() -> str:
    return datetime.now(TPE).isoformat(timespec='seconds')


class BlockedError(RuntimeError):
    """對方在擋我們。換門市或換 orderType 都救不了 —— 這是 IP 層級的事,
    正確反應是放棄本次抓取、保留既有資料, 而不是繼續打。"""


def failover_configs() -> list[tuple[str, str]]:
    """要依序嘗試的 (門市, orderType) 組合。

    先換門市再換 orderType: 門市失效比較常見, 而 orderType 換了雖然也抓得到,
    但語意不同 (2=外帶/自取, 3=車道), 能不換就不換。
    """
    configs = [(DEFAULT_SHOP_CODE, ORDER_TYPE)]
    configs += [(s, ORDER_TYPE) for s in FALLBACK_SHOP_CODES]
    configs += [(DEFAULT_SHOP_CODE, ot) for ot in FALLBACK_ORDER_TYPES]
    return configs


class KfcApi:
    def __init__(self, shop_code: str = DEFAULT_SHOP_CODE, interval: float = REQUEST_INTERVAL,
                 order_type: str = ORDER_TYPE):
        self.shop_code = shop_code
        self.order_type = order_type
        self.interval = interval
        self.calls = 0
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': UA,
            'origin': 'https://www.kfcclub.com.tw',
            'referer': 'https://www.kfcclub.com.tw/',
        })

    def post(self, path: str, body: dict, retry: int = 0) -> dict:
        time.sleep(self.interval)
        self.calls += 1
        resp = self.session.post(f'{API}{path}', json=body, timeout=30)
        if resp.status_code in BLOCKED_STATUS:
            raise BlockedError(f'{path} 回 {resp.status_code} —— 看起來被擋了')
        if resp.status_code in (502, 503, 429):
            if retry >= 5:
                # 連退避五次都還是這樣, 當成被擋處理
                raise BlockedError(f'{path} 連續 {retry} 次 {resp.status_code}, 放棄')
            wait = 10 * (retry + 1)
            print(f'    [{resp.status_code}] {path} 退避 {wait}s (retry={retry + 1})')
            time.sleep(wait)
            return self.post(path, body, retry + 1)
        resp.raise_for_status()
        return resp.json()

    @staticmethod
    def _ok(resp: dict) -> bool:
        return resp.get('Success') is True and resp.get('Message') == 'OK'

    # --- 門市 ---

    def shop_info(self) -> dict | None:
        resp = self.post('/menu/v1/QueryDeliveryShops',
                         {'shopCode': self.shop_code, 'orderType': self.order_type, 'platform': '1'})
        return resp.get('Data') if self._ok(resp) else None

    # --- 優惠券 ---

    def voucher_product_code(self, code: str) -> tuple[str | None, str]:
        """回傳 (productCode, 訊息)。查不到就是 (None, 原因)。"""
        resp = self.post('/customer/v1/getEVoucherAPI', {
            'voucherNo': code, 'phone': '', 'memberId': '',
            'orderType': self.order_type, 'mealPeriod': '3', 'shopCode': self.shop_code,
        })
        msg = resp.get('Message', '')
        if not self._ok(resp):
            return None, msg
        product_code = (resp.get('Data') or {}).get('productCode')
        if not product_code:
            return None, 'no productCode'
        return product_code, msg

    def valid_meal_periods(self, code: str, order_date: str) -> list[int]:
        periods = []
        for period in range(1, 6):
            resp = self.post('/customer/v1/checkCouponProduct', {
                'orderDate': order_date, 'orderType': self.order_type, 'mealPeriod': str(period),
                'shopCode': self.shop_code, 'couponCode': code, 'memberId': '',
            })
            if self._ok(resp):
                periods.append(period)
        return periods

    def food_detail(self, product_code: str, periods: list[int], order_date: str):
        """回傳 (FoodDetail dict, 真正拿得到內容的餐期清單)。"""
        usable = []
        detail = None
        for period in periods:
            resp = self.post('/menu/v1/GetQueryFoodDetail', {
                'shopcode': self.shop_code, 'fcode': product_code, 'menuid': '',
                # 這支的參數名全小寫, 跟上面幾支不一樣, 別手滑改成 camelCase
                'mealperiod': str(period), 'ordertype': self.order_type, 'orderdate': order_date,
            })
            if self._ok(resp) and resp.get('Data'):
                if detail is None:
                    detail = resp['Data']
                usable.append(period)
        return detail, usable

    # --- 單品菜單 (拿原價) ---

    def menu_ids(self) -> list[tuple[int, str]]:
        """不指定店鋪與時段, 取全部菜單分類。"""
        resp = self.post('/menu/v1/GetQueryMenu', {
            'ismember': '0', 'mealperiod': '0', 'orderdate': '',
            'ordertype': '0', 'parentid': '0', 'shopcode': '',
        })
        if not self._ok(resp):
            raise RuntimeError(f'GetQueryMenu 失敗: {resp.get("Message")}')
        return [(m['MenuID'], m.get('Title', '')) for m in resp.get('Data', {}).get('Menu', [])]

    def menu_foods(self, menu_id: int) -> list[dict]:
        resp = self.post('/menu/v1/GetQueryFood', {
            'IsPKAPP': '0', 'ismember': '0', 'mealperiod': '0', 'menuid': menu_id,
            'orderdate': '', 'ordertype': '0', 'parentid': '0', 'shopcode': '',
        })
        if not self._ok(resp):
            return []
        return resp.get('Data', {}).get('Foods', [])
