const fs = require('fs');
const zlib = require('zlib');

function createSimplePNG(size) {
  const width = size;
  const height = size;
  
  const rawData = [];
  
  for (let y = 0; y < height; y++) {
    rawData.push(0); 
    for (let x = 0; x < width; x++) {
      const centerX = width / 2;
      const centerY = height / 2;
      const distance = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2);
      const maxDistance = Math.sqrt(centerX ** 2 + centerY ** 2);
      
      let r, g, b, a = 255;
      
      if (distance < size * 0.4) {
        r = 102; g = 126; b = 234; 
      } else if (distance < size * 0.45) {
        const t = (distance - size * 0.4) / (size * 0.05);
        r = Math.round(102 + (118 - 102) * t);
        g = Math.round(126 + (75 - 126) * t);
        b = Math.round(234 + (162 - 234) * t);
      } else {
        a = 0; 
        r = g = b = 0;
      }
      
      rawData.push(r, g, b, a);
    }
  }

  const deflated = zlib.deflateSync(Buffer.from(rawData));
  
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  
  function createChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    
    const typeBuffer = Buffer.from(type, 'ascii');
    const crcData = Buffer.concat([typeBuffer, data]);
    const crc = crc32(crcData);
    
    const crcBuffer = Buffer.alloc(4);
    crcBuffer.writeUInt32BE(crc >>> 0, 0);
    
    return Buffer.concat([length, typeBuffer, data, crcBuffer]);
  }
  
  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++) {
        if (crc & 1) {
          crc = (crc >>> 1) ^ 0xEDB88320;
        } else {
          crc = crc >>> 1;
        }
      }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; 
  ihdrData[9] = 6; 
  ihdrData[10] = 0; 
  ihdrData[11] = 0; 
  ihdrData[12] = 0; 
  
  const ihdr = createChunk('IHDR', ihdrData);
  const idat = createChunk('IDAT', deflated);
  const iend = createChunk('IEND', Buffer.alloc(0));
  
  return Buffer.concat([signature, ihdr, idat, iend]);
}

if (!fs.existsSync('icons')) {
  fs.mkdirSync('icons');
}

[16, 48, 128].forEach(size => {
  const png = createSimplePNG(size);
  fs.writeFileSync(`icons/icon${size}.png`, png);
  console.log(`✓ Generated icons/icon${size}.png (${png.length} bytes)`);
});

console.log('\n🎨 Icons generated successfully!');
