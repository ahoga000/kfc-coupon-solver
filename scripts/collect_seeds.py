"""從公開的優惠券懶人包網頁蒐集候選 5 碼代碼, 產生 data/seed_codes.txt。

只負責「蒐集候選」, 不負責判斷有效 —— 有效性一律由 gather.py 打官方 API 驗證。
所以這裡寧可寬鬆多撈, 撈到雜訊(價格/編號)會在下一關被 API 打掉。

跑法:
    py -3.10 -u scripts/collect_seeds.py
"""
import re
import sys
import time
from pathlib import Path

import requests

SOURCES = [
    'https://cpok.tw/25326',
    'https://cpok.tw/60937',
    'https://sunnylife.tw/kfccoupon/',
    'https://info.talk.tw/kfc-coupon/',
    'https://finduheart.com/kfc-taiwan-menu-coupon-2026',
    'https://xincoupon.com/kfc-promo-codes-coupons-discount-codes-deals/',
]

SEED_PATH = Path(__file__).resolve().parent.parent / 'data' / 'seed_codes.txt'

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')

# 5 碼、前後不能再接數字, 避免從長數字串中間切出來
CODE_RE = re.compile(r'(?<!\d)(\d{5})(?!\d)')


def collect() -> set[str]:
    session = requests.Session()
    session.headers['User-Agent'] = UA
    found: set[str] = set()

    for url in SOURCES:
        try:
            resp = session.get(url, timeout=30)
            resp.raise_for_status()
        except Exception as e:  # 單一來源掛掉不該讓整批失敗
            print(f'  SKIP {url} -> {type(e).__name__}: {e}')
            continue
        codes = set(CODE_RE.findall(resp.text))
        new = codes - found
        found |= codes
        print(f'  OK   {url} -> {len(codes)} 個候選 (新增 {len(new)})')
        time.sleep(1)

    return found


def main() -> int:
    print('蒐集候選代碼...')
    found = collect()
    if not found:
        print('一個都沒撈到, 不覆寫既有種子檔')
        return 1

    # 保留既有種子, 只做累加 (代碼會下架, 但留著讓 gather.py 每次重驗成本很低)
    existing: set[str] = set()
    if SEED_PATH.exists():
        existing = {
            line.strip() for line in SEED_PATH.read_text(encoding='utf-8').splitlines()
            if line.strip() and not line.startswith('#')
        }

    merged = sorted(existing | found)
    SEED_PATH.parent.mkdir(parents=True, exist_ok=True)
    SEED_PATH.write_text(
        '# 候選優惠券代碼 (未驗證), 由 collect_seeds.py 累加維護\n'
        + '\n'.join(merged) + '\n',
        encoding='utf-8',
    )
    print(f'\n候選 {len(found)} 個, 併入既有 {len(existing)} 個 -> 共 {len(merged)} 個')
    print(f'已寫入 {SEED_PATH}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
