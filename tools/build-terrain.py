"""Offline terrain for one India zone (run by .github/workflows/terrain.yml).

Collects Terrarium elevation tiles (AWS Open Data "Terrain Tiles", Mapzen) for the zone's bounding box
at zooms 0..MAXZ into an MBTiles file; the workflow converts it to PMTiles with go-pmtiles.
Usage: python3 build-terrain.py <zone> <out.mbtiles>
"""
import math, sqlite3, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

BBOX = {  # lon_min, lat_min, lon_max, lat_max (Geofabrik India zones, rounded outward)
    'southern-zone': (72.5, 6.5, 87.5, 20.5), 'western-zone': (67.8, 14.8, 80.5, 24.8), 'northern-zone': (68.0, 23.0, 81.5, 37.2),
    'central-zone': (74.0, 17.7, 84.5, 26.9), 'eastern-zone': (81.3, 17.7, 90.0, 27.5), 'north-eastern-zone': (87.9, 21.9, 97.5, 29.5),
}
MAXZ = 10
zone, out = sys.argv[1], sys.argv[2]
w, s, e, n = BBOX[zone]
def x(lon, z): return int((lon + 180) / 360 * 2 ** z)
def y(lat, z): return int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * 2 ** z)
tiles = [(z, tx, ty) for z in range(MAXZ + 1) for tx in range(x(w, z), x(e, z) + 1) for ty in range(y(n, z), y(s, z) + 1)]
print(zone, len(tiles), 'tiles', flush=True)
db = sqlite3.connect(out)
db.executescript('CREATE TABLE metadata (name text, value text); CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob);')
db.executemany('INSERT INTO metadata VALUES (?,?)', [('name', f'{zone} terrain'), ('format', 'png'), ('type', 'baselayer'), ('minzoom', '0'), ('maxzoom', str(MAXZ)),
    ('bounds', f'{w},{s},{e},{n}'), ('attribution', 'Terrain Tiles (Mapzen, AWS Open Data): SRTM, GMTED, ETOPO1 and others'), ('encoding', 'terrarium')])
def get(t):
    z, tx, ty = t
    for k in range(5):
        try:
            with urllib.request.urlopen(f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{tx}/{ty}.png', timeout=60) as r:
                return t, r.read()
        except Exception:
            time.sleep(2 * (k + 1))
    return t, None
done = 0
with ThreadPoolExecutor(16) as ex:
    for (z, tx, ty), data in ex.map(get, tiles):
        if data:
            db.execute('INSERT INTO tiles VALUES (?,?,?,?)', (z, tx, 2 ** z - 1 - ty, data))  # MBTiles rows are TMS (flipped)
        done += 1
        if done % 500 == 0: print(done, flush=True); db.commit()
db.execute('CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row)')
db.commit(); db.close()
