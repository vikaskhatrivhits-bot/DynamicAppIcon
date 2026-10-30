'use strict';
/** Image helpers built on macOS `sips` (no npm dependencies). */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SIZE = 1024;

/** { width, height, format } of any image macOS can read, or null. */
function imageInfo(file) {
  try {
    const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'format', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const read = key => (new RegExp(`${key}: (\\S+)`).exec(out) || [])[1];
    const width = Number(read('pixelWidth'));
    const height = Number(read('pixelHeight'));
    return width && height ? { width, height, format: read('format') } : null;
  } catch {
    return null;
  }
}

/** Why `file` cannot be used as an icon source, or null when it can. */
function sourceProblem(file, info) {
  const name = path.basename(file);
  if (!info) return `${file} is not an image that macOS can read.`;
  if (info.width !== info.height) return `${name} is ${info.width}x${info.height}; app icons must be square.`;
  if (info.width < SIZE) {
    return (
      `${name} is ${info.width}x${info.height}; use at least ${SIZE}x${SIZE} ` +
      '(smaller images would be upscaled and look blurry).'
    );
  }
  return null;
}

/** Writes `source` to `target` as a 1024x1024 PNG (byte-for-byte copy when it already is one). */
function writeMaster(source, target, info) {
  if (info.format === 'png' && info.width === SIZE && info.height === SIZE) {
    fs.copyFileSync(source, target); // keep the exact pixels
    return;
  }
  execFileSync('sips', ['-s', 'format', 'png', '-z', String(SIZE), String(SIZE), source, '--out', target], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

module.exports = { SIZE, imageInfo, sourceProblem, writeMaster };
