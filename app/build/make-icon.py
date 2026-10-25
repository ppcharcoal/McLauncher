# Renders the Cairn app icon: three stacked blocks on a teal tile.
from PIL import Image, ImageDraw, ImageFilter
def make(N, out, bg=True):
    SS=4; W=N*SS
    img=Image.new('RGBA',(W,W),(0,0,0,0))
    if bg:
        grad=Image.new('RGBA',(W,W)); gd=ImageDraw.Draw(grad)
        top=(112,218,190); bot=(28,112,98)
        for y in range(W):
            t=y/(W-1); gd.line([(0,y),(W,y)],fill=tuple(int(top[i]*(1-t)+bot[i]*t) for i in range(3))+(255,))
        mask=Image.new('L',(W,W),0); pad=int(W*0.06)
        ImageDraw.Draw(mask).rounded_rectangle([pad,pad,W-pad,W-pad],radius=int(W*0.22),fill=255)
        img.paste(grad,(0,0),mask)
    s=W/64
    P=lambda pts:[(x*s,y*s) for x,y in pts]
    # cubes: (cx, bottom_y, half_width)
    # stack: each cube sits centred on the top face of the one below (slight offsets, like stones)
    ws=[12.0, 8.6, 5.6]; offs=[0, -1.3, 0.9]
    raw=[]; by=0.0
    for i,w in enumerate(ws):
        h=w*1.12; q=w*0.5
        if i>0:
            pw=ws[i-1]; ph=pw*1.12; pq=pw*0.5
            pty=raw[-1][1]-ph-pq
            by=pty+q
        raw.append((offs[i], by, w))
    topmost=raw[-1][1]-ws[-1]*1.12-ws[-1]   # top vertex of the top cube
    height=0-topmost
    y0=32+height/2   # centre the stack vertically
    cubes=[(32+o, y0+b, w) for o,b,w in raw]
    shadow=Image.new('RGBA',(W,W),(0,0,0,0)); sd=ImageDraw.Draw(shadow)
    def faces(cx,by,w):
        h=w*1.12; q=w*0.5
        ty=by-h-q  # top-face center
        top=[(cx,ty-q),(cx+w,ty),(cx,ty+q),(cx-w,ty)]
        left=[(cx-w,ty),(cx,ty+q),(cx,ty+q+h),(cx-w,ty+h)]
        right=[(cx,ty+q),(cx+w,ty),(cx+w,ty+h),(cx,ty+q+h)]
        return top,left,right
    for cx,by,w in cubes:
        t,l,r=faces(cx,by,w); sd.polygon(P(l+r[1:3]),fill=(6,45,38,110))
    shadow=shadow.filter(ImageFilter.GaussianBlur(W*0.018)); img.alpha_composite(shadow,(int(W*0.006),int(W*0.022)))
    d=ImageDraw.Draw(img,'RGBA')
    for cx,by,w in cubes:
        t,l,r=faces(cx,by,w)
        g=0.55
        d.polygon(P(t),fill=(255,255,255,255))
        d.polygon(P([(l[0][0],l[0][1]+g),(l[1][0]-g*0.6,l[1][1]+g*0.4),(l[2][0]-g*0.6,l[2][1]),(l[3][0],l[3][1])]),fill=(214,244,236,255))
        d.polygon(P([(r[0][0]+g*0.6,r[0][1]+g*0.4),(r[1][0],r[1][1]+g),(r[2][0],r[2][1]),(r[3][0]+g*0.6,r[3][1])]),fill=(156,220,204,255))
    img.resize((N,N),Image.LANCZOS).save(out)
if __name__=='__main__':
    import os
    os.makedirs('build/icons', exist_ok=True)
    make(1024, 'build/icon.png')
    # Linux icon theme sizes (hicolor has no 1024x1024 folder)
    for n in [16, 24, 32, 48, 64, 128, 256, 512]:
        make(n, f'build/icons/{n}x{n}.png')
