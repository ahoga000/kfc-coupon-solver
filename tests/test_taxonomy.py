"""品名拆解與價格比對的測試。

這兩支函式是整條管線裡最容易靜默出錯的地方 —— 拆錯或配錯價都不會拋例外,
只會讓「省多少」變成一個看起來很合理的錯數字。所以案例全部取自真實資料裡
實際出現過的名字, 不是我編出來的。

跑法:
    py -3.10 -m pytest tests/test_taxonomy.py -q
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))

from build_taxonomy import match_price, parse_parts  # noqa: E402


class TestParseParts:
    def test_單純品名(self):
        assert parse_parts('咔啦脆雞(辣)') == [{'item': '咔啦脆雞(辣)', 'qty': 1}]

    def test_前置份數(self):
        assert parse_parts('2入原味蛋撻超極酥') == [{'item': '原味蛋撻超極酥', 'qty': 2}]

    def test_後置份數(self):
        assert parse_parts('上校雞塊8塊') == [{'item': '上校雞塊', 'qty': 8}]

    def test_後置份數要保留辣度後綴(self):
        assert parse_parts('咔啦爆脆雞1塊(不辣)') == [{'item': '咔啦爆脆雞(不辣)', 'qty': 1}]

    def test_外層括號要剝掉(self):
        assert parse_parts('(4塊上校雞塊+1顆原味蛋撻)') == [
            {'item': '上校雞塊', 'qty': 4},
            {'item': '原味蛋撻', 'qty': 1},
        ]

    def test_複合品含空白(self):
        assert parse_parts('1顆原味蛋撻 +1份香酥脆薯(小)') == [
            {'item': '原味蛋撻', 'qty': 1},
            {'item': '香酥脆薯(小)', 'qty': 1},
        ]

    def test_三段複合品(self):
        assert parse_parts('4塊上校雞塊+1顆原味蛋撻+10顆雙色轉轉QQ球') == [
            {'item': '上校雞塊', 'qty': 4},
            {'item': '原味蛋撻', 'qty': 1},
            {'item': '雙色轉轉QQ球', 'qty': 10},
        ]

    # --- 以下都是實際踩到的誤拆 ---

    @pytest.mark.parametrize('name', ['A+B=$49', 'A+B=$69'])
    def test_促銷名稱裡的加號不是分隔符(self, name):
        assert parse_parts(name) == [{'item': name, 'qty': 1}]

    def test_升級是加購動作不是品名的一部分(self):
        # 不剝掉就認不出券裡的「升級青花椒香麻沾醬(小)」與單品菜單的
        # 「青花椒香麻沾醬(小)」是同一個東西, 醬料會逃過配件判定被當成飲料
        assert parse_parts('升級青花椒香麻沾醬(小)') == [{'item': '青花椒香麻沾醬(小)', 'qty': 1}]
        assert parse_parts('升級BBQ煙燻醬(大)') == [{'item': 'BBQ煙燻醬(大)', 'qty': 1}]

    def test_拆出來太短就不採信這個拆法(self):
        # '1原+1青花椒花生' 拆成 '1原' 沒有意義, 整串當成一個品項才對
        assert parse_parts('1原+1青花椒花生') == [{'item': '1原+1青花椒花生', 'qty': 1}]


class TestMatchPrice:
    SINGLES = {
        '咔啦脆雞': 71,
        '咔啦脆雞2塊': 124,
        '上校雞塊4塊': 60,
        '青花椒香麻脆雞': 78,
        '咔啦爆脆雞(不辣)': 71,
        '冰無糖綠茶(中)': 38,
        '百事可樂(中)': 38,
        '100%蘋果汁': 40,
        '經典冰奶茶': 38,
        '5塊雞桶': 260,
        '青花椒香麻咔啦雞腿堡雙人餐': 392,
        '點心盒-上校雞塊+香酥脆薯(小)': 67,
    }

    def test_完全相同(self):
        assert match_price('咔啦脆雞', self.SINGLES) == (71, 'exact')

    def test_去辣度(self):
        assert match_price('咔啦脆雞(辣)', self.SINGLES) == (71, 'strip-spicy')

    def test_補辣度(self):
        assert match_price('咔啦爆脆雞', self.SINGLES) == (71, 'add-spicy')

    def test_去尺寸(self):
        assert match_price('經典冰奶茶(中)', self.SINGLES) == (38, 'strip-size')

    def test_前綴不同可以用包含比對(self):
        price, method = match_price('無糖綠茶(中)', self.SINGLES)
        assert price == 38 and method.startswith('substring')

    def test_數字前綴不影響(self):
        price, method = match_price('蘋果汁', self.SINGLES)
        assert price == 40 and method.startswith('substring')

    # --- 以下是會讓省錢金額灌水的錯配, 一律寧可查不到價 ---

    def test_不可以拿多件包裝的價當單件價(self):
        # 上校雞塊4塊 是 4 塊的價, 不能當成 1 塊
        assert match_price('上校雞塊', self.SINGLES) == (None, 'none')

    def test_份數在前面也一樣不可以(self):
        assert match_price('雞桶', self.SINGLES) == (None, 'none')

    def test_不可以拿組合餐的價當單品價(self):
        assert match_price('青花椒香麻咔啦雞腿堡', self.SINGLES) == (None, 'none')

    def test_不可以拿組合盒的價當單品價(self):
        # 「點心盒-上校雞塊+香酥脆薯(小) $67」是含薯條的盒子, 不是一塊雞塊的價。
        # 配錯的話 8 塊雞塊會算成 $536, 真值只有 $133。
        # 這裡刻意不放「上校雞塊4塊」, 才驗得到擋的是組合盒而不是份數那條規則。
        singles = {'點心盒-上校雞塊+香酥脆薯(小)': 67, '咔啦脆雞': 71}
        assert match_price('上校雞塊', singles) == (None, 'none')

    def test_查不到就誠實回報查不到(self):
        assert match_price('不存在的東西', self.SINGLES) == (None, 'none')
