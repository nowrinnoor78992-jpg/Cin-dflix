#!/usr/bin/env python3
"""Crawl Cineplex and write a static Stremio addon (catalog/meta). stdlib only."""
import re, json, os, sys, time, html, urllib.request, urllib.parse
CX = "http://103.136.200.66"
OUT = sys.argv[1] if len(sys.argv) > 1 else "."
UA = "Mozilla/5.0 (SMART-TV; Tizen 6.5) AppleWebKit/537.36"
def get(path):
    u = path if path.startswith("http") else CX + "/" + path.lstrip("/")
    for i in range(3):
        try:
            return urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=30).read().decode("utf-8", "replace")
        except Exception as e:
            err = e; time.sleep(2)
    print("FAIL", u, err, file=sys.stderr); return ""
def cards(h):
    out = []
    for m in re.finditer(r'<a[^>]+href="([^"]*(?:series_id=|view\.php\?id=|watch\.php\?id=)(\d+)[^"]*)"[^>]*>(.*?)</a>', h, re.S):
        href, i, inner = m.groups()
        t = re.search(r'alt="([^"]+)"', inner)
        img = re.search(r'<img[^>]+(?:data-src|src)="([^"]+)"', inner)
        if not t: continue
        out.append(("S" if "series_id=" in href else "M", i, html.unescape(t.group(1)).strip(),
                    urllib.parse.urljoin(CX + "/", img.group(1)) if img else None))
    return out
def cats(h, script):
    return sorted(set(urllib.parse.unquote_plus(c) for c in re.findall(script + r'\?category=([^"&\']+)', h)))
def crawl(listing, script, kind):
    found = {}
    for c in cats(get(listing), script):
        p = 1
        while p < 400:
            h = get(f"{script}?category={urllib.parse.quote_plus(c)}&page={p}")
            cs = [x for x in cards(h) if x[0] == kind]
            new = [x for x in cs if x[1] not in found]
            if not cs or not new: break
            for k, i, t, im in new: found[i] = (t, im, c)
            p += 1
        print(kind, c, len(found), file=sys.stderr)
    return found
def write(p, o):
    os.makedirs(os.path.dirname(p), exist_ok=True); json.dump(o, open(p, "w"), ensure_ascii=False)
series = crawl("tvs.php", "tcategory.php", "S")
movies = crawl("index.php", "category.php", "M")
def metas(d, kind, pre):
    return [{"id": f"cpx{pre}{i}", "type": kind, "name": t, "poster": im, "genres": [c]} for i, (t, im, c) in sorted(d.items(), key=lambda x: x[1][0].lower())]
PAGE = 15
def paged(cid, kind, items):
    base = f"{OUT}/catalog/{kind}/{cid}"
    write(base + ".json", {"metas": items[:PAGE]})
    for k in range(PAGE, len(items), PAGE):
        write(f"{base}/skip={k}.json", {"metas": items[k:k+PAGE]})
def slug(c): return re.sub(r"[^a-z0-9]+", "-", c.lower()).strip("-")
sm, mm = metas(series, "series", "S"), metas(movies, "movie", "M")
paged("cineplex-series", "series", sm)
paged("cineplex-movies", "movie", mm)
gseries = sorted(set(v[2] for v in series.values())); gmovie = sorted(set(v[2] for v in movies.values()))
catalogs = [{"type": "series", "id": "cineplex-series", "name": "Cineplex Series", "extra": [{"name": "genre", "options": gseries}, {"name": "skip"}]},
            {"type": "movie", "id": "cineplex-movies", "name": "Cineplex Movies", "extra": [{"name": "genre", "options": gmovie}, {"name": "skip"}]}]
for kind, d, ms, cid0 in (("series", series, sm, "cineplex-series"), ("movie", movies, mm, "cineplex-movies")):
    for c in sorted(set(v[2] for v in d.values())):
        items = [m for m in ms if m["genres"] == [c]]
        base = f"{OUT}/catalog/{kind}/{cid0}/genre={c}"
        write(base + ".json", {"metas": items[:PAGE]})
        for k in range(PAGE, len(items), PAGE):
            write(f"{base}&skip={k}.json", {"metas": items[k:k+PAGE]})
for kind, d, ms in (("series", series, sm), ("movie", movies, mm)):
    for c in sorted(set(v[2] for v in d.values())):
        cid = f"cx-{kind}-{slug(c)}"
        paged(cid, kind, [m for m in ms if m["genres"] == [c]])
        catalogs.append({"type": kind, "id": cid, "name": f"Cineplex {c}", "extra": [{"name": "skip"}]})
mf = json.load(open(f"{OUT}/manifest.json")); mf["catalogs"] = catalogs
json.dump(mf, open(f"{OUT}/manifest.json", "w"), ensure_ascii=False)
# series meta with episodes (tview.php)
for i, (t, im, c) in series.items():
    h = get(f"tview.php?id={i}")
    eps = sorted(set((int(s), int(e)) for s, e in re.findall(r'season=(\d+)&(?:amp;)?ep=(\d+)', h)))
    if not eps: eps = [(1, e) for e in range(1, 2)]
    vids = [{"id": f"cpxS{i}:{s}:{e}", "title": f"Episode {e}", "season": s, "episode": e, "released": "2020-01-01T00:00:00.000Z"} for s, e in eps]
    write(f"{OUT}/meta/series/cpxS{i}.json", {"meta": {"id": f"cpxS{i}", "type": "series", "name": t, "poster": im, "videos": vids}})
for i, (t, im, c) in movies.items():
    write(f"{OUT}/meta/movie/cpxM{i}.json", {"meta": {"id": f"cpxM{i}", "type": "movie", "name": t, "poster": im}})
print("series", len(series), "movies", len(movies))
