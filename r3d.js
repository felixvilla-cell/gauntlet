/* ================= DAILY GAUNTLET 3D RENDERER (Three.js r169, vendored) =================
   Live-game port of the renderer Felix approved in 3d.html (2026-09-27). Loaded by
   index.html with import() at page load; it ONLY reads the sim's state (G, GAMES,
   comboTier, RUN_SECS, laserSwapIn, LASER_WARN -- index.html's own globals) and
   never writes anything the sim reads, so hits, scoring, steering and the seeded
   rng are exactly the 2D game's. If this file, three.js or WebGL fails, the
   import rejects, window.R3D is never set and index.html draws in 2D.
   Draws the 2D simulation's state. World mapping: x (0..400) -> X = x - 200,
   y (screen, orb at PY) -> Z = y - PY (ahead of the orb is -Z), Y is up.
   1 unit = 1 world px, so hitboxes and the drawn shapes line up exactly. */
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";

const W = 400, H = 700, PY = H * 0.78;
const X = x => x - 200, Z = y => y - PY;
const QS = new URLSearchParams(location.search);
const MEASURE = QS.get("measure") === "1";
const PERF = QS.get("perf") === "1";

// ---- camera rig. FAR_REQ = how far ahead of the orb (world px) the whole
// track width must be in frame. The 2D canvas first shows a hazard at most
// 546 + its radius ahead (big rocks 589), so 610 always beats it. ----
const [CAM_H, CAM_BACK] = (QS.get("cam") || "700,220").split(",").map(Number);
const FAR_REQ = 610, FOLLOW = 0.12, HUD_PX = 34, ORB_NDC = -0.5;
// Fog band: fully clear out to 556 ahead, gone by 616. When the 2D canvas
// first shows any hazard, its nearest edge is at most 553 ahead (bar edge;
// rocks and drones 546), so 3D never shows a hazard later than 2D and only a
// hair earlier -- more warning would make 3D runs easier than 2D ones.
const FOG_NEAR = 556, FOG_FAR = 616;

const stage = document.getElementById("r3dStage");
const glc = document.getElementById("r3dGl"), hud = document.getElementById("r3dHud"), hx = hud.getContext("2d");
// throws (import rejects -> index.html stays 2D) when WebGL is unavailable
const renderer = new THREE.WebGLRenderer({ canvas: glc, antialias: true, powerPreference: "high-performance" });
if (!renderer.getContext()) throw new Error("no webgl context");
let ctxLost = false;
glc.addEventListener("webglcontextlost", () => { ctxLost = true; });
glc.addEventListener("webglcontextrestored", () => { ctxLost = false; });
renderer.setClearColor(0x07060f, 1);
const scene = new THREE.Scene();
const BG = new THREE.Color(0x07060f);
scene.fog = new THREE.Fog(BG, 700, 900);
// Paint the sky with scene.background, NOT just the clear colour: three r169
// clears the composer's linear render target with the clear colour already
// sRGB-encoded, so OutputPass encodes it twice and #07060f comes out as a flat
// lavender slab (~#2e2a45) anywhere no geometry covers -- the whole sky on FOG
// days, when the horizon backdrop used to be hidden (Felix, 2026-10-01).
scene.background = BG;
const camera = new THREE.PerspectiveCamera(60, 1, 5, 6000);

// ---- glow: always BLOOM (Felix 2026-09-27: no toggle, leave it on) ----
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
/* Long track (Felix 2026-10-01, "why is the track so short?"): the floor
   (ground, track, grid, rails) is unfogged all the way to the horizon, and the
   fog now hides hazards by covering them with FLOOR instead of fading them to
   black. floorRT = the same frame with only the FLOOR layer (floor + sky);
   fogMix blends the full frame toward it by the fog factor of the floor point
   under each pixel (the same smoothstep three's fog uses, on view depth). Any
   hazard point sits at or above the floor, so it is nearer than the floor
   point behind it and its old fog factor was <= this one: nothing can show
   earlier than before, and empty floor blends with itself (no seam). Runs
   before bloom, so a hidden hazard's glow never leaks. */
