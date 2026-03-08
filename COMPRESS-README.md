# GIL Image Compression Script

Compresses all JPG and PNG images in the repo in one command.
Originals are automatically backed up before any changes are made.

---

## One-time setup

1. Copy `compress.js` into the **root of your repo** (same level as `index.html`)

2. Open Terminal, navigate to your repo folder:
   ```
   cd path/to/your/repo
   ```

3. Install the one dependency:
   ```
   npm install sharp
   ```
   This creates a `node_modules/` folder. You only need to do this once.

4. Add `node_modules/` to your `.gitignore` if it isn't already:
   ```
   echo "node_modules/" >> .gitignore
   ```

---

## Usage

**Compress everything (headshots + root images):**
```
node compress.js
```

**Compress one folder only:**
```
node compress.js headshots/
```

---

## What it does

- Compresses every `.jpg`, `.jpeg`, and `.png` it finds
- Caps images at 1600px wide (prevents unnecessarily large files — won't enlarge small images)
- Backs up every original to an `originals/` subfolder before touching it
  - `headshots/originals/` for headshots
  - `originals/` for root-level images
- Prints a report showing before/after file size and % reduction for each file
- Shows a total reduction summary at the end

---

## Adding new photos

1. Drop new photos into the appropriate folder (`headshots/` or root)
2. Run `node compress.js`
3. Commit the compressed files — do NOT commit the `originals/` folders

---

## Notes

- The script skips re-backing-up files that are already in `originals/` — safe to run multiple times
- Add `originals/` to `.gitignore` so backup files don't end up in the repo
- Typical reduction on uncompressed photos: 40–70%
