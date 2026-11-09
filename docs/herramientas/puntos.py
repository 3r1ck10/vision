"""Lee puntos_pronosticos.xlsx (sin dependencias) -> data/puntos.json"""
import zipfile, json, os, re, sys
import xml.etree.ElementTree as ET

SRC = sys.argv[1] if len(sys.argv) > 1 else r"D:\interpgrads\puntos_pronosticos.xlsx"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "crudo") if os.path.basename(HERE) == "herramientas" else os.path.join(HERE, "data")
OUT = os.path.join(OUT_DIR, "puntos.json")
ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
z = zipfile.ZipFile(SRC)
ss = [si.find(".//m:t", ns).text if si.find(".//m:t", ns) is not None else "".join(t.text or "" for t in si.iter("{%s}t" % ns["m"]))
      for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", ns)]
pts = []
for name in sorted(n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml", n)):
    for row in ET.fromstring(z.read(name)).iter("{%s}row" % ns["m"]):
        vals = {}
        for c in row.findall("m:c", ns):
            col = re.match(r"[A-Z]+", c.get("r")).group(0)
            v = c.find("m:v", ns)
            if v is None: continue
            vals[col] = ss[int(v.text)] if c.get("t") == "s" else v.text
        try:
            lat, lon = float(vals.get("B")), float(vals.get("C"))
        except (TypeError, ValueError):
            continue
        if lon > 180: lon -= 360
        pts.append(dict(nombre=vals.get("A", "").strip().title(), lat=round(lat, 4), lon=round(lon, 4)))
json.dump(pts, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
print(len(pts), "puntos ->", OUT)
for p in pts: print(" ", p)