const FLOOR = 1;
const floorRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
const fogMix = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, tFloor: { value: floorRT.texture }, uInvProj: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() }, uNear: { value: 0 }, uFar: { value: 1 },
    uZBack: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse, tFloor; uniform mat4 uInvProj, uCamWorld; uniform vec3 uCamPos;
    uniform float uNear, uFar, uZBack; varying vec2 vUv;
    void main(){
      vec4 p = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
      vec3 dv = normalize(p.xyz / p.w), dw = (uCamWorld * vec4(dv, 0.0)).xyz;
      float f = 1.0;                                  // sky / past the floor: floor layer only
      if (dw.y < -1e-5) {
        float t = -uCamPos.y / dw.y;
        if (uCamPos.z + dw.z * t > uZBack) f = smoothstep(uNear, uFar, -dv.z * t);
      }
      gl_FragColor = mix(texture2D(tDiffuse, vUv), texture2D(tFloor, vUv), f);
    }`,
});
fogMix.uniforms.tFloor.value = floorRT.texture;              // ShaderPass clones uniforms: re-point at the live RT
composer.addPass(fogMix);
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.35, 0.32);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---- textures ----
function canvasTex(w, h, draw) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const glowTex = canvasTex(64, 64, (g, w) => {
  const gr = g.createRadialGradient(w/2, w/2, 0, w/2, w/2, w/2);
  gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(.3, "rgba(255,255,255,.45)");
  gr.addColorStop(1, "rgba(255,255,255,0)"); g.fillStyle = gr; g.fillRect(0, 0, w, w);
});
const rectTex = canvasTex(64, 64, (g, w) => {        // soft rectangle: floor light spill
  g.shadowColor = "#fff"; g.shadowBlur = 14; g.fillStyle = "rgba(255,255,255,.9)";
  g.fillRect(18, 18, w - 36, w - 36);
});
// ---- materials ----
const basic = (color, extra = {}) => new THREE.MeshBasicMaterial({ color, ...extra });
const add = (color, opacity, map = glowTex) => new THREE.MeshBasicMaterial({
  color, map, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
const spriteMat = (color, opacity) => new THREE.SpriteMaterial({
  color, map: glowTex, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
// box faces: +x, -x, +y(top), -y, +z(front, toward the camera), -z
const faceMats = (top, front, side) => [basic(side), basic(side), basic(top), basic(side), basic(front), basic(front)];
const barMats = faceMats(0x6ff1ff, 0x0fbcd8, 0x0a7f93);
const edgeMat = new THREE.LineBasicMaterial({ color: 0xd8fbff });
const unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);   // sits on the floor
const unitEdges = new THREE.EdgesGeometry(unitBox);
const flatQuad = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

// ---- lights (only the lambert rocks/drones use them) ----
scene.add(new THREE.HemisphereLight(0x9fdfff, 0x1a0830, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(-120, 400, 260); scene.add(sun);

// ---- world: sky, sun, ground, track, grid, rails ----
// Horizon backdrop: stands just past where hazards finish fading in, faces
// the camera, bottom edge on the floor. Its bottom colour IS the fog colour,
// so the fogged floor melts into it; the retro sun rises out of the haze.
const Z_BACK = -(FOG_FAR + 40);
const horizonTex = canvasTex(8, 512, (g, w, h) => {      // bottom = fog colour, then haze
  const gr = g.createLinearGradient(0, h, 0, 0);
  gr.addColorStop(0, "#07060f"); gr.addColorStop(.10, "#1c0a33"); gr.addColorStop(.30, "#5a0f5c");
  gr.addColorStop(.42, "#3a0b4c"); gr.addColorStop(.75, "#120a26"); gr.addColorStop(1, "#07060f");
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  // feathered foot: the backdrop draws over the world now, so let the last
  // fog-coloured rows of the course show through instead of a cut line
  const ft = g.createLinearGradient(0, h, 0, h * 0.9);
  ft.addColorStop(0, "rgba(0,0,0,0)"); ft.addColorStop(1, "rgba(0,0,0,1)");
  g.globalCompositeOperation = "destination-in"; g.fillStyle = ft; g.fillRect(0, 0, w, h);
});
const sunTex = canvasTex(256, 256, (g, w) => {
  const r = w / 2 - 2, sg = g.createLinearGradient(0, 0, 0, w);
  sg.addColorStop(0, "#ffd45a"); sg.addColorStop(.55, "#ff7a5c"); sg.addColorStop(1, "#ff2ea6");
  g.beginPath(); g.arc(w / 2, w / 2, r, 0, 7); g.fillStyle = sg; g.fill();
  g.globalCompositeOperation = "destination-out";           // retro stripes, thicker toward the bottom
  for (let i = 0; i < 7; i++) g.fillRect(0, w * (.55 + i * .065), w, 2 + i * 1.7);
});
// Drawn LAST, over everything (2026-10-01): anything past the fog renders in
// the fog colour, and tall far pieces (windmill blades, tunnel walls, gust
// chevrons) poked over the horizon as dark silhouettes. Only fully fogged
// world ever projects into the sky band (a hazard would have to stand 80+ px
// tall at FOG_NEAR to reach it), so covering it hides nothing the player needs.
const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0),
  new THREE.MeshBasicMaterial({ map: horizonTex, fog: false, depthWrite: false, depthTest: false, transparent: true }));
backdrop.position.set(0, -2, Z_BACK); backdrop.renderOrder = 10; scene.add(backdrop);
const sunDisc = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ map: sunTex, transparent: true, opacity: 0.8, fog: false, depthWrite: false, depthTest: false }));
sunDisc.renderOrder = 11; scene.add(sunDisc);
// fit the backdrop to whatever band of sky this screen shape leaves above the course
const _ray = new THREE.Raycaster();
function fitBackdrop() {
  backdrop.rotation.x = -Math.atan2(CAM_H, CAM_BACK - Z_BACK);   // lean back to face the camera
  backdrop.scale.set(4000, 4000, 1); backdrop.updateMatrixWorld();
  _ray.setFromCamera(new THREE.Vector2(0, 1), camera);
  const hit = _ray.intersectObject(backdrop, false)[0];
  const vh = hit ? Math.max(120, backdrop.worldToLocal(hit.point.clone()).y * 4000) : 400;
  backdrop.scale.set(4000, vh * 1.15, 1); backdrop.updateMatrixWorld();
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(backdrop.quaternion);
  const nrm = new THREE.Vector3(0, 0, 1).applyQuaternion(backdrop.quaternion);
  // size the sun in SCREEN terms: it sits in the sky band between the HUD
  // strip and the horizon, and skips small screens where there is no band
  const scr = v => (1 - v.clone().project(camera).y) / 2 * SH;
  const base = backdrop.position.clone(), yBot = scr(base);
  const pxPerUnit = (yBot - scr(base.clone().addScaledVector(up, 100))) / 100;
  const band = yBot - HUD_PX - 6;
  sunDisc.visible = band > 90 && pxPerUnit > 0;
  if (!sunDisc.visible) return;
  const dPx = Math.min(band * 0.78, SW * 0.5);
  const size = dPx / pxPerUnit, lift = (band * 0.44 + 0.0) / pxPerUnit;
  sunDisc.quaternion.copy(backdrop.quaternion);
  sunDisc.scale.set(size, size, 1);
  sunDisc.position.copy(base).addScaledVector(up, lift).addScaledVector(nrm, 2);
}
// Floor materials skip the hazard fog; they only fade to the fog colour over
// their last ~55 px before the horizon (FLOOR_FADE, set in setFog), so the
// grid melts into the backdrop instead of stopping on a hard, shimmering edge.
const FLOOR_FADE = { uFadeNear: { value: 1e9 }, uFadeFar: { value: 2e9 } };
function floorMat(m) {
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, FLOOR_FADE);
    sh.fragmentShader = "uniform float uFadeNear, uFadeFar;\n" + sh.fragmentShader.replace("#include <fog_fragment>",
      "#ifdef USE_FOG\n gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, smoothstep(uFadeNear, uFadeFar, vFogDepth));\n#endif");
  };
  return m;
}
const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 1200).rotateX(-Math.PI / 2), floorMat(basic(0x0a0816)));
ground.position.set(0, -1, Z_BACK + 600); scene.add(ground);
const track = new THREE.Mesh(new THREE.PlaneGeometry(400, 1200).rotateX(-Math.PI / 2), floorMat(basic(0x0e0b24)));
track.position.set(0, -0.5, Z_BACK + 600); scene.add(track);
const grid = new THREE.Group(); scene.add(grid);
{
  const inPts = [], outPts = [];
  for (let x = -600; x <= 1000; x += 40) {                    // lengthwise lines
    const arr = (x >= 0 && x <= 400) ? inPts : outPts;
    arr.push(X(x), 0, 400, X(x), 0, Z_BACK - 40);         // past the foot at any scroll
  }
  for (let z = 400; z >= Z_BACK - 40; z -= 40) {                    // crosswise lines (these scroll)
    inPts.push(X(0), 0, z, X(400), 0, z);
    outPts.push(X(-600), 0, z, X(0), 0, z, X(400), 0, z, X(1000), 0, z);
  }
  const seg = (pts, color, opacity) => {
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return new THREE.LineSegments(g, floorMat(new THREE.LineBasicMaterial({ color, transparent: true, opacity })));
  };
  grid.add(seg(inPts, 0x19e3ff, 0.30));
  grid.add(seg(outPts, 0xb040ff, 0.16));
}
const rails = [];
for (const x of [0, 400]) {                                   // glowing magenta rails
  const r = new THREE.Mesh(unitBox, floorMat(basic(0xff2ea6))); r.scale.set(3, 3, 1300); r.position.set(X(x), 0, Z_BACK + 650); scene.add(r);
  const s = new THREE.Mesh(flatQuad, floorMat(add(0xff2ea6, 0.35, rectTex))); s.scale.set(34, 1, 1300); s.position.set(X(x), 0.3, Z_BACK + 650); scene.add(s);
  r.layers.enable(FLOOR); s.layers.enable(FLOOR); rails.push(r, s);
}
for (const o of [ground, track, ...grid.children, backdrop, sunDisc]) o.layers.enable(FLOOR);   // the floor-only layer fogMix blends toward

/* FOG-day mist (Felix 2026-10-01: "put some fog in that empty space"). It
   lives ONLY on the FLOOR layer, so it reaches the screen solely through
   fogMix's mix(frame, floorLayer, f): zero inside fog.near (play area clear,
   hazards never later), and wherever it shows the hazards were already being
   blended away to the same degree (never earlier). Two drifting wisp sheets
   low over the track that thicken with distance, plus a bank on the horizon
   that softens the sun's lower half. Hidden on every other twist. */
const wispTex = canvasTex(256, 256, (g, w, h) => {          // tileable soft blobs, stretched sideways
  let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 46; i++) {
    const x = rnd() * w, y = rnd() * h, r = 14 + rnd() * 40, a = 0.35 + rnd() * 0.5;
    for (const dx of [-w, 0, w]) for (const dy of [-h, 0, h]) {
      g.save(); g.translate(x + dx, y + dy); g.scale(2.4, 1);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, r);
      gr.addColorStop(0, `rgba(255,255,255,${a})`); gr.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = gr; g.fillRect(-r, -r, 2 * r, 2 * r); g.restore();
    }
  }
});
wispTex.wrapS = wispTex.wrapT = THREE.RepeatWrapping;
const rampTex = (stops) => canvasTex(4, 256, (g, w, h) => {  // alphaMap reads GREEN: grey ramp, top = far
  const gr = g.createLinearGradient(0, h, 0, 0);
  for (const [t, a] of stops) { const v = Math.round(a * 255); gr.addColorStop(t, `rgb(${v},${v},${v})`); }
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
});
const mist = new THREE.Group(); scene.add(mist);
const mistSheets = [];
for (const [y, color, op, rep, ramp] of [
  [2, 0x1c0f30, 1.0, null, [[0, 0], [.25, .5], [.6, .85], [.9, 1], [1, 0]]],        // base haze: grid sinks into it
  [6, 0x8a4ab8, 0.9, [3, 2.2], [[0, 0], [.2, .55], [.6, .9], [.9, .8], [1, 0]]],      // violet wisps
  [20, 0x2fa0b0, 0.45, [2, 1.4], [[0, 0], [.3, .4], [.75, .8], [.9, .6], [1, 0]]]]) {  // teal wisps above them
  const map = rep ? wispTex.clone() : null; if (map) { map.repeat.set(...rep); map.needsUpdate = true; }
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1600, -Z_BACK + 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color, map, alphaMap: rampTex(ramp), transparent: true, opacity: op,
      depthWrite: false, depthTest: false, fog: false }));
  // drawn after the sky + sun (11) so the far mist rolls over the horizon line; the bank (12) tops it
  m.position.set(0, y, (Z_BACK - 40) / 2); m.layers.set(FLOOR); m.renderOrder = 11.5;
  mist.add(m); mistSheets.push(m);
}
const bank = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0),
  new THREE.MeshBasicMaterial({ color: 0x8a4ab8, map: wispTex.clone(), alphaMap: rampTex([[0, 0], [.16, .9], [.4, .7], [.75, .2], [1, 0]]),
    transparent: true, opacity: 1, depthWrite: false, depthTest: false, fog: false }));
bank.material.map.repeat.set(5, 1); bank.material.map.needsUpdate = true;
bank.renderOrder = 12; bank.layers.set(FLOOR); mist.add(bank);       // over the sun, under nothing
function fitMist() {                                         // the bank hugs the backdrop's foot
  bank.quaternion.copy(backdrop.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(backdrop.quaternion);
  bank.position.copy(backdrop.position).addScaledVector(new THREE.Vector3(0, 0, 1).applyQuaternion(backdrop.quaternion), 3)
    .addScaledVector(up, -backdrop.scale.y * 0.06);         // foot dips below the horizon: no seam with the sheets
  bank.scale.set(4000, backdrop.scale.y * 0.42, 1);
}
function driftMist() {                                       // slow sideways drift only
  const t = G.t;
  // Felix 2026-10-01: "make the fog move", then "horizontal instead of
  // vertical", then "it looks like it's swaying very slightly left to right".
  // Both sheets now roll the SAME way at clearly visible, parallaxed speeds
  // (two sheets crossing opposite ways plus an opacity swell read as a sway, and
  // the camera's own follow sway swallowed it). Floor layer only, so the
  // fairness argument above is unchanged.
  mistSheets[1].material.map.offset.set(t * 0.45, 0);
  mistSheets[2].material.map.offset.set(t * 0.65, 0.37);
  bank.material.map.offset.set(t * 0.2, 0);
}

// ---- pools ----
function pool(make) {
  const items = []; let used = 0;
  return {
    next() { if (used >= items.length) items.push(make()); const it = items[used++]; it.visible = true; return it; },
    begin() { used = 0; },
    end() { for (let i = used; i < items.length; i++) items[i].visible = false; },
  };
}
const halos = [];                                             // lite-mode halos, dimmed under bloom
function halo(color, size, liteOp, bloomOp) {
  const s = new THREE.Sprite(spriteMat(color, liteOp)); s.scale.set(size, size, 1);
  s.userData.op = [liteOp, bloomOp]; halos.push(s); return s;
}
// gauntlet bar piece
const barPool = pool(() => {
  const g = new THREE.Group();
  const m = new THREE.Mesh(unitBox, barMats); m.add(new THREE.LineSegments(unitEdges, edgeMat));
  const spill = new THREE.Mesh(flatQuad, add(0x19e3ff, 0.55, rectTex)); spill.position.y = 0.4;
  g.add(m, spill); g.userData = { m, spill }; scene.add(g); return g;
});
const BAR_H = 22, BAR_D = 14;
function barPiece(x0, x1, y) {
  if (x1 - x0 < 0.5) return;
  const g = barPool.next(), { m, spill } = g.userData;
  g.position.set(X((x0 + x1) / 2), 0, Z(y));
  m.scale.set(x1 - x0, BAR_H, BAR_D); spill.scale.set(x1 - x0 + 30, 1, BAR_D + 44);
}
// coin
const coinGeo = new THREE.CylinderGeometry(8, 8, 2.6, 20).rotateX(Math.PI / 2);
const coinMats = [basic(0xc48a12), basic(0xffd966), basic(0xffd966)];
const coinPool = pool(() => {
  const g = new THREE.Group();
  const m = new THREE.Mesh(coinGeo, coinMats); m.position.y = 13;
  const h = halo(0xffc93c, 40, 0.55, 0.22); h.position.y = 13;
  const spill = new THREE.Mesh(flatQuad, add(0xffc93c, 0.35)); spill.scale.set(34, 1, 34); spill.position.y = 0.4;
  g.add(m, h, spill); g.userData = { m }; scene.add(g); return g;
});
// meteor rock
const rockGeo = new THREE.IcosahedronGeometry(1, 0), rockEdges = new THREE.EdgesGeometry(rockGeo);
const rockMat = new THREE.MeshLambertMaterial({ color: 0x0fbcd8, emissive: 0x06495a, flatShading: true });
const rockPool = pool(() => {
  const g = new THREE.Group();
  const m = new THREE.Mesh(rockGeo, rockMat); m.add(new THREE.LineSegments(rockEdges, edgeMat));
  const spill = new THREE.Mesh(flatQuad, add(0x19e3ff, 0.45)); spill.position.y = 0.4;
  g.add(m, spill); g.userData = { m, spill }; scene.add(g); return g;
});
// hunter drone: 3-sided dart pointing at the player (+Z)
const droneGeo = new THREE.ConeGeometry(0.9, 1.7, 3).rotateX(Math.PI / 2);
const droneMat = new THREE.MeshLambertMaterial({ color: 0xd08aff, emissive: 0x8a3ad0, flatShading: true });
const droneEdges = new THREE.EdgesGeometry(droneGeo);
const droneEdgeMat = new THREE.LineBasicMaterial({ color: 0xf0d8ff });
const eyeGeo = new THREE.SphereGeometry(2.8, 10, 8);
const dronePool = pool(() => {
  const g = new THREE.Group();
  const m = new THREE.Mesh(droneGeo, droneMat); m.add(new THREE.LineSegments(droneEdges, droneEdgeMat));
  const eye = new THREE.Mesh(eyeGeo, basic(0xffffff));
  const h = halo(0xc46bff, 70, 0.6, 0.3);
  const spill = new THREE.Mesh(flatQuad, add(0xc46bff, 0.8)); spill.position.y = 0.4;
  g.add(m, eye, h, spill); g.userData = { m, eye, h, spill }; scene.add(g); return g;
});

/* ---- 2026-09-27 port: assets for the other 10 games. Shapes that never need
   a per-instance tint reuse ONE shared material (cheap); shapes whose color or
   opacity varies independently per instance (laser dark/hot flicker, phantom
   fade, mine arm state, blast rings) get a FRESH material inside their pool's
   make() -- same convention tunSpill already used above. ---- */
// laser: full-width beam segments (own material -- hot bright vs dark flicker)
const laserSegPool = pool(() => {
  const mat = basic(0xff3355, { transparent: true });
  const m = new THREE.Mesh(unitBox, mat); m.userData = { mat }; scene.add(m); return m;
});
function laserSeg(x0, x1, y, opacity, bright, thick = 8, warn = false) {
  if (x1 - x0 < 0.5) return;
  const m = laserSegPool.next(), mat = m.userData.mat;
  m.position.set(X((x0 + x1) / 2), 0, Z(y));
  // hot = full beam (depth matches the 2D bar, THICK BEAMS included); dark =
  // a low wire, drawn thicker while it warns so the flicker reads down the track
  m.scale.set(x1 - x0, bright ? 16 : (warn ? 8 : 5), bright ? thick * 2 : (warn ? 8 : 6));
  mat.opacity = opacity; mat.color.set(bright ? 0xff5577 : (warn ? 0xff7a90 : 0xff3355));
}
const laserNodeGeo = new THREE.SphereGeometry(5, 12, 8), laserNodeMat = basic(0x0fbcd8);
const laserNodePool = pool(() => { const m = new THREE.Mesh(laserNodeGeo, laserNodeMat); scene.add(m); return m; });
// crushers + pistons: a plain white "cap" cube (jaw tip / ram head plate)
const capGeo = new THREE.BoxGeometry(1, 1, 1), capMat = basic(0xe8e6ff);
const capPool = pool(() => { const m = new THREE.Mesh(capGeo, capMat); scene.add(m); return m; });
// slalom: gold flag wedge at the gate tip
const flagGeo = new THREE.ConeGeometry(11, 24, 4).rotateZ(-Math.PI / 2), flagMat = basic(0xffc93c);
const flagPool = pool(() => { const m = new THREE.Mesh(flagGeo, flagMat); scene.add(m); return m; });
// pong: ricocheting ball + a motion-streak smear behind it
const ballGeo = new THREE.SphereGeometry(1, 16, 12);
const ballMat = new THREE.MeshLambertMaterial({ color: 0x0fbcd8, emissive: 0x0a5f70, flatShading: false });
const ballPool = pool(() => {
  const g = new THREE.Group();
  const m = new THREE.Mesh(ballGeo, ballMat);
  const h = halo(0x19e3ff, 46, 0.55, 0.24);
  const streak = new THREE.Mesh(flatQuad, add(0x19e3ff, 0.3));
  g.add(m, h, streak); g.userData = { m, h, streak }; scene.add(g); return g;
});
// windmill: gold hub + up to 2 spinning ground-plane blades
const hubGeo = new THREE.SphereGeometry(7, 12, 8), hubMat = basic(0xffc93c);
const hubPool = pool(() => { const m = new THREE.Mesh(hubGeo, hubMat); scene.add(m); return m; });
const bladeMats = faceMats(0x6ff1ff, 0x0fbcd8, 0x0a7f93);
const bladePool = pool(() => {
  const m = new THREE.Mesh(unitBox, bladeMats); m.add(new THREE.LineSegments(unitEdges, edgeMat));
  scene.add(m); return m;
});
// mines: dark body + a state-colored ring (own material: cold cyan / hot red) + expanding blast ring
const mineBodyGeo = new THREE.SphereGeometry(1, 14, 10), mineBodyMat = basic(0x171430);
const mineBodyPool = pool(() => { const m = new THREE.Mesh(mineBodyGeo, mineBodyMat); scene.add(m); return m; });
const mineRingGeo = new THREE.TorusGeometry(1, 0.16, 8, 20);
const mineRingPool = pool(() => { const m = new THREE.Mesh(mineRingGeo, basic(0x0fbcd8)); m.rotation.x = Math.PI / 2; scene.add(m); return m; });
const blastRingGeo = new THREE.RingGeometry(0.8, 1, 32);
const blastPool = pool(() => { const m = new THREE.Mesh(blastRingGeo, add(0xff3355, 1, glowTex)); m.rotation.x = -Math.PI / 2; scene.add(m); return m; });
// phantom: translucent fading bars -- opacity IS the game, so own material per slot
const phantomPool = pool(() => {
  const mat = new THREE.MeshBasicMaterial({ color: 0x19e3ff, transparent: true, opacity: 0, depthWrite: false });
  const em = new THREE.LineBasicMaterial({ color: 0xd8fbff, transparent: true, opacity: 0 });
  const m = new THREE.Mesh(unitBox, mat); m.add(new THREE.LineSegments(unitEdges, em));
  m.userData = { mat, em }; scene.add(m); return m;
});
// turrets: wall-mounted dome + aimed barrel + fired shell
const turretGeo = new THREE.SphereGeometry(11, 14, 10), turretMat = basic(0x0fbcd8);
const turretPool = pool(() => { const m = new THREE.Mesh(turretGeo, turretMat); scene.add(m); return m; });
const barrelGeo = new THREE.CylinderGeometry(2.2, 2.2, 1, 8).rotateZ(Math.PI / 2);   // long axis local +X
const barrelMat = basic(0xe8e6ff);
const barrelPool = pool(() => { const m = new THREE.Mesh(barrelGeo, barrelMat); scene.add(m); return m; });
const bulletGeo = new THREE.SphereGeometry(1, 10, 8), bulletMat = basic(0xff3355);
const bulletPool = pool(() => {
  const g = new THREE.Group();
  const m = new THREE.Mesh(bulletGeo, bulletMat);
  const h = halo(0xff3355, 30, 0.6, 0.28);
  g.add(m, h); g.userData = { m }; scene.add(g); return g;
});
// crosswinds: drifting gust chevrons -- billboard sprites, direction is the cue
const chevTexR = canvasTex(32, 16, (g2, w, h) => { g2.strokeStyle = "#ffc93c"; g2.lineWidth = 4; g2.lineCap = "round";
  g2.beginPath(); g2.moveTo(5, 2); g2.lineTo(w - 5, h / 2); g2.lineTo(5, h - 2); g2.stroke(); });
const chevTexL = canvasTex(32, 16, (g2, w, h) => { g2.strokeStyle = "#ffc93c"; g2.lineWidth = 4; g2.lineCap = "round";
  g2.beginPath(); g2.moveTo(w - 5, 2); g2.lineTo(5, h / 2); g2.lineTo(w - 5, h - 2); g2.stroke(); });
// additive, like every other glow: a fogged chevron then fades to nothing
// instead of turning into a dark "<" silhouette over the horizon backdrop
const windMatR = new THREE.SpriteMaterial({ map: chevTexR, transparent: true, opacity: .8, depthWrite: false, blending: THREE.AdditiveBlending });
const windMatL = new THREE.SpriteMaterial({ map: chevTexL, transparent: true, opacity: .8, depthWrite: false, blending: THREE.AdditiveBlending });
const windPool = pool(() => { const s = new THREE.Sprite(windMatR); s.scale.set(34, 17, 1); scene.add(s); return s; });

// orb: fresnel shader, white-hot core fading to magenta at the rim
const orbMat = new THREE.ShaderMaterial({
  uniforms: { c: { value: new THREE.Color(0xff2ea6) } },
  vertexShader: `varying vec3 vN; varying vec3 vV;
    void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
  fragmentShader: `uniform vec3 c; varying vec3 vN; varying vec3 vV;
    void main(){ float f = 1.0 - max(dot(normalize(vN), normalize(vV)), 0.0);
      vec3 col = mix(vec3(1.0), c, smoothstep(0.05, 0.5, f)); gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
    }`,
});
const orb = new THREE.Group(); scene.add(orb);
const orbBall = new THREE.Mesh(new THREE.SphereGeometry(12, 28, 20), orbMat); orbBall.position.y = 12;
const orbHalo = halo(0xff2ea6, 96, 0.6, 0.28); orbHalo.position.y = 12;
const orbSpill = new THREE.Mesh(flatQuad, add(0xff2ea6, 0.7)); orbSpill.scale.set(110, 1, 110); orbSpill.position.y = 0.5;
orb.add(orbBall, orbHalo, orbSpill);

