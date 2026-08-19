"""上線閘門的測試。

這道閘門是整套失效防護的主防線 —— 它壞掉的話, 半殘的資料會直接推上線給人用,
而且不會有任何人發現。所以每一條規則都要有一個「該被擋下來」的案例釘住。

跑法:
    py -3.10 -m pytest tests/test_publish_guard.py -q
"""
import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))

from publish_guard import check  # noqa: E402

TODAY = date.today().isoformat()
FAR = (date.today() + timedelta(days=200)).isoformat()


def make(n_coupons=400, n_items=100, list_price_ratio=1.0, mismatch=0,
         fetched=None, end_date=FAR):
    coupons = []
    for i in range(n_coupons):
        coupons.append({
            'code': f'{10000 + i}',
            'name': f'券{i}',
            'price': 100,
            'list_price': 150 if i < n_coupons * list_price_ratio else None,
            'price_check': 'mismatch: 公式 1 vs 文案 2' if i < mismatch else 'match',
            'end_date': end_date,
            'slots': [],
        })
    return {
        'fetched_at': (fetched or date.today().isoformat()) + 'T00:30:00+08:00',
        'items': {f'品項{i}': {} for i in range(n_items)},
        'singles': [],
        'coupons': coupons,
    }


GOOD_CURRENT = make()


def test_正常資料要放行():
    assert check(make(), GOOD_CURRENT) == []


def test_沒有現行檔也能放行():
    assert check(make(), None) == []


class TestShouldBlock:
    def _one(self, candidate, keyword):
        problems = check(candidate, GOOD_CURRENT)
        assert problems, '應該要被擋下來卻放行了'
        assert any(keyword in p for p in problems), f'擋下來的理由不對: {problems}'

    def test_券數低於絕對下限(self):
        self._one(make(n_coupons=10), '低於下限')

    def test_券數比現行掉太多(self):
        # 200 張本身過得了絕對下限, 但只有現行 400 的一半 -> 像是抓到一半斷掉
        self._one(make(n_coupons=200), '低於 70%')

    def test_品項數太少(self):
        self._one(make(n_items=5), '品項')

    def test_券價對帳出現不一致(self):
        # 解析邏輯跟資料對不上了, 這種資料不可以上線
        self._one(make(mismatch=3), '對帳')

    def test_抓得到原價的比例掉太多(self):
        self._one(make(list_price_ratio=0.5), '原價')

    def test_全部都過期了(self):
        past = (date.today() - timedelta(days=1)).isoformat()
        self._one(make(end_date=past), '今天還有效')

    def test_fetched_at_是舊的(self):
        old = (date.today() - timedelta(days=5)).isoformat()
        self._one(make(fetched=old), 'fetched_at')

    def test_fetched_at_格式壞掉(self):
        bad = make()
        bad['fetched_at'] = '不是日期'
        self._one(bad, 'fetched_at')

    @pytest.mark.parametrize('key', ['fetched_at', 'items', 'singles', 'coupons'])
    def test_缺欄位(self, key):
        broken = make()
        del broken[key]
        self._one(broken, f'缺少欄位 {key}')


def test_昨天抓的還算數():
    # 時區差可能讓 fetched_at 落在昨天, 這不該被當成異常
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    assert check(make(fetched=yesterday), GOOD_CURRENT) == []
