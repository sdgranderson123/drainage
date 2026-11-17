# Regenerate tests/fixtures survey files from a known surface. Needs: pip install pyproj "laspy[lazrs]" numpy
# Usage: python tools/make_survey_fixtures.py tests/fixtures
# Survey fixtures from a known surface around 33.45, -90.65 (the e2e test site).
import math, numpy as np, laspy, pyproj, sys
out = sys.argv[1]
LAT0, LON0 = 33.45, -90.65
R = 6371008.8
def local(lat, lon):  # same projection as earthwork.toLocal
    k = math.pi/180; return ((lon-LON0)*k*R*math.cos(LAT0*k), (lat-LAT0)*k*R)
# Survey surface (metres): the e2e lidar plane + 0.10 m everywhere + a 0.5 m deep ditch along x in [-5, 5] m
S, Hd = 0.002, math.radians(135)
def zsurv(x, y):
    z = 30 - S*(math.sin(Hd)*x + math.cos(Hd)*y) + 0.10
    if -5 <= x <= 5: z -= 0.5
    return z
ll2sp = pyproj.Transformer.from_crs(4326, 2255, always_xy=True)   # MS West ftUS
ll2utm = pyproj.Transformer.from_crs(4326, 26915, always_xy=True) # UTM 15N m
USFT = 1200/3937
# Sparse survey shots on a 20 m grid plus ditch shots, within +-150 m
shots = []
for gx in range(-150, 151, 20):
    for gy in range(-150, 151, 20): shots.append((gx, gy))
for gy in range(-150, 151, 10): shots += [(-5.01, gy), (-4.99, gy), (4.99, gy), (5.01, gy)]
rows = []
for k, (x, y) in enumerate(shots):
    lat = LAT0 + y/(R*math.pi/180); lon = LON0 + x/(R*math.pi/180*math.cos(math.radians(LAT0)))
    E, N = ll2sp.transform(lon, lat)
    rows.append((k+1, N, E, zsurv(x, y)/USFT, 'SHOT'))
with open(f'{out}/survey_pnezd.csv','w') as f:
    f.write('P,N,E,Z,D\n'); [f.write(f'{p},{n:.3f},{e:.3f},{z:.3f},{d}\n') for p,n,e,z,d in rows]
# DXF with POINT entities
with open(f'{out}/survey.dxf','w') as f:
    f.write('0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n')
    for p,n,e,z,d in rows: f.write(f'0\nPOINT\n8\nSHOTS\n10\n{e:.3f}\n20\n{n:.3f}\n30\n{z:.3f}\n')
    f.write('0\nENDSEC\n0\nEOF\n')
# LandXML TIN via Delaunay of the shots (scipy-free: simple grid triangulation of the 20 m grid only)
grid = {}
for k,(x,y) in enumerate(shots[:len(range(-150,151,20))**2]): grid[(x,y)] = k+1
with open(f'{out}/survey_tin.xml','w') as f:
    f.write('<?xml version="1.0"?>\n<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">\n')
    f.write('<Units><Imperial linearUnit="USSurveyFoot"/></Units>\n<CoordinateSystem epsgCode="2255"/>\n<Surfaces><Surface name="EG"><Definition surfType="TIN"><Pnts>\n')
    for (x,y),k in grid.items(): p,n,e,z,d = rows[k-1]; f.write(f'<P id="{k}">{n:.3f} {e:.3f} {z:.3f}</P>\n')
    f.write('</Pnts><Faces>\n')
    for gx in range(-150, 131, 20):
        for gy in range(-150, 131, 20):
            a,b,c,d = grid[(gx,gy)], grid[(gx+20,gy)], grid[(gx+20,gy+20)], grid[(gx,gy+20)]
            f.write(f'<F>{a} {b} {c}</F>\n<F>{a} {c} {d}</F>\n')
    f.write('</Faces></Definition></Surface></Surfaces></LandXML>\n')
# LAS/LAZ: dense 1 m ground points (class 2) + "building" points 8 m up (class 6), UTM 15N metres
xs, ys, zs, cl = [], [], [], []
for x in np.arange(-100, 100.01, 1.0):
    for y in np.arange(-100, 100.01, 1.0):
        lat = LAT0 + y/(R*math.pi/180); lon = LON0 + x/(R*math.pi/180*math.cos(math.radians(LAT0)))
        E, N = ll2utm.transform(lon, lat); xs.append(E); ys.append(N); zs.append(zsurv(x, y)); cl.append(2)
        if 20 < x < 40 and 20 < y < 40: xs.append(E); ys.append(N); zs.append(zsurv(x, y)+8); cl.append(6)
hdr = laspy.LasHeader(point_format=3, version='1.2'); hdr.scales = [0.001]*3; hdr.offsets = [min(xs), min(ys), 0]
hdr.add_crs(pyproj.CRS.from_epsg(26915))
las = laspy.LasData(hdr); las.x = np.array(xs); las.y = np.array(ys); las.z = np.array(zs); las.classification = np.array(cl, dtype=np.uint8)
las.write(f'{out}/cloud.las'); las.write(f'{out}/cloud.laz')
print(len(rows), 'shots;', len(xs), 'cloud points')
