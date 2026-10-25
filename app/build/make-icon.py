# McLauncher icon, in the same family as Aurora's: rounded tile, diagonal three-colour gradient,
# flat white symbol (an isometric block split into three faces by thin gaps).
from PIL import Image, ImageDraw, ImageChops
import math

STOPS = [(0.0, (132, 214, 96)), (0.5, (36, 190, 158)), (1.0, (64, 152, 236))]  # grass → teal → sky

def grad_color(t):
    for (t0, c0), (t1, c1) in zip(STOPS, STOPS[1:]):
        if t0 <= t <= t1:
            f = (t - t0) / (t1 - t0)
            return tuple(int(c0[i] + (c1[i] - c0[i]) * f) for i in range(3))
    return STOPS[-1][1]

def make(N, out):
    SS = 4; W = N * SS
    # gradient along the main diagonal
    small = 256
    g = Image.new('RGB', (small, small))
    gp = g.load()
    for y in range(small):
        for x in range(small):
            gp[x, y] = grad_color((x + y) / (2 * (small - 1)))
    g = g.resize((W, W), Image.BICUBIC).convert('RGBA')
    tile = Image.new('L', (W, W), 0)
    pad = round(W * 0.035); rad = round(W * 0.235)
    ImageDraw.Draw(tile).rounded_rectangle([pad, pad, W - pad, W - pad], radius=rad, fill=255)
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    img.paste(g, (0, 0), tile)

    # white block: rounded hexagon
    s = W / 64
    cx, cy, w = 32 * s, 33 * s, 15.5 * s
    h = w * 1.16; q = w * 0.5
    ty = cy - (h + q) / 2 + q * 0  # vertical centring of the whole hexagon
    top_y = cy - (q + h / 2 + q / 2) + q
    # hexagon points (top, upper-right, lower-right, bottom, lower-left, upper-left)
    T = (cx, cy - q - h / 2); UR = (cx + w, cy - h / 2); LR = (cx + w, cy + h / 2)
    B = (cx, cy + q + h / 2); LL = (cx - w, cy + h / 2); UL = (cx - w, cy - h / 2)
    C = (cx, cy - h / 2 + q)  # centre vertex where the three faces meet
    glyph = Image.new('L', (W, W), 0); gd = ImageDraw.Draw(glyph)
    r = 2.2 * s  # corner rounding
    # shrink then grow by r with round joins → rounded corners
    def shrink(p):
        return (cx + (p[0] - cx) * (1 - r / w * 0.9), cy + (p[1] - cy) * (1 - r / (h * 0.9)))
    hexa = [shrink(p) for p in (T, UR, LR, B, LL, UL)]
    gd.polygon(hexa, fill=255)
    gd.line(hexa + [hexa[0]], fill=255, width=int(r * 2), joint='curve')
    for p in hexa: gd.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=255)
    # gaps between faces: Y shape from the centre vertex
    gap = 1.25 * s
    cut = Image.new('L', (W, W), 0); cd = ImageDraw.Draw(cut)
    for a, b in [(C, (UL[0] - 3 * s, UL[1] - 1.5 * s)), (C, (UR[0] + 3 * s, UR[1] - 1.5 * s)), (C, (B[0], B[1] + 4 * s))]:
        cd.line([a, b], fill=255, width=int(gap * 2))
    glyph = ImageChops.subtract(glyph, cut)
    white = Image.new('RGBA', (W, W), (255, 255, 255, 255))
    img.paste(white, (0, 0), glyph)
    img = img.resize((N, N), Image.LANCZOS)
    img.save(out)

if __name__ == '__main__':
    import os, sys
    if len(sys.argv) > 1:
        make(int(sys.argv[1]), sys.argv[2])
    else:
        os.makedirs('build/icons', exist_ok=True)
        make(1024, 'build/icon.png')
        # Linux icon theme sizes (hicolor has no 1024x1024 folder)
        for n in [16, 24, 32, 48, 64, 128, 256, 512]:
            make(n, f'build/icons/{n}x{n}.png')
