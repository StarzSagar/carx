# Assets

Reserved for optional static images or audio. The current game draws the arena,
cars, and effects procedurally with Canvas, so no files here are required.
If you add files, serve them from `/assets/...` only if you also mount the
directory in `server.py` (the frontend currently loads everything from
`/game/`).
