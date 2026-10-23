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
STANDALONE = '07_standalone_doPost.gs'

COMMON = """ * ЭТО СОБРАННЫЙ ФАЙЛ, РУКАМИ ЕГО НЕ ПРАВЯТ. Исходники лежат рядом,
 * пересобрать оба файла:
 *     python3 scripts/gas/build_all_in_one.py
 *
 * Дальше следуйте README.md в этой же папке."""

HEAD_ADDON = """/**
 * ДОСТУП К КАНАЛАМ - для ДОБАВЛЕНИЯ В ПРОЕКТ С СИГНАЛАМИ.
 *
 * Здесь НЕТ своего doPost - он у вас уже есть. В него добавляются четыре
 * строки (README, шаг 5), и логика сигналов не меняется.
 *
 * Если код доступа живёт в ОТДЕЛЬНОМ проекте - берите
 * ALL_IN_ONE_STANDALONE.gs вместо этого файла.
 *
%s
 */

""" % COMMON

HEAD_STANDALONE = """/**
 * ДОСТУП К КАНАЛАМ - для ОТДЕЛЬНОГО проекта Apps Script.
 *
 * Здесь ЕСТЬ свой doPost, в самом конце файла.
 *
 * НЕ вставляйте этот файл в проект с сигналами: второе объявление doPost
 * молча затрёт ваше, и приём алертов TradingView перестанет работать.
 * Для такого случая есть ALL_IN_ONE.gs - без doPost.
 *
%s
 */

""" % COMMON


def build(target, head, parts):
    out = [head]
    for name in parts:
        body = (HERE / name).read_text(encoding='utf-8')
        out.append('// ' + '=' * 72)
        out.append('// ' + name)
        out.append('// ' + '=' * 72 + '\n')
        out.append(body.rstrip() + '\n\n')
    path = HERE / target
    path.write_text('\n'.join(out), encoding='utf-8')
    print('собрано: %s (%d строк)' % (path, path.read_text(encoding='utf-8').count('\n') + 1))


def main():
    build('ALL_IN_ONE.gs', HEAD_ADDON, PARTS)
    build('ALL_IN_ONE_STANDALONE.gs', HEAD_STANDALONE, PARTS + [STANDALONE])


if __name__ == '__main__':
    main()
