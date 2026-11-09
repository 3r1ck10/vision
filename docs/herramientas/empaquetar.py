"""Empaqueta los datos crudos (herramientas/crudo/*.json) en data/*.js binarios comprimidos.

Formato: window.PKG[nombre] = {meta: {...}, b64: "<zlib(binario) en base64>"}
Binario de un modelo: campo por campo (todas las horas seguidas), con los bytes de los enteros de
16 bits separados (bajos y luego altos) para que comprima mejor; al final el volumen de nubes.
Nulos: i16 -32768, u16 65535, i8 -128, u8 255.
"""
import base64, json, math, os, struct, sys, time, zlib

HERE = os.path.dirname(os.path.abspath(__file__))
SA = "--sa" in sys.argv          # Sudamérica: crudo_sa/ -> ../data_sa/
CRUDO = os.path.join(HERE, "crudo_sa" if SA else "crudo") if os.path.basename(HERE) == "herramientas" else os.path.join(HERE, "data")
PUNTOS_DIR = os.path.join(HERE, "crudo") if os.path.basename(HERE) == "herramientas" else CRUDO   # mismos puntos en ambos
DATA = os.path.join(HERE, "..", "data_sa" if SA else "data") if os.path.basename(HERE) == "herramientas" else os.path.join(HERE, "data_pkg")
os.makedirs(DATA, exist_ok=True)
SPAN = 144

# nombre, tipo, divisor al guardar, multiplicador al leer (devuelve las unidades que usa el visor)
FIELDS = [("t2", "i16", 1, 1), ("pr", "u16", 1, 1), ("cape", "u8", 25, 25),
          ("u10", "i8", 5, 5), ("v10", "i8", 5, 5), ("g10", "u8", 5, 5),   # g10: ráfaga (solo ECMWF)
          ("lcc", "u8", 1, 1), ("mcc", "u8", 1, 1), ("hcc", "u8", 1, 1)]
for _p in (925, 850, 700, 500):      # viento (0.5 m/s) y relación de mezcla (décimas de g/kg, hasta 25.4 g/kg)
    FIELDS += [("u%d" % _p, "i8", 5, 5), ("v%d" % _p, "i8", 5, 5), ("q%d" % _p, "u8", 1, 1)]
FIELDS += [("u250", "i8", 10, 10), ("v250", "i8", 10, 10)]   # 250 hPa: pasos de 1 m/s, hasta ±127 m/s (chorro)
FIELDS += [("slp", "u16", 1, 1), ("z500", "u16", 1, 1)]      # presión a nivel del mar (décimas de hPa) y Z500 (m)
# temperatura en los niveles de viento, en décimas de °C (i16: la advección necesita gradientes finos)
FIELDS += [("t%d" % _p, "i16", 1, 1) for _p in (925, 850, 700, 500, 250)]
# (los campos que un modelo no tiene se omiten solos)
LIM = {"i16": (-32767, 32767, -32768), "u16": (0, 65534, 65535), "i8": (-127, 127, -128), "u8": (0, 254, 255)}

def iso_ms(s):
    return time.mktime(time.strptime(s.replace("Z", ""), "%Y-%m-%dT%H:%M")) - time.timezone

def encode(vals, typ):
    lo, hi, nul = LIM[typ]
    q = [nul if v is None else max(lo, min(hi, v)) for v in vals]
    if typ in ("i8", "u8"):
        return struct.pack("<%d%s" % (len(q), "b" if typ == "i8" else "B"), *q)
    raw = struct.pack("<%d%s" % (len(q), "h" if typ == "i16" else "H"), *q)
    return raw[0::2] + raw[1::2]          # bytes bajos, luego altos

def pack(meta, binary):
    c = zlib.compress(bytes(binary), 9)
    return meta, base64.b64encode(c).decode(), len(binary)

def model(m, T0):
    t0 = iso_ms(m["t0"])
    keep = [s for s in m["steps"] if -m["step_h"] <= (t0 - T0) / 3600 + s["fh"] <= SPAN + m["step_h"]]
    n = len(m["lons"]) * len(m["lats"])
    fields, b = [], bytearray()
    lev = []
    for p in m.get("plev") or []:     # humedad (%) y velocidad vertical (pasos de 1 cm/s, tope ±1.27 m/s; se lee en m/s)
        lev += [("rh%d" % p, "u8", 1, 1), ("w%d" % p, "i8", 1, 0.01)]
    for name, typ, div, mult in FIELDS + lev:
        if all(s.get(name) is None for s in keep):
            continue
        for s in keep:
            a = s.get(name) or [None] * n
            b += encode([None if v is None else int(round(v / div)) for v in a], typ)
        fields.append([name, typ, mult])
    meta = {k: m.get(k) for k in ("model", "t0", "step_h", "lons", "lats", "hgt", "fuente", "plev", "zlev")}
    meta.update(levels=None, fh=[s["fh"] for s in keep], fields=fields)
    return pack(meta, b)

