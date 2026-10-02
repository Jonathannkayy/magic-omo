#!/usr/bin/env python3
"""Minimal ANSI(SGR)->HTML->PNG renderer used for docs/assets screenshots (headless Chrome + Pillow).

usage: ansi2png.py in.ans out.png [--cols N] [--first L] [--last L] [--title T] [--scale 2] [--wrap]
  Input is `tmux capture-pane -e -p` (or `script` output). Redaction runs BEFORE rendering:
  SHOT_HOME_PREFIXES=/a/demo/home:/a/demo/data=~/.local/share   colon-separated prefixes rewritten
                                            to "~" (or to the text after "=")
  SHOT_REDACT_WORDS=name1,name2             literal words replaced with <acct>
  plus $HOME -> "~", e-mail addresses, sk-/JWT-looking tokens. Prints LEAK if a check still matches.
"""
import argparse, html, re, subprocess, sys, os

BASE16 = ["#1c1f26","#e06c75","#98c379","#e5c07b","#61afef","#c678dd","#56b6c2","#abb2bf",
          "#5c6370","#ff7b86","#b5e890","#ffd68a","#82c4ff","#de9cf0","#7fd6e0","#e6e8ee"]
FG_DEF, BG_DEF = "#d7dae0", "#0f1117"

def c256(n):
    if n < 16: return BASE16[n]
    if n < 232:
        n -= 16; r, g, b = n // 36, (n // 6) % 6, n % 6
        f = lambda v: 0 if v == 0 else 55 + v * 40
        return "#%02x%02x%02x" % (f(r), f(g), f(b))
    v = 8 + (n - 232) * 10; return "#%02x%02x%02x" % (v, v, v)

HOME_PREFIXES = [p for p in os.environ.get("SHOT_HOME_PREFIXES", "").split(":") if p]

def _redactions():
    pairs = [(p.split("=", 1) + ["~"])[:2] for p in HOME_PREFIXES]
    rules = [(re.compile(re.escape(a)), b) for a, b in sorted(pairs, key=lambda x: len(x[0]), reverse=True)]
    home = os.path.expanduser("~")
    rules += [
        (re.compile(r"(?:/[\w.-]+)*/\.nvm/versions/node/[\w.]+"), "~/.nvm/…"),
        (re.compile(r"(?:/[\w.-]+)*/site-packages"), "<venv>"),
        (re.compile(re.escape(home)), "~"),
        (re.compile(r"[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b"), "<redacted>"),
        (re.compile(r"\b(sk-[\w-]{8,}|eyJ[\w-]{10,}\.[\w-]+\.[\w-]+)"), "<token>"),
    ]
    rules += [(re.compile(re.escape(w)), "<acct>") for w in os.environ.get("SHOT_REDACT_WORDS", "").split(",") if w]
    return rules

REDACT = _redactions()

def redact(s):
    for rx, rep in REDACT: s = rx.sub(rep, s)
    return s

SGR = re.compile(r"\x1b\[([0-9;:]*)m")
OTHER = re.compile(r"\x1b(\[[0-9;?]*[A-Za-ln-z]|\][^\x07\x1b]*(\x07|\x1b\\)|[()][A-Z0-9])")

