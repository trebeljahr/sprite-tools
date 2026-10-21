import { VIEWPORT, WORLD } from "./controller";
export interface Camera {
  x: number;
  y: number;
}
export function cameraFor(x: number, y: number): Camera {
  return {
    x: Math.max(
      WORLD.left,
      Math.min(WORLD.left + WORLD.width - VIEWPORT.width, x - VIEWPORT.width / 2),
    ),
    y: Math.min(0, y - 400),
  };
}
const wave = (n: number) => (Math.sin(n * 17.31 + 5.7) + 1) / 2;
function repeat(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  factor: number,
  spacing: number,
  draw: (x: number, i: number) => void,
) {
  const offset = camera.x * factor;
  ctx.save();
  ctx.translate(-offset, -camera.y * factor);
  for (
    let i = Math.floor((offset - spacing) / spacing);
    i <= Math.ceil((offset + VIEWPORT.width + spacing) / spacing);
    i++
  )
    draw(i * spacing, i);
  ctx.restore();
}
/** Procedural scenery stays independent of the supplied character artwork. */
export function paintScene(ctx: CanvasRenderingContext2D, camera: Camera, play: boolean) {
  const { width, height } = VIEWPORT;
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#e8e6d6");
  sky.addColorStop(1, "#c9cfb4");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);
  if (!play) {
    ctx.fillStyle = "#ded8c1";
    ctx.fillRect(0, WORLD.ground, width, height);
    ctx.strokeStyle = "#a99f84";
    ctx.beginPath();
    ctx.moveTo(0, WORLD.ground + 0.5);
    ctx.lineTo(width, WORLD.ground + 0.5);
    ctx.stroke();
    return;
  }
  // Haze and distant crowns move slowly; ruins and nearer trunks give depth cues.
  repeat(ctx, camera, 0.12, 260, (x, i) => {
    ctx.fillStyle = "#b4bea5";
    ctx.beginPath();
    ctx.ellipse(x + 130, 430 + wave(i) * 35, 235, 185 + wave(i + 2) * 70, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#a1b096";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(x + 90, 480);
    ctx.bezierCurveTo(x + 130, 380, x + 85, 290, x + 120, 190 + wave(i) * 70);
    ctx.stroke();
  });
  repeat(ctx, camera, 0.35, 430, (x, i) => {
    const top = 235 + wave(i) * 45;
    ctx.strokeStyle = "#98a68f";
    ctx.lineWidth = 22;
    ctx.beginPath();
    ctx.moveTo(x + 45, 510);
    ctx.lineTo(x + 45, top + 80);
    ctx.bezierCurveTo(x + 45, top - 35, x + 205, top - 35, x + 205, top + 80);
    ctx.lineTo(x + 205, 510);
    ctx.stroke();
    ctx.strokeStyle = "#bec5ab";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + 36, 490);
    ctx.lineTo(x + 36, top + 76);
    ctx.bezierCurveTo(x + 40, top - 40, x + 210, top - 35, x + 215, top + 80);
    ctx.stroke();
    ctx.fillStyle = "#a5b398";
    for (let j = 0; j < 3; j++) {
      ctx.beginPath();
      ctx.ellipse(x + 75 + j * 50, top + 5 + wave(i + j) * 15, 22, 5, -0.2, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  repeat(ctx, camera, 0.65, 690, (x, i) => {
    const bend = wave(i) * 85;
    ctx.fillStyle = "#647c67";
    ctx.beginPath();
    ctx.moveTo(x + 20, 510);
    ctx.bezierCurveTo(x + 90, 345, x + bend, 165, x + 20, -40);
    ctx.lineTo(x + 60, -40);
    ctx.bezierCurveTo(x + 95 + bend, 220, x + 105, 380, x + 75, 510);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#647c67";
    ctx.lineWidth = 15;
    ctx.beginPath();
    ctx.moveTo(x + 55, 185);
    ctx.bezierCurveTo(x + 125, 155, x + 130, 100, x + 220, 85);
    ctx.stroke();
    ctx.strokeStyle = "#869778";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + 42, 485);
    ctx.bezierCurveTo(x + 78, 340, x + 50 + bend, 195, x + 42, -20);
    ctx.stroke();
  });
  ctx.save();
  ctx.translate(-camera.x, -camera.y);
  ctx.fillStyle = "#485c48";
  ctx.fillRect(WORLD.left, WORLD.ground, WORLD.width, height * 2);
  ctx.fillStyle = "#85976a";
  ctx.fillRect(WORLD.left, WORLD.ground, WORLD.width, 7);
  ctx.strokeStyle = "#b2ba87";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(WORLD.left, WORLD.ground);
  ctx.lineTo(WORLD.left + WORLD.width, WORLD.ground);
  ctx.stroke();
  // Ground marks are fixed in world space, making foot sliding easy to inspect.
  for (let i = Math.floor(camera.x / 90) - 1; i < Math.ceil((camera.x + width) / 90) + 1; i++) {
    const x = i * 90;
    ctx.fillStyle = "#b1b68b";
    ctx.beginPath();
    ctx.ellipse(x + 24, 502, 9 + wave(i) * 8, 3, -0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#71835d";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 500);
    ctx.quadraticCurveTo(x - 9, 488, x - 5, 482);
    ctx.moveTo(x, 500);
    ctx.quadraticCurveTo(x + 11, 490, x + 14, 488);
    ctx.stroke();
  }
  for (const p of WORLD.platforms) {
    if (p.x + p.width < camera.x || p.x > camera.x + width) continue;
    ctx.fillStyle = "#6d8061";
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + p.width, p.y);
    ctx.lineTo(p.x + p.width - 15, p.y + 22);
    ctx.lineTo(p.x + 12, p.y + 18);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#b4b78b";
    ctx.fillRect(p.x, p.y, p.width, 5);
    ctx.strokeStyle = "#536d51";
    ctx.lineWidth = 2;
    for (let x = p.x + 19; x < p.x + p.width; x += 39) {
      ctx.beginPath();
      ctx.moveTo(x, p.y + 18);
      ctx.quadraticCurveTo(x - 7, p.y + 35, x + 3, p.y + 44);
      ctx.stroke();
    }
  }
  ctx.restore();
}