/* ---- 2026-10-07 Laser Grid replacement audition: DEAD ENDS (maze) and DOUBLE
   TROUBLE (twins). Same rule as every game above: draw the verbatim sim state,
   never feed anything back. ---- */
// maze: lane walls are long low boxes running down the track from each exit row
const laneWallPool = pool(() => {
  const g = new THREE.Group();
  const m = new THREE.Mesh(unitBox, barMats); m.add(new THREE.LineSegments(unitEdges, edgeMat));
  const spill = new THREE.Mesh(flatQuad, add(0x19e3ff, 0.4, rectTex)); spill.position.y = 0.4;
  g.add(m, spill); g.userData = { m, spill }; scene.add(g); return g;
});
// twins: your mirrored second orb + a dashed mirror line down the middle of the track
const twinOrb = orb.clone(); twinOrb.visible = false; scene.add(twinOrb);
const mirrorMat = new THREE.MeshBasicMaterial({ color: 0xff2ea6, transparent: true, opacity: 0.35,
  blending: THREE.AdditiveBlending, depthWrite: false });
const mirrorPool = pool(() => { const m = new THREE.Mesh(flatQuad, mirrorMat); scene.add(m); return m; });

// tunnel walls: one dynamic mesh (vertex colours) + a bright inner-edge line per side
const T_ROWS = 110, WALL_H = 32;
const tunPos = new Float32Array(T_ROWS * 2 * 18 * 3), tunCol = new Float32Array(T_ROWS * 2 * 18 * 3);
const tunGeo = new THREE.BufferGeometry();
tunGeo.setAttribute("position", new THREE.BufferAttribute(tunPos, 3).setUsage(THREE.DynamicDrawUsage));
tunGeo.setAttribute("color", new THREE.BufferAttribute(tunCol, 3).setUsage(THREE.DynamicDrawUsage));
const tunMesh = new THREE.Mesh(tunGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
tunMesh.frustumCulled = false; scene.add(tunMesh);
const edgeLine = () => {
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(T_ROWS * 3), 3).setUsage(THREE.DynamicDrawUsage));
  const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xe8fdff })); l.frustumCulled = false; scene.add(l); return l;
};
const tunEdgeL = edgeLine(), tunEdgeR = edgeLine();
const tunSpill = pool(() => { const s = new THREE.Mesh(flatQuad, add(0x19e3ff, 0.32, rectTex)); scene.add(s); return s; });
const lin = c => new THREE.Color(c);                          // working-space (linear) colours
const TC = { topOut: lin(0x041c24), topMid: lin(0x0a5f70), topIn: lin(0x19d8f0), faceTop: lin(0x0fbcd8), faceBot: lin(0x03202a) };
const RIM = 26;

