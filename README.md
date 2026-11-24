# EMBERWATCH

You keep the last fire of the night. It is always dying. Dawn is three minutes away.

A small real-time survival game in a single HTML page. No build step, no dependencies, no assets: canvas and WebAudio only.

## Play

Open `index.html` in a browser, or play the hosted version (link on the itch page).

- Move: Left/Right arrows or A/D. Walk over wood to carry it (max 3). Walk to the fire to feed it.
- SPACE: wave off the frost moths. They arrive in visible drifts and smother the flame.
- M: mute. R: restart after dawn or defeat.
- Touch: hold left/right of the keeper to move, tap near the keeper to wave. Best in landscape.

The fire decays constantly, so standing still is not a plan. Wood does not come to you, so guarding forever is not a plan either. Waving on cooldown without watching the drifts wastes the wave you will need when one arrives. At dawn you get a rank (S/A/B/C) by how many hits the fire took.

## Design notes

Scene 1 is one night, one fire, two entities (falling wood, frost moths). The intended decision texture: every trip away from the fire costs flame, every wave spent early is a wave you do not have when a drift arrives. Balance was tuned against scripted policies: camping, feed-only and wave-spam all lose or win badly; only attentive timing wins well. Runs are reproducible with `?seed=N`.

## License

- Code: MIT (see LICENSE).
- Audiovisual work (all procedurally generated at runtime): CC BY-NC-SA 4.0.
