import { crc32, deflateRawSync } from 'node:zlib';

// Small in-memory synthetic ZIP author; never unpacks files or embeds real documents.
export function syntheticZip(entries: { name: string; text: string | Buffer; mode?: number; claimedSize?: number; crc?: number }[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), bytes = Buffer.from(entry.text), compressed = deflateRawSync(bytes);
    const size = entry.claimedSize ?? bytes.length, checksum = entry.crc ?? crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(size, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8); record.writeUInt16LE(8, 10); record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(size, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(((entry.mode ?? 0x81a4) * 65536) >>> 0, 38); record.writeUInt32LE(offset, 42);
    central.push(record, name); offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export const minimalDocxEntries = () => [
  { name: '[Content_Types].xml', text: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
  { name: '_rels/.rels', text: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
  { name: 'word/document.xml', text: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>合成简历</w:t></w:r></w:p></w:body></w:document>' },
];

export function syntheticPdf(pages: { text?: string; columns?: boolean; image?: boolean; rows?: string[] }[], encrypted = false): Buffer {
  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>'); add('');
  const chars = [...new Set(pages.flatMap(page => [...(page.text ?? ''), ...(page.rows ?? []).flatMap(row => [...row])]))];
  const map = new Map(chars.map((char, index) => [char, index + 1]));
  const utf16 = (text: string) => { const b = Buffer.from(text, 'utf16le'); b.swap16(); return b.toString('hex'); };
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Synthetic def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chars.length} beginbfchar\n${chars.map(char => `<${map.get(char)!.toString(16).padStart(4, '0')}> <${utf16(char)}>`).join('\n')}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
  const cmapId = add(`<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`);
  const descId = add('<< /Type /FontDescriptor /FontName /Synthetic /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>');
  const cidId = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Synthetic /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descId} 0 R /DW 1000 /CIDToGIDMap /Identity >>`);
  const fontId = add(`<< /Type /Font /Subtype /Type0 /BaseFont /Synthetic /Encoding /Identity-H /DescendantFonts [${cidId} 0 R] /ToUnicode ${cmapId} 0 R >>`);
  const pageIds: number[] = [];
  for (const page of pages) {
    const hex = [...(page.text ?? '')].map(char => map.get(char)!.toString(16).padStart(4, '0')).join('');
    let stream = page.text ? `BT /F1 12 Tf 40 750 Td <${hex}> Tj ET` : '';
    if (page.columns) stream += `\nBT /F1 12 Tf 330 750 Td <${hex}> Tj ET`;
    for (const [index, row] of (page.rows ?? []).entries()) {
      const content = [...row].map(char => map.get(char)!.toString(16).padStart(4, '0')).join('');
      stream += `\nBT /F1 12 Tf 40 ${720 - index * 30} Td <${content}> Tj ET`;
    }
    let resources = `/Font << /F1 ${fontId} 0 R >>`;
    if (page.image) {
      const image = add('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nX\nendstream');
      resources += ` /XObject << /Im1 ${image} 0 R >>`; stream += '\nq 100 0 0 100 40 600 cm /Im1 Do Q';
    }
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << ${resources} >> /Contents ${content} 0 R >>`));
  }
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  const encryptId = encrypted ? add('<< /Filter /Standard /V 1 /R 2 /Length 40 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>') : 0;
  let output = '%PDF-1.7\n'; const offsets = [0];
  for (let index = 0; index < objects.length; index++) { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`; }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${encryptId ? `/Encrypt ${encryptId} 0 R /ID [<00112233445566778899aabbccddeeff><00112233445566778899aabbccddeeff>]` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
