#!/usr/bin/env python3
"""
Guildford Trails — trail generator (Phase 1)
============================================
TIME x PLACE -> THEME -> ROUTE, against live open data.

What it does:
  1. THEME (time)  : pulls Wikimedia "On this day" for the date + merges a small
                     fixed-anchors list (VE Day, solstice, Remembrance...).
  2. PLACE         : queries OpenStreetMap (Overpass) for DURABLE features near a
                     point (listed buildings, memorials, churches, statues, historic=*),
                     enriches with Wikipedia summaries + coordinates.
  3. ROUTE         : orders the chosen stops as a nearest-neighbour loop from a start.
  4. DRAFT         : writes a trail JSON matching docs/trails/<id>.json with clue
                     *scaffolds*. Clues are left for a human (or the --llm pass) to
                     finalise, following the durable-clue rule below.

DURABLE-CLUE RULE (baked in):
  Prefer a clue whose answer is a PERMANENT physical feature — a carved/painted date,
  an inscription, a fixed count (windows, arches, lions, bells), a name on a plaque.
  The answer source must be ~90%+ likely to still be there. If a great landmark has no
  durable answer feature, mark clue_type="virtual" (knowledge/riddle) or "arrival"
  (just get there). Never hinge a clue on something that can blow away.

This is deliberately a *draft* generator: a human reviews every trail before publish
(the anti-"soulless-tour" gate). Nothing here auto-publishes.

Usage:
  python generate_trail.py --place "Guildford, UK" --radius 1200 \
      --date 2026-06-18 --max-stops 6 --out ../docs/trails
  # optional LLM clue drafting (needs ANTHROPIC_API_KEY in env):
  python generate_trail.py --place "Guildford, UK" --llm

Dependencies: requests  (+ anthropic, only if --llm)
"""
import argparse, json, math, os, re, sys, time, datetime as dt
from urllib.parse import quote

try:
    import requests
except ImportError:
    sys.exit("Please `pip install requests` first.")

UA = "GuildfordTrails/0.1 (personal project; contact: local)"
OVERPASS = "https://overpass-api.de/api/interpreter"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
WIKI_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary/{}"
WIKI_GEOSEARCH = ("https://en.wikipedia.org/w/api.php?action=query&list=geosearch"
                  "&gscoord={lat}%7C{lng}&gsradius={r}&gslimit=30&format=json")
ONTHISDAY = "https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events/{mm}/{dd}"

# Fixed calendar anchors that the on-this-day feed won't flag as "themes".
FIXED_ANCHORS = {
    (5, 8):  ("VE Day", "End of WWII in Europe — military / remembrance trail."),
    (6, 18): ("Waterloo Day", "Battle of Waterloo, 1815 — military history trail."),
    (6, 21): ("Summer Solstice", "Longest day — light, sundials, the outdoors."),
    (11, 11):("Armistice Day", "Remembrance — war memorials, the fallen."),
    (4, 23): ("St George's Day", "England's patron saint — dragons, knights, heraldry."),
    (10, 31):("Halloween", "Spooky history — graves, ghosts, old stories."),
}

def log(*a): print(*a, file=sys.stderr)

def geocode(place):
    r = requests.get(NOMINATIM, params={"q": place, "format": "json", "limit": 1},
                     headers={"User-Agent": UA}, timeout=30)
    r.raise_for_status()
    j = r.json()
    if not j: sys.exit(f"Couldn't geocode '{place}'.")
    return float(j[0]["lat"]), float(j[0]["lon"]), j[0].get("display_name", place)

def themes_for_date(date):
    mm, dd = date.month, date.day
    themes = []
    if (mm, dd) in FIXED_ANCHORS:
        name, why = FIXED_ANCHORS[(mm, dd)]
        themes.append({"theme": name, "why": why, "source": "fixed anchor"})
    try:
        r = requests.get(ONTHISDAY.format(mm=f"{mm:02d}", dd=f"{dd:02d}"),
                         headers={"User-Agent": UA, "accept": "application/json"}, timeout=30)
        if r.ok:
            for ev in r.json().get("events", [])[:6]:
                themes.append({"theme": ev.get("text", "")[:80],
                               "why": f"On this day {ev.get('year')}",
                               "source": "wikimedia/onthisday"})
    except Exception as e:
        log("on-this-day lookup failed (feed may be deprecating):", e)
    if not themes:
        themes.append({"theme": "Local landmarks", "why": "Evergreen fallback.", "source": "fallback"})
    return themes

