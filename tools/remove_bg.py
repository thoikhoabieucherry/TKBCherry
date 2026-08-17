"""Tách nền trắng của logo bằng flood-fill từ viền ảnh.
Chỉ xóa vùng nền trắng nối liền với mép ảnh, giữ nguyên các ô lưới trắng
nằm bên trong quả cherry (vì chúng bị bao quanh bởi màu đỏ)."""
import sys
from collections import deque
from PIL import Image

SRC = sys.argv[1]
DST = sys.argv[2]
THRESH = int(sys.argv[3]) if len(sys.argv) > 3 else 232

img = Image.open(SRC).convert("RGBA")
w, h = img.size
px = img.load()

def is_bg(r, g, b):
    return r >= THRESH and g >= THRESH and b >= THRESH

visited = bytearray(w * h)
dq = deque()

for x in range(w):
    for y in (0, h - 1):
        i = y * w + x
        if not visited[i]:
            r, g, b, a = px[x, y]
            if is_bg(r, g, b):
                visited[i] = 1
                dq.append((x, y))
for y in range(h):
    for x in (0, w - 1):
        i = y * w + x
        if not visited[i]:
            r, g, b, a = px[x, y]
            if is_bg(r, g, b):
                visited[i] = 1
                dq.append((x, y))

while dq:
    x, y = dq.popleft()
    px[x, y] = (255, 255, 255, 0)
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nx, ny = x + dx, y + dy
        if 0 <= nx < w and 0 <= ny < h:
            ni = ny * w + nx
            if not visited[ni]:
                r, g, b, a = px[nx, ny]
                if is_bg(r, g, b):
                    visited[ni] = 1
                    dq.append((nx, ny))

# Cắt sát biên (bounding box của phần không trong suốt) cho gọn
bbox = img.getbbox()
if bbox:
    img = img.crop(bbox)

img.save(DST)
print("saved", DST, img.size)