def convert_line(line):
    line = OTHER.sub("", line)
    st = dict(fg=None, bg=None, b=False, d=False, i=False, u=False, inv=False)
    out, pos = [], 0
    def emit(text):
        if not text: return
        fg, bg = st["fg"] or FG_DEF, st["bg"]
        if st["inv"]: fg, bg = (bg or BG_DEF), (st["fg"] or FG_DEF)
        css = ["color:" + fg]
        if bg: css.append("background:" + bg)
        if st["b"]: css.append("font-weight:700")
        if st["d"]: css.append("opacity:.6")
        if st["i"]: css.append("font-style:italic")
        if st["u"]: css.append("text-decoration:underline")
        out.append('<span style="%s">%s</span>' % (";".join(css), html.escape(text)))
    for m in SGR.finditer(line):
        emit(line[pos:m.start()]); pos = m.end()
        ps = [int(x) if x.isdigit() else 0 for x in re.split("[;:]", m.group(1) or "0")]
        i = 0
        while i < len(ps):
            p = ps[i]
            if p == 0: st.update(fg=None, bg=None, b=False, d=False, i=False, u=False, inv=False)
            elif p == 1: st["b"] = True
            elif p == 2: st["d"] = True
            elif p == 3: st["i"] = True
            elif p == 4: st["u"] = True
            elif p == 7: st["inv"] = True
            elif p == 22: st["b"] = st["d"] = False
            elif p == 23: st["i"] = False
            elif p == 24: st["u"] = False
            elif p == 27: st["inv"] = False
            elif 30 <= p <= 37: st["fg"] = BASE16[p - 30]
            elif 90 <= p <= 97: st["fg"] = BASE16[p - 90 + 8]
            elif 40 <= p <= 47: st["bg"] = BASE16[p - 40]
            elif 100 <= p <= 107: st["bg"] = BASE16[p - 100 + 8]
            elif p == 39: st["fg"] = None
            elif p == 49: st["bg"] = None
            elif p in (38, 48) and i + 1 < len(ps):
                key = "fg" if p == 38 else "bg"
                if ps[i + 1] == 5 and i + 2 < len(ps): st[key] = c256(ps[i + 2]); i += 2
                elif ps[i + 1] == 2 and i + 4 < len(ps): st[key] = "#%02x%02x%02x" % tuple(ps[i + 2:i + 5]); i += 4
            i += 1
    emit(line[pos:])
    return "".join(out)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inp"); ap.add_argument("out")
    ap.add_argument("--cols", type=int, default=150)
    ap.add_argument("--first", type=int, default=0); ap.add_argument("--last", type=int, default=None)
    ap.add_argument("--title", default="omo")
    ap.add_argument("--scale", type=float, default=2)
    ap.add_argument("--strip-blank-runs", action="store_true")
    ap.add_argument("--wrap", action="store_true")
    a = ap.parse_args()
    raw = open(a.inp, encoding="utf-8", errors="replace").read().rstrip("\n").split("\n")
    raw = raw[a.first:a.last]
    if a.strip_blank_runs:
        keep, prev_blank = [], False
        for l in raw:
            blank = not SGR.sub("", OTHER.sub("", l)).strip()
            if blank and prev_blank: continue
            keep.append(l); prev_blank = blank
        raw = keep
    while raw and not SGR.sub("", raw[-1]).strip(): raw.pop()
    body = "\n".join(convert_line(redact(l)) for l in raw)
    rows = len(raw)
    charw, lineh, pad = 8.43, 19, 22
    w = int(a.cols * charw + 2 * pad + 4); h = int(rows * lineh * (3 if a.wrap else 1) + 2 * pad + 38 + 6)
    doc = f"""<!doctype html><meta charset=utf-8><style>
html,body{{margin:0;background:#0b0d12}}
.win{{width:{w}px;background:{BG_DEF};border-radius:10px;overflow:hidden;box-shadow:0 0 0 1px #262a33}}
.bar{{height:38px;background:#171a21;display:flex;align-items:center;padding:0 14px;gap:8px;font:13px -apple-system,'Segoe UI',sans-serif;color:#8a90a0}}
.dot{{width:12px;height:12px;border-radius:50%}} .t{{flex:1;text-align:center;margin-right:52px}}
pre{{margin:0;padding:{pad}px;font:14px/{lineh}px 'DejaVu Sans Mono','Noto Sans Mono','Liberation Mono',monospace;color:{FG_DEF};white-space:{'pre-wrap' if a.wrap else 'pre'};word-break:break-word;font-variant-ligatures:none}}
</style><div class=win><div class=bar><span class=dot style=background:#ff5f57></span><span class=dot style=background:#febc2e></span><span class=dot style=background:#28c840></span><span class=t>{html.escape(a.title)}</span></div><pre>{body}</pre></div>"""
    hp = os.path.splitext(a.out)[0] + ".html"
    open(hp, "w").write(doc)
    tmp = os.environ.get("TMPDIR", "/tmp")
    subprocess.run([os.environ.get("CHROME", "/opt/google/chrome/chrome"), "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
                    f"--user-data-dir={tmp}/chrome-shots", f"--force-device-scale-factor={a.scale}",
                    "--default-background-color=0b0d12ff",
                    f"--screenshot={os.path.abspath(a.out)}", f"--window-size={w},{h + 400}", "file://" + os.path.abspath(hp)],
                   check=True, capture_output=True)
    # crop to the window: find last row that is not page background
    from PIL import Image
    im = Image.open(a.out).convert("RGB"); W, H = im.size
    bg = (0x0b, 0x0d, 0x12); px = im.load(); bottom = H
    for y in range(H - 1, 0, -1):
        if any(px[x, y] != bg for x in range(0, W, 7)): bottom = y + 1; break
    right = W
    for x in range(W - 1, 0, -1):
        if any(px[x, y] != bg for y in range(0, bottom, 7)): right = x + 1; break
    im.crop((0, 0, right, bottom)).save(a.out)
    checks = [re.escape(os.path.expanduser("~")) + "/", r"[\w.+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}"]
    checks += [re.escape(w) for w in os.environ.get("SHOT_REDACT_WORDS", "").split(",") if w]
    leak = [p for p in checks if re.search(p, re.sub(r"<[^>]+>", "", doc), re.I)]
    print(a.out, f"{w}x{h} css px", "LEAK" if leak else "redaction ok", leak or "")

if __name__ == "__main__":
    main()