def dem(d):
    meta = {k: d[k] for k in ("lons", "lats", "fuente") if k in d}
    return pack(meta, encode(d["z"], "u16"))

def write(name, meta, b64, rawlen, label):
    js = "(window.PKG=window.PKG||{})[%s]={meta:%s,b64:\"%s\"};\n" % (json.dumps(name), json.dumps(meta, separators=(",", ":")), b64)
    fn = os.path.join(DATA, name + ".js")
    with open(fn, "w", encoding="utf-8") as f:
        f.write(js)
    size = os.path.getsize(fn)
    print("  data/%-10s %7.0f KB  (binario %6.0f KB)" % (name + ".js", size / 1024, rawlen / 1024))
    return {"f": name + ".js", "b": size, "t": label}

if __name__ == "__main__":
    indice = []
    models = {}
    for n in ("gfs", "eta", "wrf", "ecmwf", "ecmwf_local"):
        fn = os.path.join(CRUDO, n + ".json")
        if os.path.exists(fn):
            models[n] = json.load(open(fn))
        elif os.path.exists(os.path.join(DATA, n + ".js")):
            os.remove(os.path.join(DATA, n + ".js"))     # no dejar datos viejos de un modelo que ya no está
            print("  (sin %s: se quita data/%s.js)" % (n, n))
    if not models:
        raise SystemExit("No hay datos de modelos en " + CRUDO)
    latest = max(iso_ms(m["t0"]) for m in models.values())
    T0 = math.floor(latest / 86400) * 86400
    print("Inicio de la línea de tiempo:", time.strftime("%Y-%m-%d %H:%MZ", time.gmtime(T0)))
    d = json.load(open(os.path.join(CRUDO, "dem.json")))
    indice.append(write("dem", *dem(d), "relieve"))
    pts = json.load(open(os.path.join(PUNTOS_DIR, "puntos.json"), encoding="utf-8"))
    with open(os.path.join(DATA, "puntos.js"), "w", encoding="utf-8") as f:
        f.write("(window.PKG=window.PKG||{})[\"puntos\"]={json:%s};\n" % json.dumps(pts, ensure_ascii=False))
    indice.append({"f": "puntos.js", "b": os.path.getsize(os.path.join(DATA, "puntos.js")), "t": "puntos"})
    lim = os.path.join(CRUDO, "limites.json")
    if os.path.exists(lim):
        with open(os.path.join(DATA, "limites.js"), "w", encoding="utf-8") as f:
            f.write("(window.PKG=window.PKG||{})[\"limites\"]={json:%s};\n" % open(lim, encoding="utf-8").read())
        indice.append({"f": "limites.js", "b": os.path.getsize(os.path.join(DATA, "limites.js")), "t": "límites"})
    sat = os.path.join(CRUDO, "satelite.jpg")
    if os.path.exists(sat):
        uri = "data:image/jpeg;base64," + base64.b64encode(open(sat, "rb").read()).decode()
        with open(os.path.join(DATA, "satelite.js"), "w", encoding="utf-8") as f:
            f.write("(window.PKG=window.PKG||{})[\"satelite\"]={img:\"%s\"};\n" % uri)
        size = os.path.getsize(os.path.join(DATA, "satelite.js"))
        print("  data/%-10s %7.0f KB  (NASA Blue Marble)" % ("satelite.js", size / 1024))
        indice.append({"f": "satelite.js", "b": size, "t": "imagen satelital"})
    for n, m in models.items():
        indice.append(write(n, *model(m, T0), m["model"]))
    with open(os.path.join(DATA, "indice.js"), "w", encoding="utf-8") as f:
        f.write("window.INDICE=%s;\n" % json.dumps(indice, ensure_ascii=False))
    total = sum(i["b"] for i in indice)
    print("Total datos: %.2f MB" % (total / 1048576))
