"""Imagen satelital sin nubes NASA Blue Marble Next Generation (dominio público) del dominio -> crudo/satelite.jpg"""
import os, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SA = "--sa" in sys.argv
OUT = os.path.join(HERE, "crudo_sa" if SA else "crudo") if os.path.basename(HERE) == "herramientas" else os.path.join(HERE, "data")
os.makedirs(OUT, exist_ok=True)
LON0, LON1, LAT0, LAT1 = (-150.0, -20.0, -60.0, 25.0) if SA else (-81.5, -76.0, -8.5, -3.0)
WIDTH, HEIGHT = (2600, 1700) if SA else (1100, 1100)
url = ("https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0"
       "&LAYERS=BlueMarble_NextGeneration&STYLES=&CRS=EPSG:4326&BBOX=%g,%g,%g,%g&WIDTH=%d&HEIGHT=%d&FORMAT=image/jpeg"
       % (LAT0, LON0, LAT1, LON1, WIDTH, HEIGHT))
with urllib.request.urlopen(url, timeout=120) as r:
    data = r.read()
if data[:3] != b"\xff\xd8\xff":
    raise SystemExit("La respuesta de NASA GIBS no es una imagen JPEG")
open(os.path.join(OUT, "satelite.jpg"), "wb").write(data)
print("satelite.jpg", len(data) // 1024, "KB")