// sparks
const SPARK_MAX = 400;
const spPos = new Float32Array(SPARK_MAX * 3), spCol = new Float32Array(SPARK_MAX * 3);
const spGeo = new THREE.BufferGeometry();
spGeo.setAttribute("position", new THREE.BufferAttribute(spPos, 3).setUsage(THREE.DynamicDrawUsage));
spGeo.setAttribute("color", new THREE.BufferAttribute(spCol, 3).setUsage(THREE.DynamicDrawUsage));
const sparks = new THREE.Points(spGeo, new THREE.PointsMaterial({ size: 7, vertexColors: true, map: glowTex,
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
sparks.frustumCulled = false; scene.add(sparks);

/* ================= CAMERA SOLVER ================= */
// For the current stage shape, find the tightest field of view (and aim
// point) that keeps (a) the full track width FAR_REQ ahead of the orb and
// (b) the orb's whole lane at the orb's depth inside the frame and below the
// HUD strip, with the camera at either extreme of its sideways follow.
const _v = new THREE.Vector3();
let CAMFIT = { fov: 60, lookZ: 300, aspect: 1 };
function placeCam(cam, camX, lookZ) {
  cam.position.set(camX, CAM_H, CAM_BACK); cam.lookAt(camX, 0, -lookZ);
  cam.updateMatrixWorld(); cam.updateProjectionMatrix();
}
function solveCamera(aspect, hudFrac) {
  const cam = new THREE.PerspectiveCamera(60, aspect, 5, 6000);
  const pts = [];
  for (const x of [0, 400]) for (const y of [0, 30]) pts.push([X(x), y, -FAR_REQ]);
  for (const x of [0, 400]) for (const y of [0, 26]) pts.push([X(x), y, 0]);
  pts.push([X(200), 0, 40]);                                  // a little floor behind the orb
  const topLim = 1 - 2 * hudFrac - 0.01, m = 0.994;
  const fits = (fov, lookZ) => {
    cam.fov = fov;
    for (const cx of [-FOLLOW * 186, FOLLOW * 186]) {
      placeCam(cam, cx, lookZ);
      for (const p of pts) {
        _v.set(p[0], p[1], p[2]).project(cam);
        if (_v.z > 1 || Math.abs(_v.x) > m || _v.y < -m || _v.y > topLim) return false;
      }
    }
    return true;
  };
  let best = null;
  for (let lookZ = 0; lookZ <= 700; lookZ += 10) {
    let lo = 10, hi = 150;
    if (!fits(hi, lookZ)) continue;
    for (let k = 0; k < 22; k++) { const mid = (lo + hi) / 2; if (fits(mid, lookZ)) hi = mid; else lo = mid; }
    cam.fov = hi; placeCam(cam, 0, lookZ);
    if (_v.set(0, 12, 0).project(cam).y > ORB_NDC) continue;     // orb rides low, like 2D (78% down)
    if (!best || hi < best.fov) best = { fov: hi, lookZ };
  }
  best = best || { fov: 100, lookZ: 300 };
  // readability: share of the screen width the track spans at the orb and at FAR_REQ
  cam.fov = best.fov; placeCam(cam, 0, best.lookZ);
  const wAt = z => { const a = _v.set(X(0), 0, z).project(cam).x, b = _v.set(X(400), 0, z).project(cam).x; return +((b - a) / 2).toFixed(3); };
  const yAt = z => +_v.set(0, 0, z).project(cam).y.toFixed(3);
  const pitch = +(Math.atan2(CAM_H, CAM_BACK + best.lookZ) * 180 / Math.PI).toFixed(1);
  return { ...best, pitch, nearW: wAt(0), farW: wAt(-FAR_REQ), orbY: yAt(0), farY: yAt(-FAR_REQ) };
}
// view depth of a world point for the current camera (fog runs on view depth)
function viewDepth(x, y, z) { _v.set(x, y, z).applyMatrix4(camera.matrixWorldInverse); return -_v.z; }

let SW = 1, SH = 1, DPR = 1;
function resize() {
  SW = Math.max(1, stage.clientWidth); SH = Math.max(1, stage.clientHeight);
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(DPR); renderer.setSize(SW, SH, false);
  composer.setPixelRatio(DPR); composer.setSize(SW, SH);
  floorRT.setSize(Math.round(SW * DPR), Math.round(SH * DPR));
  hud.width = SW * DPR; hud.height = SH * DPR; hx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const fit = solveCamera(SW / SH, HUD_PX / SH);
  CAMFIT = { ...fit, aspect: SW / SH };
  camera.aspect = SW / SH; camera.fov = fit.fov;
  placeCam(camera, 0, fit.lookZ);
  fitBackdrop();
  setFog();
}
function setFog() {
  // Normal days: hazards are fully clear out to FOG_NEAR ahead, then melt
  // into the horizon. FOG twist: the world ends ~95-240 from the orb,
  // like the 2D radial fog.
  const d0 = viewDepth(0, 0, 0);
  const per = (viewDepth(0, 0, -100) - d0) / 100;             // view depth per world px ahead
  // FOG days keep the full horizon + sun (Felix 2026-10-01: likes the sun
  // look); only the floor fogs. The backdrop bottom is the fog colour, so the
  // fogged floor still melts into it and nothing past the fog shows.
  fitBackdrop();
  if (G.mod === "fog") { scene.fog.near = d0 + 95 * per; scene.fog.far = d0 + 240 * per; }
  else { scene.fog.near = d0 + FOG_NEAR * per; scene.fog.far = d0 + FOG_FAR * per; }
  fogMix.uniforms.uNear.value = scene.fog.near; fogMix.uniforms.uFar.value = scene.fog.far;
  fogMix.uniforms.uZBack.value = Z_BACK;
  mist.visible = G.mod === "fog"; fitMist();
  // tunnel days: the walls hide the rails up close, so the long empty track
  // past the fog must not show them either (they'd cut through the walls)
  for (const r of rails) r.visible = GID !== "tunnel";
  FLOOR_FADE.uFadeNear.value = d0 + (-Z_BACK - 55) * per; FLOOR_FADE.uFadeFar.value = d0 + (-Z_BACK) * per;
}

/* ================= DRAW THE SIM STATE ================= */
const _cols = {}; const colOf = h => _cols[h] || (_cols[h] = new THREE.Color(h));
let scroll = 0, camX = 0;
// past the fog: nothing to draw (tall walls would mask the horizon). Constant
// (Z_BACK/FOG_FAR/CAM_BACK never change), so every draw*() function shares it.
const Z_FAR_DRAW = -(FOG_FAR + 30), Z_NEAR_DRAW = CAM_BACK + 40;
const inView = (y, margin = 20) => { const z = Z(y); return z > Z_FAR_DRAW - margin && z < Z_NEAR_DRAW + margin; };

function drawWorld(py, dt) {
  const tNow = G.t;
  // camera: slight sideways follow + hit shake
  camX += (X(G.px) * FOLLOW - camX) * Math.min(1, dt * 6);
  const sh = G.shake * 0.7;
  const jx = (Math.random() - .5) * sh, jy = (Math.random() - .5) * sh;
  if (G.shake > 0) G.shake = Math.max(0, G.shake - 60 * 0.016);
  camera.position.set(camX + jx, CAM_H + jy, CAM_BACK);
  camera.lookAt(camX + jx, 0, -CAMFIT.lookZ);
  camera.updateMatrixWorld();
  grid.position.z = scroll % 40;
  if (mist.visible) driftMist();

  // orb (blinks while invulnerable, like 2D)
  orb.position.set(X(G.px), 0, 0);
  orb.visible = !(G.inv > 0 && Math.floor(G.t * 12) % 2 === 0);

  // coins
  coinPool.begin();
  G.coinDots.forEach((c, i) => {
    if (c.got || !inView(c.y)) return;
    const g = coinPool.next(); g.position.set(X(c.x), 0, Z(c.y));
    g.userData.m.rotation.y = Math.sin(tNow * 3 + i * 0.9) * 0.95;   // wobble, never edge-on
  });
  coinPool.end();

  // hazards
  barPool.begin(); rockPool.begin(); dronePool.begin(); tunSpill.begin();
  laserSegPool.begin(); laserNodePool.begin(); capPool.begin(); flagPool.begin();
  ballPool.begin(); hubPool.begin(); bladePool.begin(); mineBodyPool.begin();
  mineRingPool.begin(); blastPool.begin(); phantomPool.begin(); turretPool.begin();
  barrelPool.begin(); bulletPool.begin(); windPool.begin(); laneWallPool.begin(); mirrorPool.begin();
  tunMesh.visible = tunEdgeL.visible = tunEdgeR.visible = false;
  const gid = GID;
  if (gid === "gauntlet") {
    for (const o of G.obstacles) {
      if (!inView(o.y)) continue;
      barPiece(0, o.gapX, o.y); barPiece(o.gapX + o.gapW, W, o.y);
    }
  } else if (gid === "meteor") {
    for (const r of G.rocks) {
      if (!inView(r.y)) continue;
      const g = rockPool.next(), { m, spill } = g.userData;
      g.position.set(X(r.x), 0, Z(r.y));
      m.scale.setScalar(r.r * 1.08); m.position.y = r.r;
      m.rotation.set(r.y * 0.018 * r.mul, r.x * 0.02, 0);
      spill.scale.set(r.r * 3.6, 1, r.r * 3.6);
    }
  } else if (gid === "hunter") {
    G.things.forEach((d, i) => {
      if (!inView(d.y)) return;
      const g = dronePool.next(), { m, eye, h, spill } = g.userData;
      const hover = 15 + Math.sin(tNow * 5 + i) * 2.5;
      g.position.set(X(d.x), 0, Z(d.y));
      m.scale.set(d.r, d.r, d.r); m.position.y = hover;
      m.rotation.z = Math.sin(tNow * 3 + i) * 0.35;           // banking wobble (visual only)
      eye.position.set(0, hover + d.r * 0.55, d.r * 0.1);
      h.position.y = hover; spill.scale.set(d.r * 4.2, 1, d.r * 4.2);
    });
  } else if (gid === "tunnel") {
    drawTunnel();
  } else if (gid === "laser") {
    drawLaser();
  } else if (gid === "crushers") {
    drawCrushers();
  } else if (gid === "slalom") {
    drawSlalom();
  } else if (gid === "pong") {
    drawPong();
  } else if (gid === "windmill") {
    drawWindmill();
  } else if (gid === "mines") {
    drawMines();
  } else if (gid === "pistons") {
    drawPistons();
  } else if (gid === "phantom") {
    drawPhantom(py);
  } else if (gid === "turrets") {
    drawTurrets();
  } else if (gid === "wind") {
    drawWind();
  } else if (gid === "maze") {
    drawMaze();
  } else if (gid === "twins") {
    drawTwins();
  }
  // DOUBLE TROUBLE: your twin rides the mirror image of your lane (blinks with you)
  twinOrb.visible = gid === "twins" && orb.visible;
  if (twinOrb.visible) twinOrb.position.set(X(W - G.px), 0, 0);
  barPool.end(); rockPool.end(); dronePool.end(); tunSpill.end();
  laserSegPool.end(); laserNodePool.end(); capPool.end(); flagPool.end();
  ballPool.end(); hubPool.end(); bladePool.end(); mineBodyPool.end();
  mineRingPool.end(); blastPool.end(); phantomPool.end(); turretPool.end();
  barrelPool.end(); bulletPool.end(); windPool.end(); laneWallPool.end(); mirrorPool.end();

  // sparks (render-rate life, as in 2D draw)
  let n = 0;
  for (let i = G.sparks.length - 1; i >= 0; i--) {
    const s = G.sparks[i];
    s.life -= 0.016; if (s.life <= 0) { G.sparks.splice(i, 1); continue; }
    s.x += s.vx * 0.016; s.y += s.vy * 0.016;
    if (n >= SPARK_MAX) continue;
    const up = 12 + (0.5 - s.life) * 40;
    spPos[n*3] = X(s.x); spPos[n*3+1] = up; spPos[n*3+2] = Z(s.y);
    const c = colOf(s.color), k = Math.min(1, s.life * 2);
    spCol[n*3] = c.r * k; spCol[n*3+1] = c.g * k; spCol[n*3+2] = c.b * k; n++;
  }
  spGeo.setDrawRange(0, n);
  spGeo.attributes.position.needsUpdate = spGeo.attributes.color.needsUpdate = true;
}

function drawTunnel() {
  tunMesh.visible = tunEdgeL.visible = tunEdgeR.visible = true;
  // rows anchored to course distance (every 16 px, the path's own sample
  // spacing) so walls don't shimmer; 2D samples the same path the same way
  const zFar = -(FOG_FAR + 30), zNear = CAM_BACK + 40;   // past the fog: nothing to draw (tall walls would mask the horizon)
  const kMin = Math.floor((G.traveled - PY - zNear) / 16), kMax = Math.ceil((G.traveled - PY - zFar) / 16);
  const rows = [];
  for (let k = Math.max(kMin, Math.floor((G.traveled - PY - zNear) / 16)); k <= kMax && rows.length < T_ROWS; k++) {
    const dist = k * 16, y = G.traveled - dist;
    let xl, xr;
    if (dist < 0) { xl = -40; xr = W + 40; }
    else {
      const seg = G.path[Math.min(G.path.length - 1, Math.round(dist / 16))] || { x: W / 2 };
      const hw = G.tunnelW(dist); xl = seg.x - hw; xr = seg.x + hw;
    }
    rows.push([Z(y), X(xl), X(xr)]);
  }
  let v = 0;
  const P = (x, y, z, c) => { tunPos[v*3] = x; tunPos[v*3+1] = y; tunPos[v*3+2] = z; tunCol[v*3] = c.r; tunCol[v*3+1] = c.g; tunCol[v*3+2] = c.b; v++; };
  const OUT = 700;
  for (let i = 0; i + 1 < rows.length; i++) {
    const [z0, l0, r0] = rows[i], [z1, l1, r1] = rows[i + 1];
    // left wall top (outer -> inner gradient) + inner face
    P(-OUT, WALL_H, z0, TC.topOut); P(l0 - RIM, WALL_H, z0, TC.topMid); P(l1 - RIM, WALL_H, z1, TC.topMid);
    P(-OUT, WALL_H, z0, TC.topOut); P(l1 - RIM, WALL_H, z1, TC.topMid); P(-OUT, WALL_H, z1, TC.topOut);
    P(l0 - RIM, WALL_H, z0, TC.topMid); P(l0, WALL_H, z0, TC.topIn); P(l1, WALL_H, z1, TC.topIn);
    P(l0 - RIM, WALL_H, z0, TC.topMid); P(l1, WALL_H, z1, TC.topIn); P(l1 - RIM, WALL_H, z1, TC.topMid);
    P(l0, WALL_H, z0, TC.faceTop); P(l0, 0, z0, TC.faceBot); P(l1, 0, z1, TC.faceBot);
    P(l0, WALL_H, z0, TC.faceTop); P(l1, 0, z1, TC.faceBot); P(l1, WALL_H, z1, TC.faceTop);
    // right wall
    P(r0 + RIM, WALL_H, z0, TC.topMid); P(OUT, WALL_H, z0, TC.topOut); P(OUT, WALL_H, z1, TC.topOut);
    P(r0 + RIM, WALL_H, z0, TC.topMid); P(OUT, WALL_H, z1, TC.topOut); P(r1 + RIM, WALL_H, z1, TC.topMid);
    P(r0, WALL_H, z0, TC.topIn); P(r0 + RIM, WALL_H, z0, TC.topMid); P(r1 + RIM, WALL_H, z1, TC.topMid);
    P(r0, WALL_H, z0, TC.topIn); P(r1 + RIM, WALL_H, z1, TC.topMid); P(r1, WALL_H, z1, TC.topIn);
    P(r0, WALL_H, z0, TC.faceTop); P(r1, 0, z1, TC.faceBot); P(r0, 0, z0, TC.faceBot);
    P(r0, WALL_H, z0, TC.faceTop); P(r1, WALL_H, z1, TC.faceTop); P(r1, 0, z1, TC.faceBot);
  }
  tunGeo.setDrawRange(0, v);
  tunGeo.attributes.position.needsUpdate = tunGeo.attributes.color.needsUpdate = true;
  const eL = tunEdgeL.geometry.attributes.position.array, eR = tunEdgeR.geometry.attributes.position.array;
  rows.forEach(([z, l, r], i) => { eL.set([l, WALL_H + 0.3, z], i * 3); eR.set([r, WALL_H + 0.3, z], i * 3); });
  tunEdgeL.geometry.setDrawRange(0, rows.length); tunEdgeR.geometry.setDrawRange(0, rows.length);
  tunEdgeL.geometry.attributes.position.needsUpdate = tunEdgeR.geometry.attributes.position.needsUpdate = true;
  // floor light spill along the channel walls, every 4th row
  for (let i = 0; i + 4 < rows.length; i += 4) {
    const [z0, l0, r0] = rows[i], [z1, l1, r1] = rows[i + 4], zm = (z0 + z1) / 2, len = Math.abs(z1 - z0) + 8;
    for (const xm of [(l0 + l1) / 2, (r0 + r1) / 2]) {
      const s = tunSpill.next(); s.position.set(xm, 0.4, zm); s.scale.set(46, 1, len);
    }
  }
}

/* ---- 2026-09-27 port: draw functions for the other 10 games. Each reads the
   verbatim sim state above (G.beams / G.things / G.obstacles / G.bullets) --
   nothing here feeds back into hit detection or scoring. ---- */
function drawLaser() {
  for (const b of G.beams) {
    if (!inView(b.y)) continue;
    const s = Math.sin(G.t * 2 * Math.PI / b.period + b.phase);
    const hot = s > 0 ? 0 : 1;
    const closing = laserSwapIn(b) < LASER_WARN;
    const seg = [[0, b.split], [b.split, W]];
    for (let i = 0; i < 2; i++) {
      const [x0, x1] = seg[i];
      // 3D-only readability (Felix 2026-09-27): brighter dark side, and during
      // the swap warning BOTH halves blink -- the dark wire flashes (about to
      // fire) and the lit beam dims (about to shut off). Rules unchanged.
      const blink = closing && Math.floor(G.t * 12) % 2 === 0;
      if (i === hot) laserSeg(x0, x1, b.y, blink ? 0.4 : 1, true, b.thick);
      else laserSeg(x0, x1, b.y, closing ? (blink ? 0.95 : 0.35) : 0.32, false, b.thick, closing);
    }
    for (const ex of [4, b.split, W - 4]) {
      const nd = laserNodePool.next(); nd.position.set(X(ex), 8, Z(b.y));
    }
  }
}
function drawCrushers() {
  for (const c of G.things) {
    if (!inView(c.y)) continue;
    const hg = 30 + (c.base - 30) * (0.5 + 0.5 * Math.sin(G.t * 2 * Math.PI / c.period + c.phase));
    barPiece(0, c.cxm - hg, c.y); barPiece(c.cxm + hg, W, c.y);
    const cap1 = capPool.next(); cap1.position.set(X(c.cxm - hg - 1.5), 11, Z(c.y)); cap1.scale.set(3, 22, 14);
    const cap2 = capPool.next(); cap2.position.set(X(c.cxm + hg + 1.5), 11, Z(c.y)); cap2.scale.set(3, 22, 14);
  }
}
function drawSlalom() {
  for (const g of G.things) {
    if (!inView(g.y)) continue;
    const L = g.len + (g.amp ? Math.sin(G.t * 1.8 + g.phase) * g.amp : 0);
    if (g.side === 0) barPiece(0, L, g.y); else barPiece(W - L, W, g.y);
    const tip = g.side === 0 ? L : W - L;
    const fl = flagPool.next();
    fl.position.set(X(tip), BAR_H + 12, Z(g.y));
    fl.scale.set(g.side === 0 ? 1 : -1, 1, 1);
  }
}
function drawPong() {
  for (const b of G.things) {
    if (!inView(b.y)) continue;
    const g = ballPool.next(), { m, h, streak } = g.userData;
    g.position.set(X(b.x), 0, Z(b.y));
    m.scale.setScalar(b.r); m.position.y = b.r;
    h.position.y = b.r; h.scale.set(b.r * 3.4, b.r * 3.4, 1);
    const dir = Math.sign(b.vx) || 1;
    streak.position.set(-dir * b.r * 1.3, 0.4, 0);
    streak.scale.set(b.r * 1.5, 1, b.r * 1.5);
  }
}
function drawWindmill() {
  for (const w of G.things) {
    if (!inView(w.y, w.len)) continue;
    const a = w.phase + G.t * w.om;
    const dirs = w.cross ? [a, a + Math.PI / 2] : [a];
    for (const ang of dirs) {
      const bl = bladePool.next();
      bl.position.set(X(w.cxm), 0, Z(w.y));
      bl.scale.set(w.len, 18, 9);
      bl.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang)));
    }
    const hb = hubPool.next(); hb.position.set(X(w.cxm), 9, Z(w.y));
  }
}
function drawMines() {
  for (const m of G.things) {
    if (!inView(m.y) || m.state === 3) continue;
    if (m.state === 2) {
      const k = 1 - m.blastT / 0.25;
      const ring = blastPool.next();
      ring.position.set(X(m.x), 1, Z(m.y));
      ring.scale.setScalar(m.blastR * (0.4 + 0.6 * k));
      ring.material.opacity = 1 - k;
      continue;
    }
    const hot = m.state === 1 && Math.floor(G.t * 10) % 2 === 0;
    const body = mineBodyPool.next();
    body.position.set(X(m.x), m.r, Z(m.y)); body.scale.setScalar(m.r);
    const ring = mineRingPool.next();
    ring.position.set(X(m.x), 2, Z(m.y)); ring.scale.setScalar(m.r * 1.3);
    ring.material.color.set(hot ? 0xff3355 : 0x0fbcd8);
  }
}
function drawPistons() {
  for (const p of G.things) {
    if (!inView(p.y)) continue;
    const e = p.maxL * Math.pow(Math.max(0, Math.sin(G.t * 2 * Math.PI / p.period + p.phase)), 1.7);
    if (p.side === 0) barPiece(0, e, p.y); else barPiece(W - e, W, p.y);
    if (e > 4) {
      const cap = capPool.next(), tipX = p.side === 0 ? e : W - e;
      cap.position.set(X(tipX), 11, Z(p.y)); cap.scale.set(4, 22, 16);
    }
  }
}
function drawPhantom(py) {
  for (const o of G.obstacles) {
    if (!inView(o.y)) continue;
    // same reveal window as 2D (distance-ahead of the player, not camera fog) --
    // never later than 2D's own fade-in, since it's the identical formula on
    // the identical o.y/py.
    const a = Math.max(0, Math.min(1, (o.y - (py - 330)) / 190));
    if (a <= 0.01) continue;
    const flicker = 0.78 + 0.22 * Math.sin(G.t * 22 + o.phase);
    const op = a * flicker;
    const b1 = phantomPool.next();
    b1.position.set(X(o.gapX / 2), 0, Z(o.y)); b1.scale.set(Math.max(0.5, o.gapX), 22, 14);
    b1.userData.mat.opacity = op * 0.6; b1.userData.em.opacity = op;
    const w2 = W - o.gapX - o.gapW;
    if (w2 > 0.5) {
      const b2 = phantomPool.next();
      b2.position.set(X(o.gapX + o.gapW + w2 / 2), 0, Z(o.y)); b2.scale.set(w2, 22, 14);
      b2.userData.mat.opacity = op * 0.6; b2.userData.em.opacity = op;
    }
  }
}
function drawTurrets() {
  for (const t of G.things) {
    if (!inView(t.y)) continue;
    const x0 = t.side === 0 ? 4 : W - 4;
    turretPool.next().position.set(X(x0), 20, Z(t.y));
    const d = Math.hypot(t.tx - x0, t.ty - t.y) || 1;
    const dx = (t.tx - x0) / d, dz = (t.ty - t.y) / d;
    const br = barrelPool.next();
    br.position.set(X(x0) + dx * 9, 20, Z(t.y) + dz * 9);
    br.scale.set(18, 1, 1);
    br.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), new THREE.Vector3(dx, 0, dz));
  }
  for (const b of G.bullets) {
    if (b.y < -900) continue;
    const g = bulletPool.next(), { m } = g.userData;
    g.position.set(X(b.x), 14, Z(b.y));
    m.scale.setScalar(b.r * 1.4);
  }
}
function drawWind() {
  for (const o of G.obstacles) {
    if (!inView(o.y)) continue;
    barPiece(0, o.gapX, o.y); barPiece(o.gapX + o.gapW, W, o.y);
  }
  for (const z of G.things) {
    if (!inView(z.yTop + z.h / 2, z.h)) continue;
    for (let r = 0; r < 5; r++) {
      const yy = z.yTop + z.h * (r + 0.5) / 5;
      if (!inView(yy, 10)) continue;
      for (let k = 0; k < 4; k++) {
        const xx = ((k * 100 + r * 37 + G.t * z.dir * 130) % (W + 80) + (W + 80)) % (W + 80) - 40;
        // fully fogged = invisible anyway; skip it so nothing floats over the sky
        if (viewDepth(X(xx), 40, Z(yy)) >= scene.fog.far) continue;
        const s = windPool.next();
        s.material = z.dir > 0 ? windMatR : windMatL;
        s.position.set(X(xx), 40, Z(yy));
      }
    }
  }
}

