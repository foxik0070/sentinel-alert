"""Barvy clusteru v seznamu prihlasenych uzivatelu.

Pozadavek: rozdelit uzivatele podle clusteru a odlisit je barvou. Paleta je
overena validatorem proti tmavemu podkladu #06121a (CVD ΔE 8.4, kontrast
vsech >= 3:1) — nesmi se menit od oka.
"""
import os
import re

import pytest

_JS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   'static', 'js', '02-devices.js')


@pytest.fixture(scope="module")
def js():
    return open(_JS, encoding='utf-8').read()


def test_known_clusters_listed(js):
    """barbora2 a karolina2 musi mit sve misto, ne spadnout do 'ostatni'."""
    order = re.search(r"CLUSTER_ORDER = \[(.*?)\]", js, re.S).group(1)
    for c in ('karolina', 'barbora', 'cs', 'barbora2', 'karolina2'):
        assert f"'{c}'" in order, f"{c} chybi v CLUSTER_ORDER"


def test_palette_is_the_validated_one(js):
    """Hodnoty proslé validatorem. Zmena = znovu spustit validator."""
    colors = re.search(r"CLUSTER_COLORS = \[(.*?)\]", js, re.S).group(1)
    for hexv in ('#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9'):
        assert hexv in colors, f"{hexv} chybi v palete"


def test_palette_covers_known_clusters(js):
    order = re.findall(r"'([^']+)'", re.search(r"CLUSTER_ORDER = \[(.*?)\]", js, re.S).group(1))
    colors = re.findall(r"'(#[0-9a-fA-F]{6})'", re.search(r"CLUSTER_COLORS = \[(.*?)\]", js, re.S).group(1))
    assert len(colors) >= len(order), "mene barev nez clusteru — nekdo by cykloval"


def test_colors_are_not_cycled(js):
    """9. cluster nesmi dostat barvu nekoho jineho — spadne do 'ostatni'."""
    assert 'CLUSTER_OTHER' in js
    assert '% CLUSTER_COLORS.length' not in js, "modulo = cyklovani barev"


def test_cluster_name_is_always_shown(js):
    """Identita nesmi byt jen barvou (barvoslepi, tisk)."""
    assert 'key.toUpperCase()' in js, "nazev clusteru se musi vypsat vedle barvy"


def test_globe_colors_by_cluster(js):
    assert 'clusterColor(u.cluster)' in js, "oblouky na globusu maji barvu clusteru"
