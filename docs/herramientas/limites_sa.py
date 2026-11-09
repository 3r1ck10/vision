"""Límites de países (Natural Earth 1:50 m, dominio público) recortados a Sudamérica -> crudo_sa/limites.json

Mismo formato que limites.py: {"lineas": [[lon, lat, ...], ...], "nombres": [[nombre, lon, lat], ...], "fuente": "..."}
"""
import json, os, subprocess, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "crudo_sa") if os.path.basename(HERE) == "herramientas" else os.path.join(HERE, "data_sa")
os.makedirs(OUT, exist_ok=True)
SRC = os.path.join(OUT, "ne_50m_admin_0_countries.geojson")
URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson"
LON0, LON1, LAT0, LAT1 = -150.0, -20.0, -60.0, 25.0
MIN_STEP = 0.06          # grados: puntos más juntos que esto se omiten (aligera sin cambiar la forma a esta escala)

if not os.path.exists(SRC):
    try:
        with urllib.request.urlopen(URL, timeout=180) as r:
            data = r.read()
    except Exception as e:      # Python con certificados vencidos: curl de Windows
        print("  urllib falló (%s); uso curl.exe" % e)
        data = subprocess.run(["curl.exe", "-sS", "--fail", "--max-time", "300", URL], capture_output=True, check=True).stdout
    open(SRC, "wb").write(data)
gj = json.load(open(SRC, encoding="utf-8"))

inside = lambda lo, la: LON0 <= lo <= LON1 and LAT0 <= la <= LAT1
lineas, nombres = [], []
for f in gj["features"]:
    pr = f["properties"]
    g = f["geometry"]
    if not g:
        continue
    polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    n_in = 0
    for poly in polys:
        for ring in poly:
            cur, last = [], None
            for lo, la in ring:
                if inside(lo, la):
                    if last is None or abs(lo - last[0]) + abs(la - last[1]) >= MIN_STEP:
                        cur += [round(lo, 3), round(la, 3)]; last = (lo, la); n_in += 1
                else:
                    if len(cur) >= 4: lineas.append(cur)
                    cur, last = [], None
            if len(cur) >= 4: lineas.append(cur)
    lx, ly = pr.get("LABEL_X"), pr.get("LABEL_Y")
    # solo países con buena parte dentro y de rango de etiqueta alto (evita islas pequeñas)
    if n_in > 60 and lx is not None and inside(lx, ly) and (pr.get("LABELRANK") or 9) <= 5:
        nombres.append([pr.get("NAME_ES") or pr.get("NAME"), round(lx, 2), round(ly, 2)])
json.dump({"lineas": lineas, "nombres": nombres, "fuente": "Natural Earth 1:50m (dominio público)"},
          open(os.path.join(OUT, "limites.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(len(lineas), "líneas,", sum(len(l) // 2 for l in lineas), "vértices; países:", ", ".join(n[0] for n in nombres))
