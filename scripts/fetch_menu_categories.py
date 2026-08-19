"""抓單品的菜單分類 -> data/menu_categories.json

gather.py 只記了單品的價格。分類另外抓是為了避免為了補一個欄位就重跑整批券
(那要 40 分鐘), 這支只花 11 次 API 呼叫。

跑法:
    py -3.10 -u scripts/fetch_menu_categories.py
"""
import json
import sys
from pathlib import Path

from kfc_api import KfcApi, now_iso

OUT = Path(__file__).resolve().parent.parent / 'data' / 'menu_categories.json'


def main() -> int:
    api = KfcApi()
    by_name: dict[str, str] = {}
    menus = api.menu_ids()
    print(f'菜單分類 {len(menus)} 個')
    for menu_id, title in menus:
        for food in api.menu_foods(menu_id):
            for d in food.get('Details', []):
                name = (d.get('Name') or '').strip()
                if name:
                    by_name.setdefault(name, title)
        print(f'  {title!r} -> 累計 {len(by_name)}')

    OUT.write_text(json.dumps(
        {'fetched_at': now_iso(), 'categories': by_name},
        ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'\n{len(by_name)} 個單品分類已寫入 {OUT}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
