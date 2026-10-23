#!/usr/bin/env python3
"""Склеивает модули Apps Script в один файл для вставки.

Шесть файлов удобнее править, но вставлять их в проект по одному - шесть
шансов ошибиться. ALL_IN_ONE.gs решает это: один файл, одна вставка.
Править надо ИСХОДНИКИ, а потом запускать этот скрипт:

    python3 scripts/gas/build_all_in_one.py
"""
import pathlib

HERE = pathlib.Path(__file__).parent
PARTS = ['01_config.gs', '02_initdata.gs', '03_miniapp_api.gs',
         '04_join_request.gs', '05_setup.gs', '06_install.gs']

HEAD = """/**
 * ДОСТУП К КАНАЛАМ - весь серверный код одним файлом.
 *
 * ЭТО СОБРАННЫЙ ФАЙЛ, РУКАМИ ЕГО НЕ ПРАВЯТ. Исходники лежат рядом
 * (01_config.gs ... 06_install.gs), пересобрать:
 *     python3 scripts/gas/build_all_in_one.py
 *
 * Вставьте его в проект Apps Script одним новым файлом и дальше следуйте
 * README.md в этой же папке. Инструкция по сигналам не меняется: ваш doPost
 * остаётся вашим, в него добавляются четыре строки.
 */

"""


def main():
    out = [HEAD]
    for name in PARTS:
        body = (HERE / name).read_text(encoding='utf-8')
        out.append('// ' + '=' * 72)
        out.append('// ' + name)
        out.append('// ' + '=' * 72 + '\n')
        out.append(body.rstrip() + '\n\n')
    target = HERE / 'ALL_IN_ONE.gs'
    target.write_text('\n'.join(out), encoding='utf-8')
    print('собрано: %s (%d строк)' % (target, target.read_text(encoding='utf-8').count('\n') + 1))


if __name__ == '__main__':
    main()
