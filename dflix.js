// CineFlex scraper for Nuvio (Legacy tpk / plugin runtime).  v1.3.3
// Sources: CineplexBD (new server), FTPBD (open folder listings), ShowTime (ISP-only).  Movies and series.
//
// New CineplexBD server (http://103.136.200.66):
//  - /search_ajax.php?q=..&limit=..  -> JSON { results: [{id,type,title,year,category,url,poster}] }
//  - /watch.php?id=ID&series_id=ID&season=S&ep=E&autoplay=1 renders <source src="/hls/.../master.m3u8">
//  - /hls/ only answers with the cookies hlse / hlsk (+ REDFORCE), which the server sets as Set-Cookie
//    (HttpOnly).  This runtime's fetch() exposes Set-Cookie, so we keep the cookies and send them back
//    as a Cookie header with the stream (the TV player applies Cookie / User-Agent).

var CX = "http://103.136.200.66";
var ST = "http://10.100.100.10";
var UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
var DEFAULT_TMDB_KEY = "7720837cae51542c691532949b360141"; // same default key the DFLIX app uses
var VIDX = /\.(mp4|mkv|avi|m4v|mov|webm|ts|mpg|wmv|flv)(\?|$)/i;
var QUALITY = /(2160p|4k|1080p|720p|480p|WEB-?DL|WEBRip|BluRay|HDRip|DVDRip|HDTV|CAMRip|HDCAM)/i;
var TIMEOUT = 12000;

// ---- MANUAL LIST: titles the site spells so differently that no search finds them ----------------
// Left: the title as TMDB / Nuvio shows it (capitals and spaces do not matter).
// Right: the number in the site link, e.g. watch.php?series_id=34023  ->  34023
// Add a line per title, with a comma at the end of each line except the last.
var MANUAL_SERIES = {
  "Lalkuthi": 34023
};
// movies: the number in view.php?id=...
var MANUAL_MOVIE = {
};

var DBG = [];
var CK = {}; // cookies the new server hands out (hlse / hlsk / REDFORCE ... whatever it sets)
var CK_TIME = 0;
var COOKIE_ATTR = /^(path|domain|expires|max-age|samesite|secure|httponly|priority|partitioned)$/i;

function ckString() {
  return Object.keys(CK).map(function (k) { return k + "=" + CK[k]; }).join("; ");
}

function ckNames() { return Object.keys(CK).join(","); }

function grabCookies(r) {
  try {
    // same as the version that worked on the TV: only the three gate cookies
    var sc = (r.headers && r.headers.get && r.headers.get("set-cookie")) || "";
    var re = /(hlse|hlsk|REDFORCE)=([^;,\s]+)/g, m;
    while ((m = re.exec(sc))) { CK[m[1]] = m[2]; CK_TIME = Date.now(); }
    return !!sc;
  } catch (e) { return false; }
}

function tmdbKey() {
  var s = typeof SCRAPER_SETTINGS !== "undefined" && SCRAPER_SETTINGS ? SCRAPER_SETTINGS : {};
  return (typeof TMDB_API_KEY !== "undefined" && TMDB_API_KEY) || s.tmdbKey || DEFAULT_TMDB_KEY;
}

// the Nuvio engine enforces its own deadline and request / timer quotas, so a plain fetch is the safest
function timedFetch(url, opts) {
  return fetch(url, opts || {});
}

function getText(url) {
  var isCx = url.indexOf(CX) === 0;
  var h = {};
  if (isCx) {
    h["User-Agent"] = UA;
    h["Accept"] = "text/html,application/json,*/*";
    if (ckString()) h["Cookie"] = ckString();
  }
  return timedFetch(url, { headers: h }).then(function (r) {
    if (isCx) grabCookies(r);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  });
}