function drawMaze() {
  for (const g of G.things) {
    if (!inView(g.y + g.lock / 2, g.lock / 2 + 20)) continue;
    let x = 0;                                               // exit row: walls over the closed lanes
    for (const [x0, x1] of g.gaps) { barPiece(x, x0, g.y); x = x1; }
    barPiece(x, W, g.y);
    for (const [x0, x1] of g.gaps) for (const ex of [x0, x1]) {   // white posts mark each exit
      if (ex <= 0 || ex >= W) continue;
      const c = capPool.next(); c.position.set(X(ex), 11, Z(g.y)); c.scale.set(4, 22, 16);
    }
    for (let k = 1; k <= 3; k++) if (g.walls[k - 1]) {       // lane walls, exit row back toward the orb
      const lw = laneWallPool.next(), { m, spill } = lw.userData;
      lw.position.set(X(k * 100), 0, Z(g.y + g.lock / 2));
      m.scale.set(6, 16, g.lock); spill.scale.set(30, 1, g.lock + 16);
    }
  }
}
function drawTwins() {
  for (const o of G.obstacles) {
    if (!inView(o.y)) continue;
    for (const b of o.blocks) { const x0 = GAMES.twins.bx(b); barPiece(x0, x0 + b.w, o.y); }
  }
  // dashed mirror line (2D draws the same dashes, scrolling with the run clock)
  const off = (G.t * 120) % 28;
  for (let y = off - 28 - 700; y < H + 200; y += 28) {
    if (!inView(y + 7, 10)) continue;
    const d = mirrorPool.next(); d.position.set(0, 0.6, Z(y + 7)); d.scale.set(3, 1, 14);
  }
}

