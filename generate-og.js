// Einmalig ausführen um og-image.png zu generieren
// node generate-og.js
const { createCanvas } = require('canvas');
const fs = require('fs');

const w = 1200, h = 630;
const canvas = createCanvas(w, h);
const ctx = canvas.getContext('2d');

// Hintergrund
ctx.fillStyle = '#000000';
ctx.fillRect(0, 0, w, h);

// Matrix-Regen simuliert (statisch)
ctx.font = '14px monospace';
const chars = 'ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉ01ABCDEF'.split('');
for (let x = 0; x < w; x += 16) {
  for (let y = 0; y < h; y += 16) {
    if (Math.random() > 0.6) {
      const alpha = Math.random() * 0.3 + 0.05;
      ctx.fillStyle = `rgba(0, ${Math.floor(Math.random()*80+100)}, 0, ${alpha})`;
      ctx.fillText(chars[Math.floor(Math.random()*chars.length)], x, y);
    }
  }
}

// Zentrierter Kasten
const bx = 80, by = 100, bw = w-160, bh = h-200;
ctx.fillStyle = 'rgba(0, 15, 0, 0.85)';
ctx.strokeStyle = '#00ff41';
ctx.lineWidth = 2;
ctx.beginPath();
ctx.roundRect(bx, by, bw, bh, 8);
ctx.fill();
ctx.stroke();

// Glow effect
ctx.shadowColor = '#00ff41';
ctx.shadowBlur = 20;
ctx.stroke();
ctx.shadowBlur = 0;

// Schloss Icon
ctx.font = 'bold 72px serif';
ctx.textAlign = 'center';
ctx.fillStyle = '#00ff41';
ctx.fillText('🔒', w/2, by + 120);

// Titel
ctx.font = 'bold 56px monospace';
ctx.fillStyle = '#39ff14';
ctx.shadowColor = '#00ff41';
ctx.shadowBlur = 15;
ctx.fillText('ephemera', w/2, by + 205);
ctx.shadowBlur = 0;

// Untertitel
ctx.font = '28px monospace';
ctx.fillStyle = '#00cc44';
ctx.fillText('Privater verschlüsselter Einmal-Chat', w/2, by + 265);

// Divider
ctx.strokeStyle = '#1a3a1a';
ctx.lineWidth = 1;
ctx.beginPath();
ctx.moveTo(bx + 60, by + 295);
ctx.lineTo(bx + bw - 60, by + 295);
ctx.stroke();

// Features
ctx.font = '22px monospace';
ctx.fillStyle = '#006622';
const features = [
  '> Ende-zu-Ende-verschlüsselt mit AES-GCM-256',
  '> Kein Login · Kein Account · Keine Speicherung',
  '> Raum wird nach Ende automatisch gelöscht',
];
features.forEach((f, i) => {
  ctx.fillText(f, w/2, by + 340 + i * 42);
});

// Speichern
const buffer = canvas.toBuffer('image/png');
fs.writeFileSync('./og-image.png', buffer);
console.log('og-image.png erstellt');
