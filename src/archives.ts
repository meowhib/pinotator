import { inflateRawSync } from 'node:zlib';

export const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
export const MAX_ARCHIVE_FILES = 100;
export const MAX_ARCHIVE_FILE_BYTES = 512 * 1024;
const MAX_UNCOMPRESSED_BYTES = 4 * 1024 * 1024;
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function validEntryPath(path) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.length > 240 ||
    path.startsWith('/') ||
    path.startsWith('\\') ||
    /^[a-zA-Z]:/.test(path) ||
    path.includes('\\') ||
    /[\0-\x1f]/.test(path)
  )
    return false;
  const parts = path.replace(/\/$/, '').split('/');
  return parts.every(
    (part) =>
      part && part !== '.' && part !== '..' && !part.startsWith('.') && !/[<>:"|?*]/.test(part),
  );
}
function privateFileName(path) {
  return /^(?:\.env(?:\..*)?|auth(?:\..*)?|credentials?(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i.test(
    path.split('/').at(-1),
  );
}
function crcBuffer(buffer, offset) {
  return buffer.readUInt32LE(offset);
}
export function inspectZip(input) {
  const zip = Buffer.from(input);
  if (zip.length < 22 || zip.length > MAX_ARCHIVE_BYTES)
    throw Object.assign(new Error('Archive size is outside the supported bounds.'), {
      code: 'ARCHIVE_LIMIT',
      status: 413,
    });
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--)
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0)
    throw Object.assign(new Error('File is not a supported ZIP archive.'), {
      code: 'ARCHIVE_INVALID',
      status: 422,
    });
  const disk = zip.readUInt16LE(eocd + 4),
    centralDisk = zip.readUInt16LE(eocd + 6),
    diskCount = zip.readUInt16LE(eocd + 8),
    count = zip.readUInt16LE(eocd + 10),
    centralSize = zip.readUInt32LE(eocd + 12),
    centralStart = zip.readUInt32LE(eocd + 16),
    commentLength = zip.readUInt16LE(eocd + 20);
  if (
    disk ||
    centralDisk ||
    diskCount !== count ||
    count > MAX_ARCHIVE_FILES ||
    centralStart + centralSize > eocd ||
    eocd + 22 + commentLength !== zip.length
  )
    throw Object.assign(new Error('Multi-disk, ZIP64, or oversized archives are unsupported.'), {
      code: 'ARCHIVE_UNSUPPORTED',
      status: 422,
    });
  const entries = [];
  const seen = new Set();
  let offset = centralStart,
    total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50)
      throw Object.assign(new Error('Archive directory is malformed.'), {
        code: 'ARCHIVE_INVALID',
        status: 422,
      });
    const madeBy = zip.readUInt16LE(offset + 4) >>> 8,
      flags = zip.readUInt16LE(offset + 8),
      method = zip.readUInt16LE(offset + 10),
      crc = crcBuffer(zip, offset + 16),
      compressedSize = zip.readUInt32LE(offset + 20),
      uncompressedSize = zip.readUInt32LE(offset + 24),
      nameLength = zip.readUInt16LE(offset + 28),
      extraLength = zip.readUInt16LE(offset + 30),
      fileCommentLength = zip.readUInt16LE(offset + 32),
      startDisk = zip.readUInt16LE(offset + 34),
      external = zip.readUInt32LE(offset + 38),
      localOffset = zip.readUInt32LE(offset + 42);
    if (
      flags & 1 ||
      ((flags & 0x800) === 0 && flags & 0x8000) ||
      ![0, 8].includes(method) ||
      startDisk !== 0 ||
      [compressedSize, uncompressedSize, localOffset].includes(0xffffffff)
    )
      throw Object.assign(
        new Error('Encrypted, split, ZIP64, or unsupported compression entries are rejected.'),
        { code: 'ARCHIVE_UNSUPPORTED', status: 422 },
      );
    const nameStart = offset + 46,
      nameEnd = nameStart + nameLength,
      next = nameEnd + extraLength + fileCommentLength;
    if (!nameLength || next > zip.length)
      throw Object.assign(new Error('Archive filename or directory is malformed.'), {
        code: 'ARCHIVE_INVALID',
        status: 422,
      });
    const path = zip.subarray(nameStart, nameEnd).toString('utf8');
    const directory = path.endsWith('/');
    if (!validEntryPath(path) || (!directory && privateFileName(path)))
      throw Object.assign(new Error(`Unsafe or private archive path: ${path.slice(0, 120)}`), {
        code: 'ARCHIVE_UNSAFE_PATH',
        status: 422,
      });
    if (seen.has(path.replace(/\/$/, '')))
      throw Object.assign(new Error('Archive contains duplicate paths.'), {
        code: 'ARCHIVE_DUPLICATE_PATH',
        status: 422,
      });
    seen.add(path.replace(/\/$/, ''));
    const unixMode = madeBy === 3 ? external >>> 16 : 0;
    const fileType = unixMode & 0xf000;
    if (fileType === 0xa000)
      throw Object.assign(new Error(`Symlink entry rejected: ${path.slice(0, 120)}`), {
        code: 'ARCHIVE_SYMLINK',
        status: 422,
      });
    if (directory) {
      offset = next;
      continue;
    }
    if (fileType && fileType !== 0x8000 && fileType !== 0)
      throw Object.assign(new Error(`Special file entry rejected: ${path.slice(0, 120)}`), {
        code: 'ARCHIVE_SPECIAL_FILE',
        status: 422,
      });
    if (
      uncompressedSize > MAX_ARCHIVE_FILE_BYTES ||
      total + uncompressedSize > MAX_UNCOMPRESSED_BYTES
    )
      throw Object.assign(new Error('Archive expands beyond safe limits.'), {
        code: 'ARCHIVE_LIMIT',
        status: 413,
      });
    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50)
      throw Object.assign(new Error('Archive local header is malformed.'), {
        code: 'ARCHIVE_INVALID',
        status: 422,
      });
    const localNameLength = zip.readUInt16LE(localOffset + 26),
      localExtraLength = zip.readUInt16LE(localOffset + 28),
      dataStart = localOffset + 30 + localNameLength + localExtraLength,
      dataEnd = dataStart + compressedSize;
    if (
      dataEnd > centralStart ||
      zip.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8') !== path
    )
      throw Object.assign(new Error('Archive local and central headers do not match.'), {
        code: 'ARCHIVE_INVALID',
        status: 422,
      });
    let data;
    try {
      const compressed = zip.subarray(dataStart, dataEnd);
      data =
        method === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, { maxOutputLength: MAX_ARCHIVE_FILE_BYTES });
    } catch {
      throw Object.assign(new Error('Archive entry could not be safely decompressed.'), {
        code: 'ARCHIVE_INVALID',
        status: 422,
      });
    }
    if (data.length !== uncompressedSize || crc32(data) !== crc)
      throw Object.assign(new Error('Archive entry failed size or checksum validation.'), {
        code: 'ARCHIVE_CHECKSUM',
        status: 422,
      });
    total += data.length;
    entries.push({
      path,
      data,
      mode: unixMode & 0o777 || 0o644,
      executable: Boolean(unixMode & 0o111),
      directory: false,
    });
    offset = next;
  }
  if (offset !== centralStart + centralSize)
    throw Object.assign(new Error('Archive directory size did not match its entries.'), {
      code: 'ARCHIVE_INVALID',
      status: 422,
    });
  return entries;
}
export function createZip(entries) {
  const local = [],
    central = [];
  let cursor = 0;
  for (const entry of entries) {
    const path = entry.path;
    const data = Buffer.from(entry.data);
    if (!validEntryPath(path) || data.length > MAX_ARCHIVE_FILE_BYTES)
      throw new Error('Unsafe ZIP output entry.');
    const name = Buffer.from(path, 'utf8');
    const crc = crc32(data);
    const mode = (0o100000 | (entry.mode & 0o777)) << 16;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE((3 << 8) | 20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(0, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(mode >>> 0, 38);
    directory.writeUInt32LE(cursor, 42);
    central.push(directory, name);
    cursor += header.length + name.length + data.length;
  }
  const centralBuffer = Buffer.concat(central),
    eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(cursor, 16);
  return Buffer.concat([...local, centralBuffer, eocd]);
}
