from PIL import Image, ImageDraw, ImageFilter
import sys
def make(N, out):
    SS=4; W=N*SS
    img=Image.new('RGBA',(W,W),(0,0,0,0))
    grad=Image.new('RGBA',(W,W)); gd=ImageDraw.Draw(grad)
    top=(112,218,190); bot=(30,118,102)
    for y in range(W):
        t=y/(W-1); gd.line([(0,y),(W,y)],fill=tuple(int(top[i]*(1-t)+bot[i]*t) for i in range(3))+(255,))
    mask=Image.new('L',(W,W),0); pad=int(W*0.06)
    ImageDraw.Draw(mask).rounded_rectangle([pad,pad,W-pad,W-pad],radius=int(W*0.22),fill=255)
    img.paste(grad,(0,0),mask)
    s=W/64; P=lambda pts:[(x*s,y*s) for x,y in pts]
    sh=Image.new('RGBA',(W,W),(0,0,0,0))
    ImageDraw.Draw(sh).polygon(P([(16,24),(32,33),(48,24),(48,43),(32,52),(16,43)]),fill=(8,48,40,120))
    sh=sh.filter(ImageFilter.GaussianBlur(W*0.022)); img.alpha_composite(sh,(0,int(W*0.025)))
    d=ImageDraw.Draw(img,'RGBA'); g=1.1
    d.polygon(P([(32,14),(48,23),(32,32),(16,23)]),fill=(255,255,255,255))
    d.polygon(P([(16,23+g),(32-g*0.6,32+g*0.4),(32-g*0.6,50),(16,41)]),fill=(214,244,236,255))
    d.polygon(P([(32+g*0.6,32+g*0.4),(48,23+g),(48,41),(32+g*0.6,50)]),fill=(160,222,206,255))
    img.resize((N,N),Image.LANCZOS).save(out)
make(1024,'build/icon.png'); 

# Linux icon theme sizes (hicolor has no 1024x1024 folder)
import os
os.makedirs('build/icons', exist_ok=True)
for n in [16, 24, 32, 48, 64, 128, 256, 512]:
    make(n, f'build/icons/{n}x{n}.png')