/* ================= HUD (2D overlay, same layout as the live HUD) ================= */
const _p = new THREE.Vector3();
function toScreen(x, y, z) { _p.set(x, y, z).project(camera); return [(_p.x + 1) / 2 * SW, (1 - _p.y) / 2 * SH, _p.z]; }
function drawHud(showRunHud) {
  hx.clearRect(0, 0, SW, SH);
  hx.font = "bold 12px Menlo, monospace"; hx.textAlign = "center";
  for (let i = G.floaters.length - 1; i >= 0; i--) {
    const f = G.floaters[i];
    f.life -= 0.016; if (f.life <= 0) { G.floaters.splice(i, 1); continue; }
    f.y -= 34 * 0.016;
    const [sx, sy] = toScreen(X(f.x), 40 + (0.9 - f.life) * 30, Z(f.y));
    hx.globalAlpha = Math.min(1, f.life * 1.6); hx.fillStyle = f.color;
    hx.fillText(f.txt, sx, sy); hx.globalAlpha = 1;
  }
  // turret telegraph: same flash rate as 2D (Math.floor(G.t*12)%2), same
  // t.aiming window computed by the verbatim sim -- just projected to screen.
  if (GID === "turrets") for (const t of G.things) {
    if (!t.aiming) continue;
    const x0 = t.side === 0 ? 4 : W - 4;
    const [sx0, sy0] = toScreen(X(x0), 20, Z(t.y));
    const [sx1, sy1] = toScreen(X(t.tx), 20, Z(t.ty));
    hx.globalAlpha = Math.floor(G.t * 12) % 2 === 0 ? .55 : .22;
    hx.strokeStyle = "#ff3355"; hx.lineWidth = 2;
    hx.beginPath(); hx.moveTo(sx0, sy0); hx.lineTo(sx1, sy1); hx.stroke();
    hx.globalAlpha = 1;
  }
  if (!showRunHud) return;
  hx.shadowColor = "rgba(7,6,15,.95)"; hx.shadowBlur = 6;
  hx.fillStyle = "#e8e6ff"; hx.font = "bold 15px Menlo, monospace"; hx.textAlign = "left";
  hx.fillText("♥".repeat(Math.max(0, G.hearts)), 12, 24);
  hx.textAlign = "center";
  const tier = comboTier();
  hx.fillStyle = "#ffc93c";
  hx.fillText(String(G.coins) + (tier > 1 ? "  x" + tier : ""), SW / 2, 24);
  hx.textAlign = "right";
  const left = Math.max(0, RUN_SECS() - G.t);
  hx.fillStyle = left < 10 ? "#ff2ea6" : "#8a86b8";
  hx.fillText(Math.ceil(left) + "s", SW - 12, 24);
  hx.shadowBlur = 0;
}

