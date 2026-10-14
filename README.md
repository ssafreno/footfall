# footfall

A small first-person controller demo in Three.js. Walk around a little procedural yard,
jump onto boxes, and crouch through a low gap. Plain ES modules with an importmap
(three@0.170.0 from jsDelivr); there's no bundler and no build step.

## Controls

| Input | Action |
| --- | --- |
| Click | Capture the mouse and start |
| Mouse | Look |
| W A S D | Move |
| Space | Jump |
| Shift (hold) | Crouch |
| Esc | Release the mouse |

## Run

```sh
python3 -m http.server 5182
```

Then open http://localhost:5182. ES modules won't load from `file://`, so it has to be served over HTTP.

## Layout

- `index.html`: importmap, canvas host, HUD
- `src/main.js`: renderer, camera, resize, game loop
- `src/controller.js`: `FirstPersonController` (pointer lock, movement, AABB collision)
- `src/scene.js`: `buildScene(scene)` builds the environment and returns its colliders and spawn point
