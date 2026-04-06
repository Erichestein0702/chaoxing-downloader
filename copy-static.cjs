const fs = require('fs');
const path = require('path');

function copyFile(src, dest) {
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.copyFileSync(src, dest);
  console.log(`✓ Copied: ${path.basename(src)} → ${dest}`);
}

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (!entry.name.endsWith('.ts')) {
      copyFile(srcPath, destPath);
    }
  }
}

console.log('\n📦 Copying static files to dist...\n');

if (fs.existsSync('src/manifest.json')) {
  copyFile('src/manifest.json', 'dist/manifest.json');
} else {
  console.log('⚠️ Warning: manifest.json not found');
}

copyDir('src/popup', 'dist/popup');
copyFile('src/content/styles.css', 'dist/content/styles.css');
copyDir('icons', 'dist/icons');

console.log('\n✅ Static files copied successfully!\n');
console.log('📁 Dist directory is ready for Chrome extension loading!\n');