function applyMode() {                                      // bloom always on
  for (const s of halos) s.material.opacity = s.userData.op[1];
}
function renderFloor() {                                    // floor-only layer for fogMix, same camera
  const u = fogMix.uniforms;
  u.uInvProj.value.copy(camera.projectionMatrixInverse); u.uCamWorld.value.copy(camera.matrixWorld);
  u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
  camera.layers.set(FLOOR); renderer.setRenderTarget(floorRT); renderer.render(scene, camera);
  renderer.setRenderTarget(null); camera.layers.set(0);
}
function present() { renderFloor(); composer.render(); }

/* ================= PERF + LOOK-AHEAD MEASUREMENT ================= */
const perf = { intervals: [], cpu: [], frames: 0 };
const vis = new Map();         // hazard -> {t2, t3, tReach}
function measure(py) {
  const band = 1 - 2 * (HUD_PX / SH);
  const fogAt = (x, y, z) => { const d = viewDepth(x, y, z); return Math.max(0, Math.min(1, (d - scene.fog.near) / (scene.fog.far - scene.fog.near))); };
  const seen3 = (x0, x1, y0, y1, z0, z1) => {
    for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) {
      _p.set(x, y, z).project(camera);
      if (_p.z < 1 && _p.x > -1 && _p.x < 1 && _p.y > -1 && _p.y < band && fogAt(x, y, z) <= 0.5) return true;
    }
    return false;
  };
  const fog2 = (x, y) => G.mod !== "fog" || ((GID === "twins")      // 2D radial fog half-alpha (twins: the oval between both orbs)
    ? Math.hypot((x - W / 2) / (1 + Math.abs(G.px - W / 2) / 95), y - py) < 167 : Math.hypot(x - G.px, y - py) < 167);
  const track = (key, s2, s3, reached) => {
    let e = vis.get(key); if (!e) { e = { t2: null, t3: null, tReach: null }; vis.set(key, e); }
    if (e.t2 === null && s2) e.t2 = G.t;
    if (e.t3 === null && s3) e.t3 = G.t;
    if (e.tReach === null && reached) e.tReach = G.t;
  };
  if (GID === "gauntlet" || GID === "wind") for (const o of G.obstacles) {
    if (o.y < -900) continue;
    const s2 = o.y + 7 > 0 && fog2(Math.max(0, Math.min(W, G.px)), o.y);
    const s3 = seen3(X(0), X(W), 0, BAR_H, Z(o.y) - BAR_D / 2, Z(o.y) + BAR_D / 2);
    track(o, s2, s3, o.y > py - 12);
  }
  if (GID === "laser") for (const b of G.beams) {
    if (b.y < -900) continue;
    const s2 = b.y + b.thick > 0 && fog2(Math.max(0, Math.min(W, G.px)), b.y);
    const s3 = seen3(X(0), X(W), 0, 16, Z(b.y) - 8, Z(b.y) + 8);
    track(b, s2, s3, b.y > py - b.thick - 10);
  }
  if (GID === "crushers") for (const c of G.things) {
    if (c.y < -900) continue;
    const s2 = c.y + 7 > 0 && fog2(c.cxm, c.y);
    const s3 = seen3(X(0), X(W), 0, BAR_H, Z(c.y) - BAR_D / 2, Z(c.y) + BAR_D / 2);
    track(c, s2, s3, c.y > py - 12);
  }
  if (GID === "slalom") for (const g2 of G.things) {
    if (g2.y < -900) continue;
    const s2 = g2.y + 6 > 0 && fog2(g2.side === 0 ? 0 : W, g2.y);
    const s3 = seen3(X(0), X(W), 0, BAR_H, Z(g2.y) - BAR_D / 2, Z(g2.y) + BAR_D / 2);
    track(g2, s2, s3, g2.y > py - 12);
  }
  if (GID === "pistons") for (const p of G.things) {
    if (p.y < -900) continue;
    const s2 = p.y + 11 > 0 && fog2(p.side === 0 ? 0 : W, p.y);
    const s3 = seen3(X(0), X(W), 0, BAR_H, Z(p.y) - BAR_D / 2, Z(p.y) + BAR_D / 2);
    track(p, s2, s3, p.y > py - 11);
  }
  if (GID === "pong") for (const b of G.things) {
    if (b.y < -900) continue;
    track(b, b.y + b.r > 0 && fog2(b.x, b.y), seen3(X(b.x - b.r), X(b.x + b.r), 0, 2 * b.r, Z(b.y) - b.r, Z(b.y) + b.r), b.y > py - b.r - 10);
  }
  if (GID === "windmill") for (const w of G.things) {
    if (w.y < -900) continue;
    const half = w.len / 2;
    const s2 = w.y + half > 0 && fog2(w.cxm, w.y);
    // full swing radius in Z too -- the blade sweeps in the ground plane, so a
    // tight z-band around the hub misses the tip's nearest reach mid-rotation
    const s3 = seen3(X(w.cxm - half), X(w.cxm + half), 0, 18, Z(w.y) - half, Z(w.y) + half);
    track(w, s2, s3, w.y > py - half - 24);
  }
  if (GID === "mines") for (const m of G.things) {
    if (m.y < -900) continue;
    track(m, m.y + m.r > 0 && fog2(m.x, m.y), seen3(X(m.x - m.r), X(m.x + m.r), 0, 2 * m.r, Z(m.y) - m.r, Z(m.y) + m.r), m.y > py - 80);
  }
  if (GID === "phantom") for (const o of G.obstacles) {
    if (o.y < -900) continue;
    // phantom's own fade gate is STRICTER than the generic camera fog (it stays
    // invisible until 330 world-px ahead of the player, well inside the normal
    // fog band) -- s2 must reflect that reveal, not just fog2, so the "no later
    // than 2D" check is measuring the real 2D telegraph.
    const s2 = o.y + 7 > 0 && fog2(Math.max(0, Math.min(W, G.px)), o.y) && (o.y - (py - 330)) > 1.9;
    const s3 = seen3(X(0), X(W), 0, BAR_H, Z(o.y) - BAR_D / 2, Z(o.y) + BAR_D / 2);
    track(o, s2, s3, o.y > py - 12);
  }
  // turrets: the aim telegraph is a HUD line keyed directly to the shared
  // sim's t.aiming flag (see drawHud), so its reveal instant is byte-identical
  // between 2D and 3D by construction -- no separate lead/lag to measure.
  if (GID === "maze") G.things.forEach((g, i) => {
    if (g.y < -900) return;
    // exit row, and (separately) the near end of its lane walls -- the walls reach you first
    const s2 = g.y + 7 > 0 && fog2(Math.max(0, Math.min(W, G.px)), g.y);
    const s3 = seen3(X(0), X(W), 0, BAR_H, Z(g.y) - BAR_D / 2, Z(g.y) + BAR_D / 2);
    track(g, s2, s3, g.y > py - 12);
    if (!g.walls.some(Boolean)) return;
    const yn = g.y + g.lock;
    const w2 = yn > 0 && fog2(Math.max(0, Math.min(W, G.px)), yn);
    const w3 = seen3(X(100), X(300), 0, 16, Z(yn) - 2, Z(yn));
    track("mw" + i, w2, w3, yn > py);
  });
  if (GID === "twins") for (const o of G.obstacles) {
    if (o.y < -900) continue;
    const s2 = o.y + 7 > 0 && fog2(Math.max(0, Math.min(W, G.px)), o.y);
    const s3 = seen3(X(0), X(W), 0, BAR_H, Z(o.y) - BAR_D / 2, Z(o.y) + BAR_D / 2);
    track(o, s2, s3, o.y > py - 12);
  }
  if (GID === "meteor") for (const r of G.rocks) {
    if (r.y < -900) continue;
    track(r, r.y + r.r > 0 && fog2(r.x, r.y), seen3(X(r.x - r.r), X(r.x + r.r), 0, 2 * r.r, Z(r.y) - r.r, Z(r.y) + r.r), r.y > py - r.r - 10);
  }
  if (GID === "hunter") for (const d of G.things) {
    if (d.y < -900) continue;
    track(d, d.y + d.r > 0 && fog2(d.x, d.y), seen3(X(d.x - d.r), X(d.x + d.r), 10, 22, Z(d.y) - d.r, Z(d.y) + d.r), d.y > py - d.r - 10);
  }
  if (GID === "tunnel") {
    // every 64 px of course is one "hazard": its two wall edges
    const k0 = Math.floor((G.traveled - py) / 64), k1 = Math.ceil((G.traveled + 900) / 64);
    for (let k = Math.max(0, k0); k <= k1; k++) {
      const dist = k * 64, y = G.traveled - dist;
      const seg = G.path[Math.min(G.path.length - 1, Math.round(dist / 16))]; if (!seg) continue;
      const hw = G.tunnelW(dist), xl = seg.x - hw, xr = seg.x + hw;
      const s2 = y > 0 && fog2(seg.x, y);
      const s3 = seen3(X(Math.max(0, xl)), X(Math.max(0, xl)), 0, WALL_H, Z(y), Z(y)) && seen3(X(Math.min(W, xr)), X(Math.min(W, xr)), 0, WALL_H, Z(y), Z(y));
      track("row" + k, s2, s3, y > py);
    }
  }
}
function measureReport() {
  const rows = [...vis.values()].filter(e => e.t2 !== null && e.t2 > 0.3 && e.tReach !== null);
  const lead = rows.map(e => (e.t2 - (e.t3 ?? Infinity)));
  const warn2 = rows.map(e => e.tReach - e.t2), warn3 = rows.map(e => e.tReach - (e.t3 ?? e.tReach));
  const mn = a => a.length ? Math.min(...a) : null, avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  return { n: rows.length, minLead: mn(lead), avgLead: avg(lead), neverSeen3: rows.filter(e => e.t3 === null).length,
           minWarn2: mn(warn2), minWarn3: mn(warn3), avgWarn2: avg(warn2), avgWarn3: avg(warn3), cam: CAMFIT, fog: [scene.fog.near, scene.fog.far] };
}

