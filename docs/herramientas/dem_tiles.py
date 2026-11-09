"""Relieve desde AWS Terrain Tiles (terrarium, datos abiertos) -> data/dem.json en grilla regular."""
import json, math, os, struct, sys, urllib.request, zlib

HERE = os.path.dirname(os.path.abspath(__file__))
SA = "--sa" in sys.argv          # Sudamérica: 25°N–60°S, 150°O–20°O a 0.25° (zoom 4)
OUT = os.path.join(HERE, "crudo_sa" if SA else "crudo") if os.path.basename(HERE) == "herramientas" else os.path.join(HERE, "data")
CACHE = os.path.join(HERE, "tmp", "tiles")
os.makedirs(CACHE, exist_ok=True)
LON0, LON1, LAT0, LAT1, STEP, Z = (-150.0, -20.0, -60.0, 25.0, 0.25, 4) if SA else (-81.5, -76.0, -8.5, -3.0, 0.025, 9)
os.makedirs(OUT, exist_ok=True)

def png_rgb(data):
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat, w = 8, b"", None
    while pos < len(data):
        ln, typ = struct.unpack(">I4s", data[pos:pos + 8]); ch = data[pos + 8:pos + 8 + ln]; pos += 12 + ln
        if typ == b"IHDR":
            w, h, bd, ct = struct.unpack(">IIBB", ch[:10]); assert bd == 8 and ct in (2, 6)
            bpp = 3 if ct == 2 else 4
        elif typ == b"IDAT": idat += ch
        elif typ == b"IEND": break
    raw = zlib.decompress(idat); stride = w * bpp; out = bytearray(h * stride); prev = bytearray(stride); p = 0
    for y in range(h):
        f = raw[p]; line = bytearray(raw[p + 1:p + 1 + stride]); p += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0; b = prev[x]; c = prev[x - bpp] if x >= bpp else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + (a + b) // 2) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        out[y * stride:(y + 1) * stride] = line; prev = line
    return w, h, bpp, out

def tile_xy(lon, lat, z):
    n = 2 ** z; x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y

tiles = {}
def tile(tx, ty):
    if (tx, ty) not in tiles:
        fn = os.path.join(CACHE, "%d_%d_%d.png" % (Z, tx, ty))
        if not os.path.exists(fn):
            url = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/%d/%d/%d.png" % (Z, tx, ty)
            with urllib.request.urlopen(url, timeout=60) as r: open(fn, "wb").write(r.read())
            print("tile", tx, ty, flush=True)
        tiles[(tx, ty)] = png_rgb(open(fn, "rb").read())
    return tiles[(tx, ty)]

def elev(lon, lat):
    x, y = tile_xy(lon, lat, Z); tx, ty = int(x), int(y)
    w, h, bpp, px = tile(tx, ty)
    ix, iy = min(w - 1, int((x - tx) * w)), min(h - 1, int((y - ty) * h))
    o = (iy * w + ix) * bpp; r, g, b = px[o], px[o + 1], px[o + 2]
    return r * 256 + g + b / 256 - 32768

lons = [round(LON0 + i * STEP, 4) for i in range(int(round((LON1 - LON0) / STEP)) + 1)]
lats = [round(LAT0 + j * STEP, 4) for j in range(int(round((LAT1 - LAT0) / STEP)) + 1)]
zs = []
for la in lats:
    for lo in lons:
        # promedio 3x3 sub-muestras para suavizar a la escala de la grilla
        s = 0
        for dy in (-0.33, 0, 0.33):
            for dx in (-0.33, 0, 0.33):
                s += elev(lo + dx * STEP, la + dy * STEP)
        zs.append(int(round(max(0, s / 9))))
json.dump(dict(lons=lons, lats=lats, z=zs, fuente="AWS Terrain Tiles (Mapzen/SRTM) z%d" % Z),
          open(os.path.join(OUT, "dem.json"), "w"), separators=(",", ":"))
print("dem listo", len(lons), "x", len(lats), "max", max(zs))
