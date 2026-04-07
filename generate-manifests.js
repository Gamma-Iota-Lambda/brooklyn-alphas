#!/usr/bin/env node

/**
 * GIL Photo Manifest Generator
 * Scans the assets/ directory and generates a photos.json manifest
 * in each event subfolder listing all image filenames.
 *
 * Usage:
 *   node generate-manifests.js              — scan all events/
 *   node generate-manifests.js mlk-2025     — scan one event only
 *
 * Scans: assets/<event-name>/
 *
 * Output per event folder:
 *   assets/mlk-2025/photos.json
 *
 * JSON format:
 *   {
 *     "event": "mlk-2025",
 *     "count": 12,
 *     "photos": [
 *       { "file": "photo1.jpg", "caption": "" },
 *       { "file": "photo2.jpg", "caption": "" }
 *     ]
 *   }
 *
 * To add captions, edit the photos.json after generation
 * and fill in the "caption" fields. Re-running the script
 * will NOT overwrite existing captions — it merges them.
 */

const fs = require('fs');
const path = require('path');

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const EVENTS_DIR = path.join(__dirname, 'assets');
const EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const MANIFEST = 'photos.json';
const SKIP_FOLDERS = ['originals']; // never scan backup folders

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function isImage(filename) {
    return EXTENSIONS.includes(path.extname(filename).toLowerCase());
}

function naturalSort(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

function processEvent(eventDir, eventName) {
    const files = fs.readdirSync(eventDir)
        .filter(f => {
            if (SKIP_FOLDERS.includes(f)) return false;
            if (!isImage(f)) return false;
            const stat = fs.statSync(path.join(eventDir, f));
            return stat.isFile();
        })
        .sort(naturalSort);

    if (files.length === 0) {
        console.log(`  ⚠  ${eventName} — no images found, skipping`);
        return;
    }

    const manifestPath = path.join(eventDir, MANIFEST);

    // Load existing manifest to preserve any captions already written
    let existingCaptions = {};
    if (fs.existsSync(manifestPath)) {
        try {
            const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            existing.photos?.forEach(p => {
                if (p.caption) existingCaptions[p.file] = p.caption;
            });
        } catch {
            // Malformed JSON — start fresh
        }
    }

    const photos = files.map(file => ({
        file,
        caption: existingCaptions[file] || ''
    }));

    const manifest = {
        event: eventName,
        count: photos.length,
        photos
    };

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`  ✅ ${eventName.padEnd(35)} ${photos.length} photo(s) → ${MANIFEST}`);
}

function main() {
    const targetArg = process.argv[2];

    // Make sure events/ folder exists
    if (!fs.existsSync(EVENTS_DIR)) {
        fs.mkdirSync(EVENTS_DIR);
        console.log(`Created events/ folder — add event subfolders and photos, then re-run.\n`);
        return;
    }

    const entries = fs.readdirSync(EVENTS_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory() && !SKIP_FOLDERS.includes(e.name))
        .map(e => e.name)
        .sort(naturalSort);

    if (entries.length === 0) {
        console.log('No event subfolders found in events/. Create folders like events/mlk-2025/ and add photos.\n');
        return;
    }

    const targets = targetArg
        ? entries.filter(e => e === targetArg)
        : entries;

    if (targets.length === 0) {
        console.log(`No event folder named "${targetArg}" found in events/.\n`);
        return;
    }

    console.log(`\nGenerating manifests for ${targets.length} event folder(s)...\n`);

    targets.forEach(eventName => {
        processEvent(path.join(EVENTS_DIR, eventName), eventName);
    });

    console.log('\nDone. Carousels will now auto-load photos from these manifests.\n');
    console.log('To add captions, edit the photos.json files and fill in the "caption" fields.');
    console.log('Re-running this script will preserve any captions you have written.\n');
}

main();