# Overpass: durable, place-anchored features.
OVERPASS_Q = """
[out:json][timeout:40];
(
  nwr["historic"](around:{r},{lat},{lng});
  nwr["tourism"="attraction"](around:{r},{lat},{lng});
  nwr["amenity"="place_of_worship"](around:{r},{lat},{lng});
  nwr["memorial"](around:{r},{lat},{lng});
  nwr["man_made"="tower"](around:{r},{lat},{lng});
);
out center tags 60;
"""

# crude durability score by tag — carved/monumental things rank high.
DURABLE_TAGS = {
    "memorial": 5, "monument": 5, "castle": 5, "tower": 4, "statue": 4,
    "church": 4, "cathedral": 5, "place_of_worship": 4, "ruins": 3,
    "building": 3, "milestone": 4, "boundary_stone": 4, "fort": 5,
}
def durability(tags):
    score = 1
    for k in ("historic", "memorial", "building", "man_made", "amenity"):
        v = tags.get(k)
        if v in DURABLE_TAGS: score = max(score, DURABLE_TAGS[v])
    if k := tags.get("historic"):
        if k in DURABLE_TAGS: score = max(score, DURABLE_TAGS[k])
    if tags.get("heritage"): score = max(score, 4)  # listed
    return score

def fetch_pois(lat, lng, r):
    q = OVERPASS_Q.format(r=r, lat=lat, lng=lng)
    resp = requests.post(OVERPASS, data={"data": q}, headers={"User-Agent": UA}, timeout=90)
    resp.raise_for_status()
    out = []
    for el in resp.json().get("elements", []):
        tags = el.get("tags", {})
        name = tags.get("name")
        if not name: continue
        c = el.get("center") or {"lat": el.get("lat"), "lon": el.get("lon")}
        if not c.get("lat"): continue
        out.append({
            "name": name, "lat": c["lat"], "lng": c["lon"],
            "tags": tags, "durability": durability(tags),
            "kind": tags.get("historic") or tags.get("amenity") or tags.get("tourism") or "feature",
            "wikipedia": tags.get("wikipedia"),
        })
    # de-dupe by name, keep most durable
    best = {}
    for p in out:
        k = p["name"].lower()
        if k not in best or p["durability"] > best[k]["durability"]:
            best[k] = p
    return list(best.values())

def enrich(p):
    title = None
    if p.get("wikipedia") and ":" in p["wikipedia"]:
        title = p["wikipedia"].split(":", 1)[1]
    if not title: return
    try:
        r = requests.get(WIKI_SUMMARY.format(quote(title.replace(" ", "_"))),
                         headers={"User-Agent": UA}, timeout=25)
        if r.ok:
            j = r.json()
            p["fact"] = j.get("extract", "")
            p["source"] = (j.get("content_urls", {}).get("desktop", {}) or {}).get("page")
    except Exception:
        pass

def haversine(a, b):
    R = 6371000
    p1, p2 = map(math.radians, (a[0], b[0]))
    dlat = math.radians(b[0]-a[0]); dlng = math.radians(b[1]-a[1])
    h = math.sin(dlat/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dlng/2)**2
    return 2*R*math.asin(math.sqrt(h))

def nn_route(start, stops):
    """nearest-neighbour ordering from start."""
    remaining = stops[:]; route = []; cur = start
    while remaining:
        remaining.sort(key=lambda s: haversine((cur["lat"], cur["lng"]) if isinstance(cur, dict) else cur,
                                                (s["lat"], s["lng"])))
        nxt = remaining.pop(0); route.append(nxt); cur = nxt
    return route

def clue_scaffold(p):
    """Draft a clue scaffold honouring the durable-clue rule. Human finalises."""
    durable = p["durability"] >= 4
    if durable:
        return {
            "clue_type": "durable",
            "clue": f"TODO(durable): find a permanent feature at {p['name']} — a carved date, "
                    f"an inscription, or a fixed count (windows/arches/bells). Ask for it.",
            "answer": [], "answer_hint": "Point to exactly where on-site the answer is.",
        }
    return {
        "clue_type": "virtual",
        "clue": f"TODO(virtual): {p['name']} has no obvious permanent answer-feature — write a "
                f"knowledge/riddle clue from its story instead, or set clue_type='arrival'.",
        "answer": [], "answer_hint": "",
    }

