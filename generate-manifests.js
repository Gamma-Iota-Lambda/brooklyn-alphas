#!/usr/bin/env node

/**
 * GIL Photo Manifest Generator
 * Scans the assets/ directory and generates a photos.json manifest
 * in each event subfolder listing all image filenames.
 *
 * Usage:
 *   node generate-manifests.js                        — scan all assets/ subfolders
 *   node generate-manifests.js mlk-2025               — scan one event by name
 *   node generate-manifests.js assets/chapter-life    — scan by full/relative path
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
const EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov'];
const MANIFEST = 'photos.json';
const SKIP_FOLDERS = ['originals']; // never scan backup folders

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function isMedia(filename) {
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
            if (!isMedia(f)) return false;
            const stat = fs.statSync(path.join(eventDir, f));
            return stat.isFile();
        })
        .sort(naturalSort);

    if (files.length === 0) {
        console.log(`  ⚠  ${eventName} — no media files found, skipping`);
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
    console.log(`  ✅ ${eventName.padEnd(35)} ${photos.length} media file(s) → ${MANIFEST}`);
}

function main() {
    const targetArg = process.argv[2];

    // If arg looks like a path (contains a separator or starts with . or /), use it directly
    if (targetArg) {
        const resolvedPath = path.resolve(targetArg);
        if (targetArg.includes(path.sep) || targetArg.includes('/') || targetArg.startsWith('.')) {
            if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
                console.log(`Folder not found: ${targetArg}\n`);
                process.exit(1);
            }
            const eventName = path.basename(resolvedPath);
            console.log(`\nGenerating manifest for 1 event folder...\n`);
            processEvent(resolvedPath, eventName);
            console.log('\nDone.\n');
            return;
        }
    }

    // Make sure assets/ folder exists
    if (!fs.existsSync(EVENTS_DIR)) {
        fs.mkdirSync(EVENTS_DIR);
        console.log(`Created assets/ folder — add event subfolders and photos, then re-run.\n`);
        return;
    }

    const entries = fs.readdirSync(EVENTS_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory() && !SKIP_FOLDERS.includes(e.name))
        .map(e => e.name)
        .sort(naturalSort);

    if (entries.length === 0) {
        console.log('No event subfolders found in assets/. Create folders like assets/mlk-2025/ and add photos.\n');
        return;
    }

    const targets = targetArg
        ? entries.filter(e => e === targetArg)
        : entries;

    if (targets.length === 0) {
        console.log(`No event folder named "${targetArg}" found in assets/.\n`);
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