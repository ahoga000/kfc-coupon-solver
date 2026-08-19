"""上線閘門: 檢查新抓的資料夠不夠好, 不夠好就不准取代現有的。

這是整套「萬一出問題」的主防線。備援門市只能救門市失效, 救不了 IP 被擋、
API 改格式、抓到一半斷掉 —— 那些情況的正確反應都是「保留舊資料, 網站照常運作,
只是顯示的資料日期會停在前一天」, 而不是把半殘的資料推上線讓人拿去櫃檯。

跑法:
    py -3.10 -u scripts/publish_guard.py <候選檔> <現行檔>
    通過 -> exit 0 並把候選檔覆蓋上去
    不通過 -> exit 1, 現行檔原封不動
"""
import json
import shutil
import sys
from datetime import date, datetime
from pathlib import Path

# 券數少於這個絕對值, 一定是出事了 (正常約 400+)
MIN_COUPONS = 150
# 券數不得低於現行的這個比例 —— 抓到一半斷掉就是這樣被擋下來的
MIN_RATIO = 0.7
# 品項數下限
MIN_ITEMS = 50
# 有原價的比例下限 (目前約 96%)。掉太多代表文案解析壞了
MIN_LIST_PRICE_RATIO = 0.80


def load(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception as e:
        print(f'  ✗ {path} 讀不起來: {type(e).__name__}: {e}')
        return None


def check(candidate: dict, current: dict | None) -> list[str]:
    """回傳失敗原因清單, 空的代表通過。"""
    problems = []

    for key in ('fetched_at', 'items', 'singles', 'coupons'):
        if key not in candidate:
            problems.append(f'缺少欄位 {key}')
    if problems:
        return problems

    coupons = candidate['coupons']
    items = candidate['items']

    if len(coupons) < MIN_COUPONS:
        problems.append(f'券只有 {len(coupons)} 張, 低於下限 {MIN_COUPONS}')
    if len(items) < MIN_ITEMS:
        problems.append(f'品項只有 {len(items)} 個, 低於下限 {MIN_ITEMS}')

    if current and current.get('coupons'):
        prev = len(current['coupons'])
        ratio = len(coupons) / prev
        if ratio < MIN_RATIO:
            problems.append(
                f'券數 {len(coupons)} 只有現行 {prev} 的 {ratio:.0%}, 低於 {MIN_RATIO:.0%}')

    # 券價的兩條獨立路徑必須仍然一致。不一致代表解析邏輯跟資料對不上了。
    mismatched = [c['code'] for c in coupons if str(c.get('price_check', '')).startswith('mismatch')]
    if mismatched:
        problems.append(f'券價對帳有 {len(mismatched)} 張不一致: {mismatched[:5]}')

    with_list = sum(1 for c in coupons if c.get('list_price'))
    ratio = with_list / len(coupons) if coupons else 0
    if ratio < MIN_LIST_PRICE_RATIO:
        problems.append(f'只有 {ratio:.0%} 的券抓得到原價, 低於 {MIN_LIST_PRICE_RATIO:.0%}')

    # 全部過期的資料不該上線
    today = date.today().isoformat()
    usable = [c for c in coupons if c.get('end_date', '') >= today]
    if len(usable) < MIN_COUPONS:
        problems.append(f'今天還有效的券只有 {len(usable)} 張')

    # 抓取時間要是今天或昨天 (時區差), 不能是舊檔案被誤當成新的
    try:
        fetched = datetime.fromisoformat(candidate['fetched_at']).date()
        age = (date.today() - fetched).days
        if age > 1:
            problems.append(f'fetched_at 是 {fetched} ({age} 天前), 不像是這次抓的')
    except Exception:
        problems.append(f'fetched_at 格式看不懂: {candidate.get("fetched_at")!r}')

    return problems


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    cand_path, live_path = Path(sys.argv[1]), Path(sys.argv[2])

    candidate = load(cand_path)
    if candidate is None:
        print(f'✗ 候選檔 {cand_path} 不存在或壞掉, 不覆蓋')
        return 1
    current = load(live_path)

    problems = check(candidate, current)

    prev_n = len(current['coupons']) if current and current.get('coupons') else 0
    print(f'候選: {len(candidate["coupons"])} 張券 / {len(candidate["items"])} 個品項'
          f'  (現行 {prev_n} 張)')

    if problems:
        print('\n✗ 沒通過, 保留現有資料不覆蓋:')
        for p in problems:
            print(f'    - {p}')
        return 1

    shutil.copyfile(cand_path, live_path)
    print(f'\n✓ 通過, 已更新 {live_path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
