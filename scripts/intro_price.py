"""從官方文案 (FoodDetail.Intro) 抽出券價與原價。

這是券價的第二條獨立路徑, 專門用來跟「Original_Price + Σ MListPrice×份數」的
公式對帳。兩條路徑都由這裡與 gather.py 各自產生, 但解析只有這一份實作 ——
同一段邏輯抄兩份就不叫對帳了。

文案格式沒有統一, 實際出現過的至少有:
    '...+1杯冰無糖綠茶(小)=NT$62(原價NT$133元)'
    '1塊咔啦脆雞+1份香酥脆薯(小)+1杯立頓檸檬風味紅茶(中)$88元(原價NT$150元)'   <- 沒有等號
    '飲料5選2:...=$38'                                                    <- 沒有 NT、沒有元
    '買1杯經典冰奶茶+1元再享1杯經典冰奶茶 此優惠合計$39元'
    '買1杯玉米濃湯(小)=NT$40 送1杯冰無糖綠茶(中)(省$38) *...'                <- 有第二個金額不能抓錯
    '2份薯餅+1杯冰無糖紅茶(小)=NT$42元(最高價值$113元)'                      <- 原價換個說法
    '2個薯餅+1杯立頓檸檬風味紅茶(小)=NT$49(市價NT$113)'                      <- 又一種說法
"""
import re

# 原價的寫法不只一種: 「原價NT$133元」「最高價值$240元」「市價NT$144」都是同一件事。
# 這些子句要先摘掉, 否則會被當成券價 (最早的版本就是這樣抓錯 20 張券的)。
LIST_PRICE_RE = re.compile(r'(?:原價|最高價值|市價)\s*(?:NT)?\s*\$?\s*(\d+)\s*元?')

# 「省NT$38元」語意完全不同 —— 那是省下的金額, 不是原價。原價 = 券價 + 省。
# 兩者混為一談會讓折扣率整個歪掉, 所以分開處理。
SAVED_RE = re.compile(r'省\s*(?:NT)?\s*\$?\s*(\d+)\s*元?')

_MONEY = r'(?:NT)?\s*\$?\s*(\d+)'
DEAL_AFTER_EQ_RE = re.compile(r'[=＝]\s*' + _MONEY)
DEAL_TOTAL_RE = re.compile(r'(?:合計|共)\s*' + _MONEY)
DEAL_DOLLAR_RE = re.compile(r'\$\s*(\d+)\s*元')


def parse_intro_prices(intro: str) -> tuple[int | None, int | None]:
    """回傳 (券價, 原價)。抓不到就給 None, 絕不用猜的補。"""
    if not intro:
        return None, None

    list_price = None
    m = LIST_PRICE_RE.search(intro)
    if m:
        list_price = int(m.group(1))
        intro = LIST_PRICE_RE.sub('', intro)

    # 省的子句也要摘掉再找券價, 否則沒有等號的文案會把「省$40」當成券價
    saved = None
    m = SAVED_RE.search(intro)
    if m:
        saved = int(m.group(1))
        intro = SAVED_RE.sub('', intro)

    deal = None
    # 「合計」要排在等號前面: 文案可能同時有兩個金額, 例如
    # '買1盒原味蛋撻禮盒(6入)=$199元+6元即享100%蘋果汁 此套餐合計205元'
    # 等號後面的 199 只是其中一項, 205 才是這張券的價錢。
    for pattern in (DEAL_TOTAL_RE, DEAL_AFTER_EQ_RE, DEAL_DOLLAR_RE):
        m = pattern.search(intro)
        if m:
            deal = int(m.group(1))
            break

    # 文案明講的原價優先; 只有在沒明講時才用「券價 + 省」回推。
    # (兩者並存時不相加 —— 「最高價值$73元…送1份薯餅(省$40)」的 73 已經是官方說法)
    if list_price is None and saved is not None and deal is not None:
        list_price = deal + saved

    return deal, list_price


def reconcile(formula_price: int, intro: str) -> tuple[str, int | None]:
    """把公式價與文案價對帳。回傳 (對帳結果, 原價)。"""
    deal, list_price = parse_intro_prices(intro)
    if deal is None:
        return 'unparsed', list_price
    if deal == formula_price:
        return 'match', list_price
    return f'mismatch: 公式 {formula_price} vs 文案 {deal}', list_price
