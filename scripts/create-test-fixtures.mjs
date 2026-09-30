import { writeFile } from 'node:fs/promises';
let objects = [];
const add = s => objects.push(s);
add('<< /Type /Catalog /Pages 2 0 R >>');
add('<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>');
for(let p=0;p<2;p++) {
  const content = `BT /F1 24 Tf 65 740 Td (Suixian upload test - page ${p+1}) Tj ET\n` + Array.from({length:4},(_,r)=>Array.from({length:6},(_,s)=>`60 ${660-r*145-s*10} m 535 ${660-r*145-s*10} l S`).join('\n')).join('\n');
  add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents ${4+p*2} 0 R >>`);
  add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
}
add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
let out='%PDF-1.4\n', offsets=[0];
objects.forEach((obj,i)=>{offsets.push(Buffer.byteLength(out));out+=`${i+1} 0 obj\n${obj}\nendobj\n`;});
const start=Buffer.byteLength(out);
out+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('');
out+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
await writeFile('tests/fixtures/two-pages.pdf',out);
await writeFile('tests/fixtures/invalid.pdf','not a pdf');
console.log('Created two-page PDF and invalid-PDF test fixtures.');
