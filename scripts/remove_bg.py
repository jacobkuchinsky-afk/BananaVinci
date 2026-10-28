"""Background removal for BananaVinci (rembg, runs locally).

usage: python scripts/remove_bg.py <in-image> <out.png>

If the image already has real transparency it is copied as-is (as PNG). Otherwise rembg cuts out the subject
and the result is trimmed to the visible pixels plus a small margin. Prints "OK <width> <height>".
"""
import sys

from PIL import Image


def main():
    src, out = sys.argv[1], sys.argv[2]
    img = Image.open(src)
    img.seek(0)
    img = img.convert("RGBA")
    alpha = img.getchannel("A")
    lo, _ = alpha.getextrema()
    if lo < 250:  # already has transparent areas: keep the artist's cutout
        result = img
    else:
        from rembg import new_session, remove

        session = new_session("u2net")
        result = remove(img, session=session, post_process_mask=True)
    box = result.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    if box:
        pad = max(4, int(max(result.size) * 0.02))
        l, t, r, b = box
        result = result.crop((max(0, l - pad), max(0, t - pad), min(result.width, r + pad), min(result.height, b + pad)))
    result.save(out, "PNG", optimize=True)
    print(f"OK {result.width} {result.height}", flush=True)


if __name__ == "__main__":
    main()
