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

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const TARGET_FOLDERS = [
  '.',          // repo root (og-image.jpg, chapter-photo1.png, etc.)
  'headshots',  // board member headshots
];

const EXTENSIONS = ['.jpg', '.jpeg', '.png'];

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

  // Back up original
  const backupDir = path.join(dir, BACKUP_FOLDER);
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, base);
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath);
  }

  const originalSize = fs.statSync(filePath).size;

  try {
    let pipeline = sharp(filePath).resize({ width: MAX_WIDTH, withoutEnlargement: true });

    if (ext === '.png') {
      pipeline = pipeline.png(SETTINGS.png);
    } else {
      pipeline = pipeline.jpeg(SETTINGS.jpg);
    }

    const compressed = await pipeline.toBuffer();
    fs.writeFileSync(filePath, compressed);

    const newSize = compressed.length;
    const saving = ((1 - newSize / originalSize) * 100).toFixed(1);
    const arrow = newSize < originalSize ? '✅' : '⚠️ ';

    console.log(
      `${arrow} ${filePath.padEnd(45)} ${formatBytes(originalSize).padStart(9)} → ${formatBytes(newSize).padStart(9)}  (${saving}% smaller)`
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

  const after = allFiles.reduce((sum, f) => sum + fs.statSync(f).size, 0);
  const totalSaving = ((1 - after / before) * 100).toFixed(1);

  console.log('\n' + '─'.repeat(70));
  console.log(`Total: ${formatBytes(before)} → ${formatBytes(after)}  (${totalSaving}% reduction)`);
  console.log('─'.repeat(70) + '\n');
}

main();
