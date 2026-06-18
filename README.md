# Guildford Trails 🧭

Self-guided **virtual geocache** walking trails — clues that lead you past real landmarks, no physical caches planted. You "find" each cache by getting there (your phone confirms the spot) and answering a clue you can only solve **on-site**.

Personal/family project. See [`SPEC.md`](SPEC.md) for the full product spec.

## Repo layout
```
geocache-tours/
  SPEC.md              ← the product spec
  docs/                ← the web app (this is what GitHub Pages serves)
    index.html
    app.js             ← player: map, geofencing, clues, finale
    style.css
    trails/
      index.json       ← list of published trails (first = default)
      <trail>.json     ← a finished trail
  generator/
    generate_trail.py  ← TIME×PLACE→THEME→ROUTE draft generator
    requirements.txt
```

## The clue rule (important)
Every clue is one of three types:
- **`durable`** — answer is a *permanent* on-site feature: a carved/painted date, an inscription, a fixed count (windows, arches, lions, bells), a name on a plaque. **Preferred.** Must be ~90%+ likely to still be there.
- **`virtual`** — no permanent answer-feature, so it's a knowledge/riddle clue tied to the place's story.
- **`arrival`** — no question; you just have to get there (GPS check-in).

> If the only possible answer is something that can blow away (a leaf, a poster, a parked car) → use `virtual` or `arrival`, never `durable`.

## Running the generator (drafts a trail)
```bash
cd generator
pip install -r requirements.txt
python generate_trail.py --place "Guildford, Surrey, UK" --radius 1200 --date 2026-06-18 --max-stops 6
# optional clue drafting with your own key:
ANTHROPIC_API_KEY=... python generate_trail.py --place "Guildford, Surrey, UK" --llm
```
It writes `docs/trails/<id>.draft.json` with clue **scaffolds**. You then:
1. Finalise each clue (durable first), set `distance_km`, `duration_min`, `start.directions`, `finale`.
2. **Walk it once** to check the answers are really visible and the route's safe (the Phase-0 gate).
3. Rename to drop `.draft`, add it to `trails/index.json`.

## Trail JSON shape
```jsonc
{
  "id": "guildford-2026-06-18",
  "title": "…", "theme": "…", "area": "Guildford",
  "blurb": "…", "difficulty": "standard",
  "distance_km": 2.1, "duration_min": 50, "ordered": false,
  "start": { "lat": 51.2, "lng": -0.57, "name": "…", "directions": "parking/station note" },
  "stops": [{
    "id": 1, "name": "…", "lat": 51.2, "lng": -0.57, "geofence_m": 30,
    "clue_type": "durable", "clue": "…", "answer": ["1683"],
    "answer_hint": "…", "story": "…", "source": "https://…"
  }],
  "finale": { "title": "…", "message": "…", "reward_idea": "ice cream by the river" }
}
```

## Publishing (GitHub Pages)
1. Push this folder to a repo.
2. Settings → Pages → Source: **Deploy from a branch**, branch `main`, folder **`/docs`**.
3. The trail is live at `https://<user>.github.io/<repo>/`.

GitHub Pages is HTTPS, so the browser Geolocation API (needed for geofencing) works. To test locally:
```bash
cd docs && python -m http.server 8000   # then open http://localhost:8000
```
(`localhost` also counts as a secure context, so geolocation works there too.)
