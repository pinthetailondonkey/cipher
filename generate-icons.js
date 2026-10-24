import sharp from 'sharp';
import fs from 'fs';

const input = './public/logo_raw.png';

if (!fs.existsSync(input)) {
  console.log('❌ File not found at ./public/logo_raw.png');
  process.exit(1);
}

const sizes = [
  { name: 'favicon-32.png', size: 32 },
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'apple-touch-icon.png', size: 180 }
];

Promise.all(sizes.map(s => 
  sharp(input)
    .resize(s.size, s.size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toFile('./public/' + s.name)
))
.then(() => console.log('✅ All icons generated successfully!'))
.catch(e => console.error(e));