function fix(u) {
  return String(u)
    .replace(/%(?![0-9A-Fa-f]{2})/g, "%25")
    .replace(/[ \[\]"<>^`{|}\\]/g, function (c) { return encodeURIComponent(c); })
    .replace(/#/g, "%23");
}

function absUrl(h, base) {
  h = String(h || "").replace(/&amp;/g, "&");
  if (/^https?:/i.test(h)) return h;
  base = base || CX + "/";
  var origin = (base.match(/^https?:\/\/[^\/]+/i) || [""])[0];
  if (h.charAt(0) === "/") return origin + h;
  return base.replace(/[^\/?#]*([?#].*)?$/, "") + h.replace(/^\.\//, "");
}

function norm(s) {
  return String(s || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}

function baseTitle(s) {
  var cut = String(s || "").split(/[\(\[]|\b(?:19|20)\d{2}\b|2160p|1080p|720p|480p|WEB-?DL|BluRay|HDRip/i)[0];
  return norm(cut);
}

function yearOf(s) {
  var m = String(s || "").match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : null;
}

function squash(s) { return norm(s).replace(/ /g, "").replace(/(.)\1+/g, "$1"); } // "Laalkuthi" == "Lal Kuthi" == "Lalkuthi"

function titleMatches(title, year, wantTitle, wantYear) {
  if (baseTitle(title) !== norm(wantTitle) && squash(baseTitle(title)) !== squash(wantTitle)) return false;
  var y = Number(year) || yearOf(title);
  if (wantYear && y && Math.abs(y - wantYear) > 1) return false;
  return true;
}

function decodeHtml(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

// every playable link in a CineplexBD page: <source src>, <video src>, or any quoted media URL
function cxVideos(html, base) {
  var clean = html.replace(/\\\//g, "/");
  var out = [], m;
  var reSrc = /<(?:source|video)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  while ((m = reSrc.exec(clean))) {
    if (/\.(?:m3u8|mp4|mkv|avi|webm|mov)(?:\?|$)/i.test(m[1]) || /\/hls\//i.test(m[1])) out.push(absUrl(m[1], base));
  }
  if (!out.length) {
    var abs = clean.match(/https?:\/\/[^"'\s<>\\]+?\.(?:mp4|mkv|m3u8|avi|webm|mov)(?:\?[^"'\s<>\\]*)?(?=["'\s<>\\])/gi) || [];
    out = out.concat(abs);
    var re = /["']([^"'<>]+?\.(?:mp4|mkv|m3u8|avi|webm|mov)(?:\?[^"'<>]*)?)["']/gi;
    while ((m = re.exec(clean))) out.push(absUrl(m[1], base));
  }
  var seen = {};
  return out.map(fix).filter(function (u) { if (seen[u]) return false; seen[u] = 1; return true; });
}

function makeStream(label, url, title, withHeaders) {
  // quality from the title, else from the file name in the link; Cineplex links without any -> HD
  var q = (String(title).match(QUALITY) || [])[1] || (String(url).match(QUALITY) || [])[1] || (label === "CineplexBD" ? "HD" : "Unknown");
  if (withHeaders && ckNames()) title = title + " · ck:" + ckNames();
  var s = { name: label, title: title, quality: /^\d+p$/i.test(q) ? q.toLowerCase() : q.toUpperCase(), url: url };
  if (withHeaders) {
    s.headers = { "User-Agent": UA, "Referer": CX + "/" };
    if (ckString()) s.headers["Cookie"] = ckString();
  }
  return s;
}

function getInfo(tmdbId, mediaType) {
  var kind = mediaType === "movie" ? "movie" : "tv";
  return getText("https://api.themoviedb.org/3/" + kind + "/" + tmdbId + "?api_key=" + tmdbKey()).then(function (t) {
    var j = JSON.parse(t);
    var anim = (j.genres || []).some(function (g) { return g && g.id === 16; });
    return { name: j.title || j.name || "", original: j.original_title || j.original_name || "",
             year: yearOf(j.release_date || j.first_air_date), lang: j.original_language || "", anim: anim };
  });
}

function manualId(table, info) {
  var names = [info.name, info.original];
  for (var i = 0; i < names.length; i++) {
    if (!names[i]) continue;
    var k = squash(names[i]);
    for (var key in table) if (Object.prototype.hasOwnProperty.call(table, key) && squash(key) === k) return table[key];
  }
  return null;
}

// ---- CineplexBD search -------------------------------------------------------------------------
// result card in the HTML pages: <a href="watch.php?series_id=ID..."> ... alt="Title" ... catLabel ... year
function parseCards(html) {
  var out = [], seen = {};
  var parts = String(html).split(/<a\s+href="/i);
  for (var i = 1; i < parts.length; i++) {
    var p = parts[i];
    var m = p.match(/^([^"]*?(watch|tview|view)\.php\?[^"]*?\b(?:series_id|id)=(\d+)[^"]*)"/i);
    if (!m || seen[m[3] + m[2]]) continue;
    var chunk = p.slice(0, 2500);
    var alt = chunk.match(/\balt="([^"]+)"/i);
    if (!alt) continue;
    var cat = chunk.match(/catLabel[^>]*>([^<]+)</i);
    var yr = chunk.match(/>\s*((?:19|20)\d{2})\s*</);
    seen[m[3] + m[2]] = 1;
    out.push({ id: m[3], series: /^(watch|tview)$/i.test(m[2]), title: decodeHtml(alt[1]).trim(),
               year: yr ? Number(yr[1]) : null, category: cat ? decodeHtml(cat[1]).trim() : "" });
  }
  return out;
}

function searchCx(title) {
  return getText(CX + "/search_ajax.php?q=" + encodeURIComponent(title) + "&limit=30")
    .then(function (t) {
      var j = JSON.parse(t);
      var arr = j.results || j || [];
      var list = (Array.isArray(arr) ? arr : []).map(function (i) {
        var isSeries = String(i.type || "").toLowerCase() === "series";
        return { id: i.id, series: isSeries, title: i.title || "", year: i.year ? Number(i.year) : null,
                 category: i.category || "" };
      });
      DBG.push("CX ajax: " + list.length);
      if (list.length) return list;
      throw new Error("empty");
    })
    .catch(function (e) {
      // fall back to the normal search page
      return getText(CX + "/search.php?q=" + encodeURIComponent(title))
        .then(function (html) {
          var list = parseCards(html);
          DBG.push("CX page: " + list.length);
          return list;
        })
        .catch(function (e2) { DBG.push("CX search error: " + (e2 && e2.message)); return []; });
    });
}

// the site search is a plain substring search, so "Lalkuthi" does not find "Lal Kuthi":
// try the full title, the original title, the first word and the first letters of a long single word
function searchQueries(info) {
  var qs = [info.name];
  if (info.original && info.original !== info.name) qs.push(info.original);
  var w = norm(info.name).split(" ");
  if (w.length > 1 && w[0].length >= 3) qs.push(w[0]);
  if (w.length === 1 && w[0].length >= 6) { qs.push(w[0].slice(0, 3)); qs.push(w[0].slice(0, 5)); qs.push(w[0].slice(-5)); }
  var seen = {};
  return qs.filter(function (q) { if (!q || seen[q]) return false; seen[q] = 1; return true; }).slice(0, 5);
}

function searchCxFuzzy(info, good) {
  var qs = searchQueries(info), last = [], i = 0;
  function next() {
    if (i >= qs.length) return Promise.resolve(last);
    var q = qs[i++];
    return searchCx(q).then(function (list) {
      last = list;
      return good(list) ? list : next();
    });
  }
  return next();
}

// ---- ShowTime ----------------------------------------------------------------------------------
// ShowTime search page -> { files: [{title,url,size}], dirs: [{title,url}] }
function searchSt(title) {
  return getText(ST + "/movie/search?search=" + encodeURIComponent(title))
    .then(function (html) {
      var $ = cheerio.load(html), files = [], dirs = [];
      $(".single_movie").toArray().forEach(function (el) {
        var m = $(el);
        var ttl = (m.find("figcaption a").first().text() || "").replace(/\s+/g, " ").trim();
        var dl = m.find("figcaption p a[href]").first().attr("href") || "";
        if (!ttl || !dl) return;
        var url = fix(absUrl(dl, ST + "/"));
        if (VIDX.test(dl)) files.push({ title: ttl, url: url, size: (m.find("h6").first().text() || "").trim() });
        else if (/\/$/.test(dl.split("?")[0]) && /SERIES|SHOW/i.test(dl)) dirs.push({ title: ttl, url: url });
      });
      DBG.push("ST: " + files.length + " file, " + dirs.length + " folder");
      return { files: files, dirs: dirs };
    })
    .catch(function (e) { DBG.push("ST error: " + (e && e.message)); return { files: [], dirs: [] }; });
}

// one folder listing -> its video files and sub-folders
function dirScan(url) {
  return getText(url)
    .then(function (html) {
      var $ = cheerio.load(html), base = fix(url.replace(/\/?$/, "/")), files = [], subs = [], seen = {};
      $("a[href]").toArray().forEach(function (el) {
        var h = $(el).attr("href") || "";
        if (!h || /^(\.\.?\/|\?|#|mailto:|javascript:)/i.test(h)) return;
        var u = /^https?:/i.test(h) ? h : h.charAt(0) === "/" ? (base.match(/^https?:\/\/[^\/]+/i) || [""])[0] + h : base + h.replace(/^\.?\//, "");
        u = u.split("#")[0];
        if (base.indexOf(u.replace(/\/?$/, "/")) === 0 || u.indexOf(base) !== 0 || seen[u]) return;
        seen[u] = 1;
        var rel = u.slice(base.length), name = rel;
        try { name = decodeURIComponent(rel.split("?")[0]); } catch (e) {}
        if (VIDX.test(rel)) files.push({ url: u, name: name });
        else if (/\/$/.test(rel.split("?")[0])) subs.push({ url: u, name: name.replace(/\/$/, "") });
      });
      return { files: files, subs: subs };
    })
    .catch(function () { return null; });
}

// ---- FTPBD (open "h5ai" folder listings: no login, no cookies) ----------------------------------
var FTP_MOVIE_ROOTS = [
  ["English Movies", "https://server2.ftpbd.net/FTP-2/English%20Movies/"],
  ["English Dual Audio", "https://server2.ftpbd.net/FTP-2/English%20Movies/Dual-Audio/"],
  ["Hindi Movies", "https://server3.ftpbd.net/FTP-3/Hindi%20Movies/"],
  ["South Indian Movies", "https://server3.ftpbd.net/FTP-3/South%20Indian%20Movies/"],
  ["Foreign Movies", "https://server3.ftpbd.net/FTP-3/Foreign%20Language%20Movies/"],
  ["Bangla Collection", "https://server3.ftpbd.net/FTP-3/Bangla%20Collection/BANGLA/"],
  ["Animation Movies", "https://server5.ftpbd.net/FTP-5/Animation%20Movies/"],
  ["Documentary", "https://server5.ftpbd.net/FTP-5/Documentary/"]
];
var FTP_SERIES_ROOTS = [
  ["Hindi TV Series", "https://server3.ftpbd.net/FTP-3/Hindi%20TV%20Series/"],
  ["Bengali TV Series", "https://server3.ftpbd.net/FTP-3/Bangla%20Collection/BANGLA/Web-Series/"],
  ["Awards & TV Shows", "https://server7.ftpbd.net/FTP-7/Awards--TV-Shows/"],
  ["Anime & Cartoon", "https://server5.ftpbd.net/FTP-5/Anime--Cartoon-TV-Series/"],
  ["English & Foreign TV", "http://172.16.50.12/DHAKA-FLIX-12/TV-WEB-Series/"]
];
var NO4K = /(^|[^a-z0-9])(4k|2160p|uhd)([^a-z0-9]|$)/i;
var SEASRE = /season|^s\d{1,2}\b|^series[\s._-]*\d/i;
var LISTC = {};
var FTP_DEADLINE = 20000;

// the engine limits how many requests a scraper may make, so only the folders that can hold the title are walked
function pickRoots(roots, names, info) {
  var l = String(info.lang || "").toLowerCase();
  if (!l) return roots;
  var want = [];
  if (l === "hi") want = ["Hindi"];
  else if (l === "bn") want = ["Bangla", "Bengali"];
  else if (l === "ta" || l === "te" || l === "ml" || l === "kn") want = ["South"];
  else if (l === "en") want = ["English"];
  else want = ["Foreign", "English"];
  if (info.anim) want = want.concat(["Animation", "Anime"]);
  var out = roots.filter(function (r) { return want.some(function (w) { return r[0].indexOf(w) >= 0; }); });
  return out.length ? out : roots;
} // the folder walk may never hold back the other sources

// resolve to [] if a source is slow, so the others still come through
function within(promise, ms, tag) {
  return new Promise(function (resolve) {
    var done = false;
    var t = setTimeout(function () { if (!done) { done = true; DBG.push(tag + " timeout"); resolve([]); } }, ms);
    promise.then(function (v) { if (!done) { done = true; clearTimeout(t); resolve(v); } },
                 function () { if (!done) { done = true; clearTimeout(t); DBG.push(tag + " error"); resolve([]); } });
  });
}

function parseListing(t, base) {
  var out = { dirs: [], vids: [] }, m, n = 0;
  function add(h, name, size) {
    h = decodeHtml(h);
    if (!h || h === ".." || h.charAt(0) === "?" || h.charAt(0) === "#" || /^parent directory$/i.test(name)) return;
    var it = { name: name, url: fix(absUrl(h, base)), size: size || "" };
    n++;
    if (/\/$/.test(h)) { it.name = name.replace(/\/$/, ""); out.dirs.push(it); }
    else if (VIDX.test(name)) out.vids.push(it);
  }
  var re = /<td class="fb-n"><a href="([^"]*)">([^<]*)<\/a><\/td><td class="fb-d">([^<]*)<\/td><td class="fb-s">([^<]*)<\/td>/g;
  while ((m = re.exec(t))) add(m[1], decodeHtml(m[2]).trim(), decodeHtml(m[4]).trim());
  if (!n) { // plain "Index of" page
    var re2 = /<a href="([^"?#]+)"[^>]*>([^<]+)<\/a>/g;
    var rootLen = (base.match(/^https?:\/\/[^\/]+/i) || [""])[0].length;
    while ((m = re2.exec(t))) {
      var h = decodeHtml(m[1]);
      if (h.charAt(0) !== "/" || h.length > base.length - rootLen) add(h, decodeHtml(m[2]).trim(), "");
    }
  }
  return out;
}

function listDirRx(url) {
  if (LISTC[url]) return LISTC[url];
  LISTC[url] = timedFetch(url, { headers: { "User-Agent": UA } }, 10000)
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
    .then(function (t) { return parseListing(t, url); })
    .catch(function () { delete LISTC[url]; return null; });
  return LISTC[url];
}

// names like "2023", "2020-2021", "Movies 2019", "Before 2000"
function isYearDir(n) {
  return /(?:19|20)\d{2}/.test(n) || /before$/i.test(n);
}
function yearDirHas(n, y) {
  var ys = String(n).match(/(?:19|20)\d{2}/g);
  if (!ys || !y) return false;
  var a = Number(ys[0]), z = Number(ys[ys.length - 1]);
  if (/before|older|pre/i.test(n) && ys.length === 1) return y <= a;
  return y >= Math.min(a, z) && y <= Math.max(a, z);
}

function sortFiles(a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; }

// walk one root: title folder directly, else the year / letter sub-folders that can contain it
function ftpFindDirs(root, wantYear, isMatch, firstChars) {
  return listDirRx(root[1]).then(function (d) {
    if (!d) { DBG.push("FTP " + root[0] + ": offline"); return []; }
    var hits = d.dirs.filter(function (x) { return isMatch(x.name); });
    if (hits.length) return hits;
    var subs = d.dirs.filter(function (x) {
      if (wantYear && yearDirHas(x.name, wantYear)) return true;
      var nm = x.name.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      return firstChars && nm.length > 0 && nm.length <= 3 && firstChars.indexOf(nm.charAt(0)) >= 0;
    }).slice(0, 3);
    if (!subs.length) return [];
    return Promise.all(subs.map(function (x) { return listDirRx(x.url); })).then(function (ds) {
      var out = [];
      ds.forEach(function (dd) { if (dd) out = out.concat(dd.dirs.filter(function (x) { return isMatch(x.name); })); });
      return out;
    });
  });
}

function ftpMovie(info) {
  var names = [info.name, info.original].filter(function (n) { return n; });
  var first = norm(info.name).charAt(0).toUpperCase();
  var firstChars = /[A-Z]/.test(first) ? first : "0";
  var match = function (n) { return names.some(function (w) { return titleMatches(n, null, w, info.year); }); };
  return Promise.all(pickRoots(FTP_MOVIE_ROOTS, null, info).map(function (root) {
    return ftpFindDirs(root, info.year, match, firstChars).then(function (dirs) {
      dirs = dirs.filter(function (x) { return !NO4K.test(x.name); }).slice(0, 2);
      return Promise.all(dirs.map(function (dir) {
        return listDirRx(dir.url).then(function (d) {
          if (!d) return [];
          if (d.vids.length) return d.vids;
          var subs = d.dirs.filter(function (x) { return !NO4K.test(x.name); }).slice(0, 3);
          return Promise.all(subs.map(function (x) { return listDirRx(x.url); })).then(function (ds) {
            var v = [];
            ds.forEach(function (dd) { if (dd) v = v.concat(dd.vids); });
            return v;
          });
        });
      })).then(function (lists) {
        var out = [];
        lists.forEach(function (l) { out = out.concat(l); });
        if (out.length) DBG.push("FTP " + root[0] + ": " + out.length + " file");
        return out.map(function (v) {
          return makeStream("FTPBD", v.url, v.name + (v.size ? " · " + v.size : ""), false);
        });
      });
    });
  })).then(function (r) {
    var out = [];
    r.forEach(function (l) { out = out.concat(l); });
    DBG.push("FTP movie: " + out.length);
    return out;
  }).catch(function (e) { DBG.push("FTP error: " + (e && e.message)); return []; });
}

// file list -> [{s, n, url, name}] using S01E02 / 1x02 / E02 in the names, else the order in the folder
function epsFromFiles(list, defSeason) {
  list = list.slice().sort(sortFiles);
  var cnt = {};
  return list.map(function (x) {
    var m = x.name.match(/S(\d{1,2})\s*[._ -]?\s*E(\d{1,3})/i) || x.name.match(/(?:^|[^0-9])(\d{1,2})x(\d{1,3})(?!\d)/i) || x.name.match(/(?:^|[^a-z0-9])E(?:p|pisode)?[._ -]?(\d{1,3})(?:[^0-9]|$)/i);
    var xs = m && m.length > 2 ? String(+m[1]) : null, xn = m ? +m[m.length - 1] : null;
    var sn = xs || x.ss || defSeason;
    cnt[sn] = (cnt[sn] || 0) + 1;
    return { s: sn, n: xn || cnt[sn], url: x.url, name: x.name, size: x.size };
  });
}

function seasonOfDir(name) {
  var m = String(name).match(/(?:season|series|s)[\s._-]*0*(\d{1,2})\b/i) || String(name).match(/\b0*(\d{1,2})\b/);
  return m ? String(+m[1]) : null;
}

function ftpSeries(info, season, episode) {
  var names = [info.name, info.original].filter(function (n) { return n; });
  var first = noThe(norm(info.name)).charAt(0).toUpperCase();
  var firstChars = /[A-Z]/.test(first) ? first : "0";
  var match = function (n) { return names.some(function (w) { return seriesNameMatches(n, w); }); };
  return Promise.all(pickRoots(FTP_SERIES_ROOTS, null, info).map(function (root) {
    return ftpFindDirs(root, info.year, match, firstChars).then(function (dirs) {
      dirs = dirs.filter(function (x) { return !NO4K.test(x.name); }).slice(0, 2);
      return Promise.all(dirs.map(function (dir) {
        return listDirRx(dir.url).then(function (d) {
          if (!d) return [];
          var seaDirs = d.dirs.filter(function (x) { return SEASRE.test(x.name) && !NO4K.test(x.name); });
          var files = d.vids.map(function (v) { v.ss = null; return v; });
          var wanted = seaDirs.filter(function (x) { return seasonOfDir(x.name) === String(Number(season)); });
          // a pack that is only "Season 1-3" style: look into every season folder (max 6)
          if (!wanted.length && seaDirs.length === 1) wanted = seaDirs;
          if (!wanted.length) return epsFromFiles(files, "1");
          return Promise.all(wanted.slice(0, 6).map(function (x) {
            return listDirRx(x.url).then(function (dd) {
              var ss = seasonOfDir(x.name) || String(Number(season));
              return dd ? dd.vids.map(function (v) { v.ss = ss; return v; }) : [];
            });
          })).then(function (ls) {
            var all = [];
            ls.forEach(function (l) { all = all.concat(l); });
            return epsFromFiles(all, String(Number(season)));
          });
        });
      })).then(function (lists) {
        var out = [];
        lists.forEach(function (eps) {
          eps.filter(function (e) { return e.s === String(Number(season)) && e.n === Number(episode); }).forEach(function (e) {
            out.push(makeStream("FTPBD", e.url, e.name + (e.size ? " · " + e.size : ""), false));
          });
        });
        if (dirs.length) DBG.push("FTP " + root[0] + ": " + dirs.length + " folder, " + out.length + " file");
        return out;
      });
    });
  })).then(function (r) {
    var out = [];
    r.forEach(function (l) { out = out.concat(l); });
    DBG.push("FTP series: " + out.length);
    return out;
  }).catch(function (e) { DBG.push("FTP error: " + (e && e.message)); return []; });
}

// ---- movies ------------------------------------------------------------------------------------
// all playable links of one Cineplex movie (player.php holds the signed mp4; view.php as a fallback)
function cxMovieLinks(id) {
  var href = CX + "/player.php?id=" + id;
  return getText(href).then(function (html) {
    var urls = cxVideos(html, href);
    if (urls.length) return urls;
    var v = CX + "/view.php?id=" + id;
    return getText(v).then(function (h2) { return cxVideos(h2, v); });
  }).catch(function (e) { DBG.push("CX movie error: " + (e && e.message)); return []; });
}

// Cineplex first: its links are listed before the other sources
function movieStreams(info) {
  return Promise.all([searchCxFuzzy(info, function (l) {
    return l.some(function (h) { return !h.series && titleMatches(h.title, h.year, info.name, info.year); });
  }), searchSt(info.name), within(ftpMovie(info), FTP_DEADLINE, "FTP movie")]).then(function (res) {
    var cxHits = res[0].filter(function (h) { return !h.series && titleMatches(h.title, h.year, info.name, info.year); }).slice(0, 3);
    var mmid = manualId(MANUAL_MOVIE, info);
    if (mmid && !cxHits.some(function (h) { return String(h.id) === String(mmid); })) cxHits.unshift({ id: mmid, series: false, title: info.name, year: info.year, category: "" });
    DBG.push("CX movie hits: " + cxHits.length);
    var others = [];
    res[1].files.filter(function (h) { return titleMatches(h.title, null, info.name, info.year); }).forEach(function (h) {
      others.push(makeStream("ShowTime", h.url, h.title + (h.size ? " · " + h.size : ""), false));
    });
    others = others.concat(res[2]);
    return Promise.all(cxHits.map(function (hit) {
      return cxMovieLinks(hit.id).then(function (urls) {
        return urls.map(function (u) { return makeStream("CineplexBD", u, hit.title + (hit.category ? " · " + hit.category : ""), true); });
      });
    })).then(function (lists) {
      var cx = [].concat.apply([], lists);
      // the cookies are only known once the pages were read: stamp them on every CineplexBD stream
      cx.forEach(function (s) { if (s.headers && ckString()) s.headers["Cookie"] = ckString(); });
      // same order as before: other sources first, Cineplex after them
      return others.concat(cx);
    });
  });
}

// ---- series ------------------------------------------------------------------------------------
function stripSeason(t) {
  return String(t || "").split(/\b(?:season|seasons|complete|s\d{1,2}(?:e\d+)?)\b/i)[0];
}

function noThe(s) { return s.replace(/^the /, ""); }

function seriesNameMatches(folderTitle, wantName) {
  var bt = noThe(baseTitle(stripSeason(folderTitle))), want = noThe(norm(wantName));
  return bt === want || bt.indexOf(want + " ") === 0 || (squash(bt) !== "" && squash(bt) === squash(want));
}

// season folder (or a pack with season sub-folders) -> [{s, n, url, name}] like the DFLIX app builds it
function stEpisodes(hit) {
  var sm = String(hit.title).match(/Season\s*(\d+)/i), ds = sm ? String(+sm[1]) : "1";
  return dirScan(hit.url).then(function (r) {
    if (!r) return [];
    var list = r.files.slice();
    var subs = r.subs.slice(0, 16);
    if (list.length || !subs.length) return list;
    return subs.reduce(function (p, sf, k) {
      return p.then(function () {
        return dirScan(sf.url).then(function (q) {
          var nm = sf.name.match(/(?:season|s)[ ._-]*(\d+)/i) || sf.name.match(/(\d+)/);
          var ss = nm ? String(+nm[1]) : String(k + 1);
          (q ? q.files : []).forEach(function (f) { f.ss = ss; list.push(f); });
        });
      });
    }, Promise.resolve()).then(function () { return list; });
  }).then(function (list) {
    list.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    var cnt = {};
    return list.map(function (x) {
      var m = x.name.match(/S(\d{1,2})\s*[._ -]?\s*E(\d{1,3})/i) || x.name.match(/(?:^|[^0-9])(\d{1,2})x(\d{1,3})(?!\d)/i) || x.name.match(/(?:^|[^a-z0-9])E(?:p|pisode)?[._ -]?(\d{1,3})(?:[^0-9]|$)/i);
      var xs = m && m.length > 2 ? String(+m[1]) : null, xn = m ? +m[m.length - 1] : null;
      var sn = xs || x.ss || ds;
      cnt[sn] = (cnt[sn] || 0) + 1;
      return { s: sn, n: xn || cnt[sn], url: x.url, name: x.name };
    });
  });
}

function seriesStreamsSt(info, season, episode) {
  return searchSt(info.name).then(function (res) {
    var hits = res.dirs.filter(function (h) {
      if (!seriesNameMatches(h.title, info.name)) return false;
      var m = h.title.match(/seasons?\s*0*(\d+)(?:\s*(?:-|to|–)\s*0*(\d+))?/i);
      if (!m) return true;
      var a = Number(m[1]), z = m[2] ? Number(m[2]) : a;
      return Number(season) >= a && Number(season) <= z;
    }).slice(0, 8);
    DBG.push("ST series folder: " + hits.length + "/" + res.dirs.length + " matched");
    var out = [];
    return hits.reduce(function (p, hit) {
      return p.then(function () {
        return stEpisodes(hit).then(function (eps) {
          eps.filter(function (e) { return e.s === String(season) && e.n === Number(episode); })
             .forEach(function (e) { out.push(makeStream("ShowTime", e.url, e.name, false)); });
          DBG.push("ST files: " + eps.length);
        });
      });
    }, Promise.resolve()).then(function () { return out; });
  }).catch(function (e) { DBG.push("ST series error: " + (e && e.message)); return []; });
}

// CineplexBD series: search -> watch.php for the wanted season/episode -> <source src=".../master.m3u8">
function pickSeriesHit(list, info) {
  var series = list.filter(function (h) { return h.series; });
  var names = [info.name, info.original].filter(function (n) { return n; });
  var tests = [
    function (h) { return names.some(function (n) { return titleMatches(h.title, h.year, n, info.year); }); },
    function (h) { return names.some(function (n) { return titleMatches(h.title, h.year, n, null); }); },
    function (h) { return names.some(function (n) { return seriesNameMatches(h.title, n); }); }
  ];
  for (var i = 0; i < tests.length; i++) {
    var hit = series.filter(tests[i])[0];
    if (hit) return hit;
  }
  return null;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ask for the playlist until the server stops answering 404 (max ~6 s), so the player's first request succeeds
function warmUp(url) {
  var tries = 0;
  function go() {
    tries++;
    var h = { "User-Agent": UA, "Referer": CX + "/", "Accept": "*/*" };
    if (ckString()) h["Cookie"] = ckString();
    return fetch(url, { headers: h }).then(function (r) {
      grabCookies(r);
      DBG.push("warm " + tries + ": HTTP " + r.status);
      if (r.ok || r.status !== 404 || tries >= 5) return r.ok;
      return sleep(1200).then(go);
    }).catch(function (e) {
      DBG.push("warm " + tries + " error: " + (e && e.message));
      if (tries >= 5) return false;
      return sleep(1200).then(go);
    });
  }
  return go();
}

function seriesStreamsCx(info, season, episode, forcedId) {
  var mid = forcedId || manualId(MANUAL_SERIES, info);
  var found = mid ? Promise.resolve({ id: mid, series: true, title: info.name, year: info.year, category: "" })
                  : searchCxFuzzy(info, function (l) { return !!pickSeriesHit(l, info); }).then(function (list) {
                      return pickSeriesHit(list, info);
                    });
  return found.then(function (hit) {
    if (!hit) { DBG.push("CX series: no match"); return []; }
    DBG.push("CX series: id " + hit.id + " " + hit.title);
    var url = CX + "/watch.php?id=" + hit.id + "&series_id=" + hit.id +
              "&season=" + encodeURIComponent(season) + "&ep=" + encodeURIComponent(episode) + "&autoplay=1";
    return getText(url).then(function (html) {
      // the page lists the seasons it has; do not play season 1 when season N was asked for
      var opts = [], re = /<option\s+value="(\d+)"([^>]*)>/gi, m, selected = null;
      while ((m = re.exec(html))) { opts.push(m[1]); if (/selected/i.test(m[2])) selected = m[1]; }
      if (opts.length && opts.indexOf(String(Number(season))) < 0) {
        DBG.push("CX series: season " + season + " not on the site (has " + opts.join(",") + ")");
        return [];
      }
      if (selected !== null && Number(selected) !== Number(season)) {
        DBG.push("CX series: site opened season " + selected + ", wanted " + season);
        return [];
      }
      var vids = cxVideos(html, url);
      DBG.push("CX series: " + vids.length + " link");
      // the server also hands out the video cookies on the meta call; ask for it, ignore errors
      return getText(url + "&meta=1").catch(function () { return ""; }).then(function () {
        DBG.push("cookies: " + (Object.keys(CK).join(",") || "none"));
        var label = hit.title + " S" + ("0" + season).slice(-2) + "E" + ("0" + episode).slice(-2);
        // the /hls/ playlist is made on demand and answers 404 until it is ready: ask once now, retry a few times
        var warm = vids[0] && /\.m3u8/i.test(vids[0]) ? warmUp(vids[0]) : Promise.resolve();
        return warm.then(function () {
          return vids.map(function (u) { return makeStream("CineplexBD", u, label, true); });
        });
      });
    });
  }).catch(function (e) { DBG.push("CX series error: " + (e && e.message)); return []; });
}

function seriesStreams(info, season, episode) {
  return Promise.all([seriesStreamsCx(info, season, episode), within(ftpSeries(info, season, episode), FTP_DEADLINE, "FTP series"), seriesStreamsSt(info, season, episode)]).then(function (r) {
    return r[0].concat(r[1]).concat(r[2]);
  });
}

// ---- items that come from the "Cineplex" library add-on: id looks like cpxS34392 / cpxM1234 ------
function parseCpx(id) {
  var t = String(id === undefined || id === null ? "" : id);
  var m = t.match(/cpx([SM])(\d+)/i);
  if (m) return { kind: m[1].toUpperCase(), id: m[2] };
  // reserved TMDB-looking ids: 99000000+N = Cineplex series N, 98000000+N = Cineplex movie N
  m = t.match(/^(?:tmdb:)?(\d{8,9})$/i);
  if (m) {
    var n = Number(m[1]);
    if (n >= 99000000 && n < 100000000) return { kind: "S", id: String(n - 99000000) };
    if (n >= 98000000 && n < 99000000) return { kind: "M", id: String(n - 98000000) };
  }
  return null;
}

function directStreams(cpx, season, episode) {
  if (cpx.kind === "S") {
    return seriesStreamsCx({ name: "Cineplex" }, season || 1, episode || 1, cpx.id);
  }
  // the movie's "Watch Movie" button opens player.php?id=N; that page holds the signed mp4 link
  // (a /v/m/... path with md5 + expires, valid for a few hours), so fetch it fresh on every play
  var href = CX + "/player.php?id=" + cpx.id;
  return getText(href).then(function (html) {
    var urls = cxVideos(html, href);
    if (!urls.length) {
      DBG.push("CX player.php: no link, trying view.php");
      return getText(CX + "/view.php?id=" + cpx.id).then(function (h2) { return cxVideos(h2, CX + "/view.php?id=" + cpx.id); });
    }
    return urls;
  }).then(function (urls) {
    var out = urls.map(function (u) { return makeStream("CineplexBD", u, "Cineplex movie " + cpx.id, true); });
    DBG.push("CX direct movie: " + out.length + " link");
    out.forEach(function (s) { if (s.headers && ckString()) s.headers["Cookie"] = ckString(); });
    return out;
  }).catch(function (e) { DBG.push("CX direct movie error: " + (e && e.message)); return []; });
}

function debugStream() {
  try { console.log("[CineFlex] " + DBG.join(" | ")); } catch (e) {}
  var st = typeof SCRAPER_SETTINGS !== "undefined" && SCRAPER_SETTINGS ? SCRAPER_SETTINGS : {};
  if (st.debug) {
    return [{ name: "CineFlex debug", title: DBG.join(" | ").slice(0, 600), quality: "480p", url: CX + "/debug.mp4", headers: { "User-Agent": UA } }];
  }
  return [];
}

// the title of a Cineplex library item, read from the add-on's own meta file (name, year)
function libraryTitle(cpx) {
  var base = cpx.kind === "M" ? 98000000 : 99000000;
  var type = cpx.kind === "M" ? "movie" : "series";
  var url = "https://nowrinnoor78992-jpg.github.io/Cin-dflix/addon/meta/" + type + "/tmdb:" + (base + Number(cpx.id)) + ".json";
  return getText(url).then(function (t) {
    var m = JSON.parse(t).meta || {};
    var y = m.year ? parseInt(String(m.year), 10) : null;
    return { name: m.name || "", year: isNaN(y) ? null : y, original: "", lang: "", anim: false };
  }).catch(function (e) { DBG.push("library meta error: " + (e && e.message)); return null; });
}

function getStreams(tmdbId, mediaType, season, episode) {
  DBG = [];
  CK = {}; CK_TIME = 0; // fresh cookies for every request, as before (the server resets them every 6 h)
  var isMovie = mediaType === "movie";
  var cpx = parseCpx(tmdbId);
  DBG.push("id: " + tmdbId + " type: " + mediaType + " s" + season + " e" + episode);
  if (cpx) {
    return directStreams(cpx, season, episode).then(function (out) {
      if (out.length) return out;
      // not found on Cineplex -> look for the same title in the other sources, using the add-on's own title
      return libraryTitle(cpx).then(function (info) {
        if (!info || !info.name) return debugStream();
        DBG.push("library fallback: " + info.name);
        if (cpx.kind === "M") return movieStreams(info);
        return seriesStreams(info, season, episode);
      });
    });
  }
  if (!isMovie && (!season || !episode)) return Promise.resolve([]);
  return getInfo(tmdbId, mediaType)
    .then(function (info) {
      DBG.push("TMDB: " + (info.name || "no title") + (info.year ? " (" + info.year + ")" : ""));
      if (!info.name) return [];
      return isMovie ? movieStreams(info) : seriesStreams(info, season, episode);
    })
    .catch(function (e) { DBG.push("error: " + (e && e.message)); return []; })
    .then(function (out) {
      if (out.length) return out;
      return debugStream();
    });
}

module.exports = { getStreams: getStreams };
