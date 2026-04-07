#!/usr/bin/env node

/**
 * GIL Image Compression Script
 * Compresses all JPG, JPEG, and PNG images in the repo.
 * Originals are saved to an `originals/` backup folder before compression.
 *
 * Usage:
 *   node compress.js              — compress everything
 *   node compress.js headshots/   — compress one folder only
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const TARGET_FOLDERS = [
  '.',          // repo root (og-image.jpg, chapter-photo1.png, etc.)
  'headshots',  // board member headshots
];

const EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif', '.tiff', '.tif', '.avif'];

// Formats that get converted to JPG (photos). PNG stays PNG. Everything else → JPG.
const CONVERT_TO_JPG = new Set(['.webp', '.gif', '.heic', '.heif', '.tiff', '.tif', '.avif']);

// Formats where sharp's libheif may lack decode support — use macOS sips as fallback
const HEIC_FORMATS = new Set(['.heic', '.heif']);

const SETTINGS = {
  jpg:  { quality: 82 },   // 82 is sweet spot — sharp with major size reduction
  png:  { quality: 82, compressionLevel: 9 },
};

const BACKUP_FOLDER = 'originals';
const MAX_WIDTH = 1600; // px — prevents unnecessarily huge images

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function getFiles(folder) {
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder)
    .filter(f => EXTENSIONS.includes(path.extname(f).toLowerCase()))
    .map(f => path.join(folder, f));
}

async function compress(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const converting = CONVERT_TO_JPG.has(ext);
  const outExt = converting ? '.jpg' : ext;
  const outBase = converting ? base.slice(0, -ext.length) + '.jpg' : base;
  const outPath = path.join(dir, outBase);

  // Back up original
  const backupDir = path.join(dir, BACKUP_FOLDER);
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, base);
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath);
  }

  const originalSize = fs.statSync(filePath).size;

  try {
    // HEIC: try sharp first, fall back to macOS sips if libheif isn't built in
    if (HEIC_FORMATS.has(ext)) {
      try {
        await sharp(filePath).resize({ width: MAX_WIDTH, withoutEnlargement: true }).jpeg(SETTINGS.jpg).toFile(outPath);
      } catch (heicErr) {
        if (heicErr.message.includes('compression format') || heicErr.message.includes('bad seek')) {
          // Use sips (macOS built-in) to convert HEIC → JPG
          execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(SETTINGS.jpg.quality), filePath, '--out', outPath]);
          // Then re-compress through sharp to enforce MAX_WIDTH
          const tmp = outPath + '.tmp.jpg';
          await sharp(outPath).resize({ width: MAX_WIDTH, withoutEnlargement: true }).jpeg(SETTINGS.jpg).toFile(tmp);
          fs.renameSync(tmp, outPath);
        } else {
          throw heicErr;
        }
      }
      if (converting) fs.unlinkSync(filePath);
    } else {
      let pipeline = sharp(filePath).resize({ width: MAX_WIDTH, withoutEnlargement: true });
      if (outExt === '.png') {
        pipeline = pipeline.png(SETTINGS.png);
      } else {
        pipeline = pipeline.jpeg(SETTINGS.jpg);
      }
      const compressed = await pipeline.toBuffer();
      fs.writeFileSync(outPath, compressed);
      // Remove original if it was converted to a different filename
      if (converting) fs.unlinkSync(filePath);
    }

    const newSize = fs.statSync(outPath).size;
    const saving = ((1 - newSize / originalSize) * 100).toFixed(1);
    const arrow = newSize < originalSize ? '✅' : '⚠️ ';
    const label = converting ? `${filePath} → ${outBase}` : filePath;

    console.log(
      `${arrow} ${label.padEnd(55)} ${formatBytes(originalSize).padStart(9)} → ${formatBytes(newSize).padStart(9)}  (${saving}% smaller)`
    );
  } catch (err) {
    console.error(`❌ Failed: ${filePath} — ${err.message}`);
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const targetArg = process.argv[2];
  const folders = targetArg ? [targetArg] : TARGET_FOLDERS;

  let allFiles = [];
  for (const folder of folders) {
    allFiles = allFiles.concat(getFiles(folder));
  }

  if (allFiles.length === 0) {
    console.log('No images found to compress.');
    return;
  }

  console.log(`\nCompressing ${allFiles.length} image(s)...\n`);
  console.log('Original backed up to originals/ subfolder in each directory.\n');

  const before = allFiles.reduce((sum, f) => sum + fs.statSync(f).size, 0);

  for (const file of allFiles) {
    await compress(file);
  }

  const after = allFiles.reduce((sum, f) => {
    const ext = path.extname(f).toLowerCase();
    const outPath = CONVERT_TO_JPG.has(ext)
      ? path.join(path.dirname(f), path.basename(f, ext) + '.jpg')
      : f;
    return sum + (fs.existsSync(outPath) ? fs.statSync(outPath).size : 0);
  }, 0);
  const totalSaving = ((1 - after / before) * 100).toFixed(1);

  console.log('\n' + '─'.repeat(70));
  console.log(`Total: ${formatBytes(before)} → ${formatBytes(after)}  (${totalSaving}% reduction)`);
  console.log('─'.repeat(70) + '\n');
}

main();
