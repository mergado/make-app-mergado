import sys
from PIL import Image
src, out, preview = sys.argv[1:4]
im = Image.open(src).convert('RGBA')
sym = im.crop((0, 0, 360, im.height))
bbox = sym.getbbox()
sym = sym.crop(bbox)
w, h = sym.size
mono = Image.new('RGBA', sym.size, (0, 0, 0, 0))
px, mp = sym.load(), mono.load()
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        if a == 0:
            continue
        if b > 150 and g > 120:      # teal triangle (right)
            level = 0.70
        elif g > 150 and r > 90:     # light green triangle (left)
            level = 1.0
        else:                        # dark green triangle (bottom)
            level = 0.45
        mp[x, y] = (0, 0, 0, int(a * level))
size, inner = 512, 340
scale = inner / max(w, h)
mono = mono.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
canvas.paste(mono, ((size - mono.width) // 2, (size - mono.height) // 2), mono)
canvas.save(out, optimize=True)
# Preview as Make renders it: transparent -> theme colour, black -> white.
theme = (0x5d, 0xa5, 0x28)
pv = Image.new('RGB', (size, size), theme)
cp = canvas.load(); pp = pv.load()
for y in range(size):
    for x in range(size):
        t = cp[x, y][3] / 255
        pp[x, y] = tuple(round(theme[i] * (1 - t) + 255 * t) for i in range(3))
pv.save(preview)
print('bbox', bbox, 'out', canvas.size)
