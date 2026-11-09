"""Límites departamentales del Perú (geoBoundaries ADM1, CC BY 4.0) recortados al dominio -> crudo/limites.json

Salida: {"lineas": [[lon, lat, lon, lat, ...], ...], "nombres": [[nombre, lon, lat], ...], "fuente": "..."}
"""
import json, os, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "crudo") if os.path.basename(HERE) == "herramientas" else os.path.join(HERE, "data")
os.makedirs(OUT, exist_ok=True)
SRC = os.path.join(OUT, "per_adm1.geojson")
URL = "https://github.com/wmgeolab/geoBoundaries/raw/main/releaseData/gbOpen/PER/ADM1/geoBoundaries-PER-ADM1_simplified.geojson"
LON0, LON1, LAT0, LAT1 = -81.5, -76.0, -8.5, -3.0

if not os.path.exists(SRC):
    with urllib.request.urlopen(URL, timeout=120) as r:
        open(SRC, "wb").write(r.read())
gj = json.load(open(SRC, encoding="utf-8"))

inside = lambda lo, la: LON0 <= lo <= LON1 and LAT0 <= la <= LAT1
lineas, nombres = [], []
for f in gj["features"]:
    name = f["properties"].get("shapeName", "")
    g = f["geometry"]
    polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    pts_in = []
    for poly in polys:
        for ring in poly:
            cur = []
            for lo, la in ring:
                if inside(lo, la):
                    cur += [round(lo, 4), round(la, 4)]; pts_in.append((lo, la))
                elif cur:
                    if len(cur) >= 4: lineas.append(cur)
                    cur = []
            if len(cur) >= 4: lineas.append(cur)
    if len(pts_in) > 20:     # etiqueta en el centro de la parte visible del departamento
        lo = sum(p[0] for p in pts_in) / len(pts_in); la = sum(p[1] for p in pts_in) / len(pts_in)
        nombres.append([name, round(lo, 3), round(la, 3)])
json.dump({"lineas": lineas, "nombres": nombres, "fuente": "geoBoundaries PER ADM1 (CC BY 4.0)"},
          open(os.path.join(OUT, "limites.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(len(lineas), "líneas,", sum(len(l) // 2 for l in lineas), "vértices; departamentos:", ", ".join(n[0] for n in nombres))