/* ================= HOOKS FOR index.html ================= */
// current game id, read from the sim's own G.game at run start
let GID = "gauntlet";
let runFrames = 0;
window.R3D = {
  ready: true,
  ok() { return !ctxLost && !renderer.getContext().isContextLost(); },
  onStart() {
    GID = Object.keys(GAMES).find(k => GAMES[k] === G.game) || "gauntlet";
    if (Math.max(1, stage.clientWidth) !== SW || Math.max(1, stage.clientHeight) !== SH) resize();
    runFrames = 0; scroll = 0; camX = 0; vis.clear(); perf.intervals = []; perf.cpu = []; setFog();
    drawWorld(PY, 0); drawHud(true); present();             // first frame now: no stale frame from the last run
  },
  frame(py, dt, vs, frameMs) {
    const t0 = performance.now();
    scroll += vs;
    drawWorld(py, dt);
    drawHud(true);
    present();
    if (PERF) renderer.getContext().finish();
    const cpu = performance.now() - t0;
    runFrames++;
    if (runFrames > 20) { perf.intervals.push(frameMs); perf.cpu.push(cpu); }
    if (MEASURE) measure(py);
  },
  measureReport,
  perfReport() {
    const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); };
    return { mode: "bloom", frames: perf.intervals.length, intervalP50: q(perf.intervals, .5), intervalP95: q(perf.intervals, .95),
             cpuP50: q(perf.cpu, .5), cpuP95: q(perf.cpu, .95), dpr: DPR, size: [SW, SH], cam: CAMFIT };
  },
  info() { return { renderer: renderer.getContext().getParameter(renderer.getContext().VERSION), cam: CAMFIT, fog: [scene.fog.near, scene.fog.far] }; },
};
new ResizeObserver(() => resize()).observe(stage);
addEventListener("resize", resize);
applyMode();
resize();