def llm_clues(trail):
    try:
        import anthropic
    except ImportError:
        log("--llm requested but `anthropic` not installed; skipping."); return
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        log("--llm requested but ANTHROPIC_API_KEY not set; skipping."); return
    client = anthropic.Anthropic(api_key=key)
    for s in trail["stops"]:
        prompt = (
            "You are writing ONE clue for a family virtual-geocache trail.\n"
            f"Location: {s['name']} ({trail['area']}). Theme: {trail['theme']}.\n"
            f"Known fact: {s.get('story','(none)')}\n\n"
            "RULE: prefer an answer that is a PERMANENT on-site feature (a carved/painted date, "
            "an inscription, a fixed count of something). If none is plausible, write a knowledge "
            "clue answerable from a permanent plaque/sign, or say ARRIVAL-ONLY.\n"
            "Return JSON: {\"clue_type\":\"durable|virtual|arrival\",\"clue\":\"...\",\"answer\":[\"...\"],\"answer_hint\":\"...\"}\n"
            "Keep the clue one or two sentences, warm, solvable by a child standing there."
        )
        try:
            m = client.messages.create(model="claude-opus-4-8", max_tokens=400,
                                       messages=[{"role": "user", "content": prompt}])
            txt = m.content[0].text
            j = json.loads(re.search(r"\{.*\}", txt, re.S).group(0))
            s.update({k: j[k] for k in ("clue_type", "clue", "answer", "answer_hint") if k in j})
            log("  drafted clue for", s["name"])
            time.sleep(0.4)
        except Exception as e:
            log("  LLM clue failed for", s["name"], ":", e)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--place", default="Guildford, Surrey, UK")
    ap.add_argument("--lat", type=float); ap.add_argument("--lng", type=float)
    ap.add_argument("--radius", type=int, default=1200)
    ap.add_argument("--date", default=dt.date.today().isoformat())
    ap.add_argument("--max-stops", type=int, default=6)
    ap.add_argument("--llm", action="store_true", help="draft clues with Anthropic (needs key)")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "docs", "trails"))
    args = ap.parse_args()

    date = dt.date.fromisoformat(args.date)
    if args.lat and args.lng:
        lat, lng, label = args.lat, args.lng, args.place
    else:
        lat, lng, label = geocode(args.place)
    log(f"Centre: {lat:.5f},{lng:.5f}  ({label})")

    log("\n== THEME candidates for", date.isoformat(), "==")
    themes = themes_for_date(date)
    for t in themes[:6]: log(f"  - {t['theme']}  [{t['source']}] — {t['why']}")
    theme = themes[0]["theme"]

    log("\n== Pulling durable POIs from OpenStreetMap ==")
    pois = fetch_pois(lat, lng, args.radius)
    pois.sort(key=lambda p: -p["durability"])
    log(f"  {len(pois)} named features found; enriching top candidates…")
    chosen = pois[: max(args.max_stops * 2, 8)]
    for p in chosen: enrich(p); time.sleep(0.1)

    picked = nn_route({"lat": lat, "lng": lng}, chosen[: args.max_stops])

    trail = {
        "id": f"guildford-{date.isoformat()}",
        "title": f"{theme}: a {args.place.split(',')[0]} trail",
        "theme": theme,
        "area": args.place.split(",")[0],
        "date_relevance": date.isoformat(),
        "blurb": "DRAFT — review every clue before publishing (durable-clue rule).",
        "difficulty": "standard",
        "ordered": False,
        "distance_km": None, "duration_min": None,
        "start": {"lat": lat, "lng": lng, "name": picked[0]["name"] if picked else args.place,
                  "directions": "TODO: nearest car park / station note."},
        "stops": [], "credits": "Map data © OpenStreetMap contributors · facts © Wikipedia (CC BY-SA)",
        "finale": {"title": "You made it!", "message": "TODO", "reward_idea": "TODO"},
    }
    for i, p in enumerate(picked, 1):
        sc = clue_scaffold(p)
        trail["stops"].append({
            "id": i, "name": p["name"], "lat": round(p["lat"], 6), "lng": round(p["lng"], 6),
            "geofence_m": 35, "story": p.get("fact", ""), "source": p.get("source"),
            "_durability": p["durability"], "_osm_kind": p["kind"], **sc,
        })

    if args.llm:
        log("\n== Drafting clues with Anthropic ==")
        llm_clues(trail)

    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, trail["id"] + ".draft.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(trail, f, indent=2, ensure_ascii=False)
    log("\nWrote", path)
    log("NEXT: finalise clues (durable first!), set distance/duration/finale, rename to "
        "drop '.draft', and add to trails/index.json.")

if __name__ == "__main__":
    main()
